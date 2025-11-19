#!/bin/bash
set -euo pipefail

# Kettle launcher init script that supports single or multiple manifests
# This script is installed to /usr/bin/kettle-init in the VM
# MANIFEST can be either:
# - A single base64-encoded manifest string
# - A comma-separated list of base64-encoded manifest strings

LOG_PREFIX="[kettle-init]"

echo "$LOG_PREFIX Starting kettle launcher init script..."

# Track launched kettle PIDs for monitoring
KETTLE_PIDS=()

# Function to launch a single kettle
launch_kettle() {
  local manifest_b64="$1"
  local index="$2"
  local port=$((3001 + index))
  local manifest_file="/tmp/kettle-manifest-${index}.json"
  local db_dir="/var/lib/kettle/db-${index}"

  echo "$LOG_PREFIX [$index] Launching kettle on port $port..."

  # Decode base64 manifest and save to temporary file
  if echo "$manifest_b64" | base64 -d > "$manifest_file" 2>/dev/null; then
    echo "$LOG_PREFIX [$index] Decoded manifest to $manifest_file"
    echo "$LOG_PREFIX [$index] Manifest contents:"
    cat "$manifest_file" | sed 's/^/  /'

    # Create database directory for this kettle
    mkdir -p "$db_dir"

    # Launch kettle in the background
    # Use || true to continue even if this kettle fails
    /usr/bin/kettle launch "$manifest_file" --port "$port" --db-dir "$db_dir" &
    local pid=$!
    KETTLE_PIDS+=("$pid")
    echo "$LOG_PREFIX [$index] Launched kettle with PID $pid on port $port"
  else
    echo "$LOG_PREFIX [$index] ERROR: Failed to decode manifest (invalid base64)"
    echo "$LOG_PREFIX [$index] Skipping this manifest and continuing with others..."
  fi
}

# Check if MANIFEST environment variable is set
if [ -n "${MANIFEST:-}" ]; then
  # Check if it's a comma-separated list (multiple manifests)
  if [[ "$MANIFEST" == *","* ]]; then
    echo "$LOG_PREFIX MANIFEST environment variable found (comma-separated list)"

    # Split comma-separated manifests and launch each one
    IFS=',' read -ra MANIFEST_ARRAY <<< "$MANIFEST"
    echo "$LOG_PREFIX Found ${#MANIFEST_ARRAY[@]} manifest(s) to launch"

    for i in "${!MANIFEST_ARRAY[@]}"; do
      launch_kettle "${MANIFEST_ARRAY[$i]}" "$i" || true
    done

    # Check if we successfully launched any kettles
    if [ ${#KETTLE_PIDS[@]} -eq 0 ]; then
      echo "$LOG_PREFIX ERROR: Failed to launch any kettles!"
      exit 1
    fi

    echo "$LOG_PREFIX Successfully launched ${#KETTLE_PIDS[@]} kettle(s)"
    echo "$LOG_PREFIX PIDs: ${KETTLE_PIDS[*]}"
    echo "$LOG_PREFIX Waiting for kettles to complete..."

    # Wait for all background kettles
    # Note: If any kettle fails, we continue running the others
    for pid in "${KETTLE_PIDS[@]}"; do
      wait "$pid" || echo "$LOG_PREFIX Warning: Kettle process $pid exited with non-zero status"
    done

  else
    # Single manifest (backward compatible)
    echo "$LOG_PREFIX MANIFEST environment variable found (single manifest)"

    # Create temporary file for decoded manifest
    MANIFEST_FILE="/tmp/kettle-manifest.json"

    # Decode base64 manifest and save to temporary file
    if echo "$MANIFEST" | base64 -d > "$MANIFEST_FILE" 2>/dev/null; then
      echo "$LOG_PREFIX Decoded manifest to $MANIFEST_FILE"
      echo "$LOG_PREFIX Manifest contents:"
      cat "$MANIFEST_FILE"

      # Launch kettle with the decoded manifest
      exec /usr/bin/kettle launch "$MANIFEST_FILE" --port 3001 --db-dir /var/lib/kettle/db
    else
      echo "$LOG_PREFIX ERROR: Failed to decode manifest (invalid base64)"
      exit 1
    fi
  fi

else
  echo "$LOG_PREFIX No MANIFEST environment variable found"
  echo "$LOG_PREFIX Using default manifest at /usr/lib/kettle/manifest.json"

  # Fall back to default manifest if it exists
  if [ -f "/usr/lib/kettle/manifest.json" ]; then
    exec /usr/bin/kettle launch /usr/lib/kettle/manifest.json --port 3001 --db-dir /var/lib/kettle/db
  else
    echo "$LOG_PREFIX ERROR: No manifest available!"
    echo "$LOG_PREFIX Please set MANIFEST environment variable or provide /usr/lib/kettle/manifest.json"
    exit 1
  fi
fi
