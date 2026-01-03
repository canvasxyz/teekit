#!/bin/bash
set -euo pipefail

# Kettle launcher for Gramine SGX in mkosi image
# Adapted from packages/kettle-sgx/scripts/kettle-launcher.sh

LOG_PREFIX="[gramine-kettle-launcher]"
SERIAL_CONSOLE="/dev/ttyS0"
KETTLE_BUNDLE_DIR="/opt/kettle"
ENV_FILE="/etc/kettle/cloud-launcher.env"
MRENCLAVE_FILE="/opt/kettle/mrenclave.txt"
KETTLE_DATA_DIR="/var/lib/kettle"
PERSISTENT_BASE="/persistent/kettle-data"
DATABASE_ERROR_MARKER="KETTLE_DATABASE_INIT_FAILED"
STARTUP_GRACE_PERIOD=30  # seconds to monitor for the error marker before considering startup stable

# Tee output to serial console for debugging (only if writable)
if [ -w "$SERIAL_CONSOLE" ]; then
    exec > >(tee >(sed "s/^/$LOG_PREFIX /" > "$SERIAL_CONSOLE" 2>/dev/null || true)) 2>&1
else
    echo "$LOG_PREFIX Serial console not writable at $SERIAL_CONSOLE; logging to stdout only"
fi

echo "Starting Gramine SGX kettle launcher..."

KETTLE_PIDS=()

# Get the MRENCLAVE-indexed persistent directory
get_persistent_dir() {
    if [ ! -f "$MRENCLAVE_FILE" ]; then
        echo ""
        return
    fi
    local mrenclave
    mrenclave=$(cat "$MRENCLAVE_FILE" | tr -d '[:space:]')
    if [ -z "$mrenclave" ] || [ ${#mrenclave} -lt 16 ]; then
        echo ""
        return
    fi
    echo "${PERSISTENT_BASE}/${mrenclave:0:16}"
}

# Handle database corruption: check backups, create .backup.1, delete corrupted files
handle_database_corruption() {
    echo "Handling potential database corruption..."

    local persistent_dir
    persistent_dir=$(get_persistent_dir)

    if [ -z "$persistent_dir" ]; then
        echo "Cannot determine persistent directory (MRENCLAVE not available)"
        return 1
    fi

    echo "Persistent directory: $persistent_dir"

    # Find SQLite database files in the kettle data directory
    local found_corruption=false
    for db_file in "$KETTLE_DATA_DIR"/*.sqlite "$KETTLE_DATA_DIR"/*.db "$KETTLE_DATA_DIR"/*.sqlite3; do
        if [ -f "$db_file" ]; then
            local db_name
            db_name=$(basename "$db_file")
            local backup_file="$persistent_dir/${db_name}.backup"

            echo "Processing corrupted database: $db_name"

            # Check that .backup file exists (created during migration)
            if [ -f "$backup_file" ]; then
                echo "  Found backup file: $backup_file"

                # Create .backup.1 copy of the corrupted file before deletion
                local backup1_file="$persistent_dir/${db_name}.backup.1"
                if cp -a "$db_file" "$backup1_file" 2>/dev/null; then
                    echo "  Created backup.1: $backup1_file"
                else
                    echo "  Warning: Failed to create backup.1 (continuing anyway)"
                fi
            else
                echo "  Warning: No .backup file found at $backup_file"
            fi

            # Delete the corrupted database file
            if rm -f "$db_file" 2>/dev/null; then
                echo "  Deleted corrupted file: $db_file"
            else
                echo "  Warning: Failed to delete corrupted file: $db_file"
            fi

            # Also delete from persistent storage to prevent re-restore
            local persistent_file="$persistent_dir/$db_name"
            if [ -f "$persistent_file" ]; then
                if rm -f "$persistent_file" 2>/dev/null; then
                    echo "  Deleted from persistent storage: $persistent_file"
                fi
            fi

            found_corruption=true
        fi
    done

    # Also check for any files in the kettle data directory that might be corrupted
    if [ -d "$KETTLE_DATA_DIR" ] && [ -n "$(ls -A "$KETTLE_DATA_DIR" 2>/dev/null)" ]; then
        echo "Clearing remaining files in $KETTLE_DATA_DIR..."
        for file in "$KETTLE_DATA_DIR"/*; do
            if [ -f "$file" ]; then
                local filename
                filename=$(basename "$file")
                local backup_file="$persistent_dir/${filename}.backup"

                # Check for backup and create .backup.1
                if [ -f "$backup_file" ]; then
                    local backup1_file="$persistent_dir/${filename}.backup.1"
                    cp -a "$file" "$backup1_file" 2>/dev/null || true
                    echo "  Created backup.1 for: $filename"
                fi

                rm -f "$file" 2>/dev/null || true
                echo "  Deleted: $filename"
                found_corruption=true
            fi
        done
    fi

    if [ "$found_corruption" = true ]; then
        echo "Database corruption handled. Will start with fresh database."
        return 0
    else
        echo "No database files found to clean up."
        return 1
    fi
}

cleanup() {
    echo "Shutting down kettles..."
    for pid in "${KETTLE_PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    echo "Shutdown complete"
}
trap cleanup EXIT INT TERM

# Launch a single kettle instance with corruption recovery
launch_kettle() {
    local index="$1"
    local max_retries=2
    local retry=0
    local output_file="/tmp/kettle-output-${index}.log"

    while [ $retry -lt $max_retries ]; do
        echo "[$index] Launching kettle inside SGX enclave (attempt $((retry + 1))/$max_retries)..."

        cd "$KETTLE_BUNDLE_DIR"

        # Clear the output file
        : > "$output_file"

        # Launch Gramine SGX with the workerd manifest
        # Capture output to detect the specific database error marker
        # The manifest defines:
        # - libos.entrypoint = /opt/kettle/sgx-entrypoint (Go binary: quote service + workerd launcher)
        # - loader.argv = arguments for workerd (serve, config, etc.)
        # - All files are measured into MRENCLAVE for attestation
        # Quote service will run on port 3333 inside the enclave
        # Workerd will run on port 3001 (configured in workerd.config.capnp)
        gramine-sgx workerd 2>&1 | tee "$output_file" &
        local tee_pid=$!
        # In a pipeline "cmd1 | cmd2 &", $! gives PID of the last command (tee).
        # gramine-sgx runs as a sibling process in the pipeline. We need to find
        # and track it separately to avoid orphaning it when we kill tee.
        sleep 0.5
        local gramine_pid
        gramine_pid=$(pgrep -P $$ -n gramine-sgx 2>/dev/null || echo "")

        echo "[$index] Launched kettle (tee PID: $tee_pid, gramine PID: ${gramine_pid:-unknown})"
        echo "[$index] Quote service on 3333, workerd on 3001"

        # Monitor for database error marker or process exit
        local start_time=$SECONDS
        local detected_error=false
        local process_exited=false

        while [ $((SECONDS - start_time)) -lt $STARTUP_GRACE_PERIOD ]; do
            # Check if process exited
            if ! kill -0 "$tee_pid" 2>/dev/null; then
                wait "$tee_pid" 2>/dev/null || true
                local elapsed=$((SECONDS - start_time))
                echo "[$index] Kettle process exited after ${elapsed}s"
                process_exited=true
                break
            fi

            # Check for the specific database error marker in output
            if grep -q "$DATABASE_ERROR_MARKER" "$output_file" 2>/dev/null; then
                echo "[$index] Detected database initialization failure marker"
                detected_error=true
                # Kill both processes to avoid orphans
                kill "$tee_pid" 2>/dev/null || true
                [ -n "$gramine_pid" ] && kill "$gramine_pid" 2>/dev/null || true
                wait "$tee_pid" 2>/dev/null || true
                [ -n "$gramine_pid" ] && wait "$gramine_pid" 2>/dev/null || true
                break
            fi

            sleep 1
        done

        if [ "$detected_error" = true ]; then
            # Database corruption was explicitly detected via the error marker
            echo "[$index] Kettle failed to start (database corruption detected)"

            if [ $retry -lt $((max_retries - 1)) ]; then
                # Try to handle corruption and retry
                if handle_database_corruption; then
                    echo "[$index] Retrying after corruption cleanup..."
                    retry=$((retry + 1))
                    continue
                else
                    echo "[$index] Corruption handling failed, not retrying"
                    rm -f "$output_file"
                    return 1
                fi
            else
                echo "[$index] Max retries reached, giving up"
                rm -f "$output_file"
                return 1
            fi
        elif [ "$process_exited" = true ]; then
            # Process exited early but without the database error marker
            # This could be a config error, OOM, or other non-corruption issue
            # Check output for the marker one last time before giving up
            if grep -q "$DATABASE_ERROR_MARKER" "$output_file" 2>/dev/null; then
                echo "[$index] Found database error marker in output after exit"
                detected_error=true
                # Loop will continue and hit the corruption handling above
                continue
            fi
            echo "[$index] Kettle exited early (not database corruption)"
            echo "[$index] Check logs for details. Not attempting corruption recovery."
            rm -f "$output_file"
            return 1
        else
            # Process is still running after grace period without errors, consider it successful
            KETTLE_PIDS+=("$tee_pid")
            [ -n "$gramine_pid" ] && KETTLE_PIDS+=("$gramine_pid")
            echo "[$index] Kettle startup successful (no errors detected)"
            rm -f "$output_file"
            return 0
        fi
    done

    rm -f "$output_file"
    return 1
}

# Load environment from cloud-launcher
if [ -f "$ENV_FILE" ]; then
    echo "Loading configuration from $ENV_FILE"
    source "$ENV_FILE"
fi

# Launch kettle(s) based on MANIFEST
if [ -n "${MANIFEST:-}" ]; then
    if [[ "$MANIFEST" == *","* ]]; then
        echo "Multiple manifests detected"
        IFS=',' read -ra MANIFEST_ARRAY <<< "$MANIFEST"
        echo "Found ${#MANIFEST_ARRAY[@]} manifest(s) to launch"
        for i in "${!MANIFEST_ARRAY[@]}"; do
            launch_kettle "$i" || true
        done
    else
        echo "Single manifest detected"
        launch_kettle 0
    fi
else
    echo "No MANIFEST found, launching default kettle"
    launch_kettle 0
fi

if [ ${#KETTLE_PIDS[@]} -eq 0 ]; then
    echo "ERROR: Failed to launch any kettles!"
    exit 1
fi

echo "Successfully launched ${#KETTLE_PIDS[@]} kettle(s)"
echo "PIDs: ${KETTLE_PIDS[*]}"
echo "Waiting for kettles to complete..."

for pid in "${KETTLE_PIDS[@]}"; do
    wait "$pid" || echo "Warning: Kettle $pid exited with non-zero status"
done
