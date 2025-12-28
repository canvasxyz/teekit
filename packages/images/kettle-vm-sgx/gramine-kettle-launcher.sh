#!/bin/bash
set -euo pipefail

# Kettle launcher for Gramine SGX in mkosi image
# Adapted from packages/gramine/scripts/kettle-launcher.sh

LOG_PREFIX="[gramine-kettle-launcher]"
SERIAL_CONSOLE="/dev/ttyS0"
KETTLE_BUNDLE_DIR="/opt/kettle"
ENV_FILE="/etc/kettle/cloud-launcher.env"

# Tee output to serial console for debugging (only if writable)
if [ -w "$SERIAL_CONSOLE" ]; then
    exec > >(tee >(sed "s/^/$LOG_PREFIX /" > "$SERIAL_CONSOLE" 2>/dev/null || true)) 2>&1
else
    echo "$LOG_PREFIX Serial console not writable at $SERIAL_CONSOLE; logging to stdout only"
fi

echo "Starting Gramine SGX kettle launcher..."

KETTLE_PIDS=()

cleanup() {
    echo "Shutting down kettles..."
    for pid in "${KETTLE_PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    echo "Shutdown complete"
}
trap cleanup EXIT INT TERM

# Launch a single kettle instance
launch_kettle() {
    local index="$1"
    local workerd_port=$((3001 + index * 2))

    echo "[$index] Launching kettle on port $workerd_port..."

    cd "$KETTLE_BUNDLE_DIR"

    # Use the static config from /opt/kettle/workerd.config.capnp
    # (measured into MRENCLAVE via Gramine manifest)
    gramine-sgx workerd serve \
        --experimental \
        "$KETTLE_BUNDLE_DIR/workerd.config.capnp" \
        --socket-addr "http=0.0.0.0:$workerd_port" \
        --verbose &

    local pid=$!
    KETTLE_PIDS+=("$pid")
    echo "[$index] Launched kettle with PID $pid"
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
