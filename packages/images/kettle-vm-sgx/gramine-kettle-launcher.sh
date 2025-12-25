#!/bin/bash
set -euo pipefail

# Kettle launcher for Gramine SGX in mkosi image
# Adapted from packages/gramine/scripts/kettle-launcher.sh

LOG_PREFIX="[gramine-kettle-launcher]"
SERIAL_CONSOLE="/dev/ttyS0"
KETTLE_BUNDLE_DIR="/opt/kettle"
KETTLE_DATA_DIR="/var/lib/kettle"
ENV_FILE="/etc/kettle/cloud-launcher.env"

# Tee output to serial console for debugging
exec > >(tee >(sed "s/^/$LOG_PREFIX /" > "$SERIAL_CONSOLE" 2>/dev/null || true)) 2>&1

echo "Starting Gramine SGX kettle launcher..."

KETTLE_PIDS=()
QUOTE_SERVICE_PORT="${QUOTE_SERVICE_PORT:-3002}"

cleanup() {
    echo "Shutting down kettles..."
    for pid in "${KETTLE_PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    echo "Shutdown complete"
}
trap cleanup EXIT INT TERM

# Generate workerd config for a kettle instance
generate_config() {
    local index="$1"
    local workerd_port=$((3001 + index * 2))
    local quote_port="$QUOTE_SERVICE_PORT"
    local storage_dir="$KETTLE_DATA_DIR/do-storage-$index"
    local config_file="$KETTLE_DATA_DIR/workerd-$index.config.capnp"

    mkdir -p "$storage_dir"

    cat > "$config_file" << EOF
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  v8Flags = ["--abort-on-uncaught-exception"],
  services = [
    (
      name = "main",
      worker = (
        modules = [
          ( name = "worker.js", esModule = embed "$KETTLE_BUNDLE_DIR/worker.js" ),
          ( name = "app.js", esModule = embed "$KETTLE_BUNDLE_DIR/app.js" ),
          ( name = "externals.js", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "hono", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "hono/cors", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "hono/ws", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "hono/cloudflare-workers", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "hono/utils/http-status", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@teekit/kettle/worker", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@teekit/tunnel", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@teekit/tunnel/samples", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@teekit/qvl", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@teekit/qvl/utils", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "cbor-x", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@noble/ciphers", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@noble/ciphers/salsa", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@noble/hashes", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@noble/hashes/sha256", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@noble/hashes/sha512", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@noble/hashes/blake2b", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@noble/hashes/crypto", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@noble/hashes/sha1", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@noble/hashes/sha2", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@noble/hashes/utils", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@noble/curves", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@noble/curves/ed25519", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
          ( name = "@scure/base", esModule = embed "$KETTLE_BUNDLE_DIR/externals.js" ),
        ],
        compatibilityDate = "2025-11-05",
        compatibilityFlags = ["nodejs_compat", "new_module_registry"],
        bindings = [
          ( name = "HONO_DO", durableObjectNamespace = "HonoDurableObject" ),
          ( name = "QUOTE_SERVICE", service = "quote" ),
          ( name = "STATIC_FILES", service = "static-files" ),
        ],
        durableObjectNamespaces = [
          ( className = "HonoDurableObject", uniqueKey = "hono-durable-object-$index", enableSql = true ),
        ],
        durableObjectStorage = (localDisk = "do-storage"),
      ),
    ),
    ( name = "quote", external = ( address = "127.0.0.1:$quote_port" ) ),
    ( name = "static-files", disk = "$KETTLE_BUNDLE_DIR/static" ),
    ( name = "do-storage", disk = ( path = "$storage_dir", writable = true ) ),
  ],
  sockets = [
    ( name = "http", address = "*:$workerd_port", http = (), service = "main" ),
  ]
);
EOF

    echo "$config_file"
}

# Launch a single kettle instance
launch_kettle() {
    local index="$1"
    local workerd_port=$((3001 + index * 2))
    local quote_port="$QUOTE_SERVICE_PORT"

    echo "[$index] Launching kettle on port $workerd_port (quote: $quote_port)..."

    local config_file
    config_file=$(generate_config "$index")
    echo "[$index] Generated config: $config_file"

    cd "$KETTLE_BUNDLE_DIR"

    gramine-sgx workerd serve \
        --experimental \
        "$config_file" \
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
