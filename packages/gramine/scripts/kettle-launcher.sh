#!/bin/bash
set -euo pipefail

# Kettle launcher for Gramine SGX
# This script starts one or more kettle instances inside the SGX enclave.
# It reads configuration from /etc/kettle/cloud-launcher.env
#
# MANIFEST can be either:
# - A single base64-encoded manifest string
# - A comma-separated list of base64-encoded manifest strings
#
# Port allocation:
#   Kettle 0: workerd=3001, quote=3002
#   Kettle 1: workerd=3003, quote=3004
#   Kettle 2: workerd=3005, quote=3006
#   ...

LOG_PREFIX="[kettle-launcher]"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GRAMINE_DIR="$(dirname "$SCRIPT_DIR")"
KETTLE_BUNDLE_DIR="${KETTLE_BUNDLE_DIR:-/opt/kettle}"
KETTLE_DATA_DIR="${KETTLE_DATA_DIR:-/var/lib/kettle}"
ENV_FILE="/etc/kettle/cloud-launcher.env"

# Mode
DIRECT_MODE=false
if [ "${1:-}" = "--direct" ]; then
    DIRECT_MODE=true
    shift
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}$LOG_PREFIX${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}$LOG_PREFIX${NC} $1"
}

log_error() {
    echo -e "${RED}$LOG_PREFIX${NC} $1"
}

# Track launched kettle PIDs
KETTLE_PIDS=()

# Cleanup function
cleanup() {
    log_info "Shutting down kettles..."
    for pid in "${KETTLE_PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    log_info "Shutdown complete"
}

trap cleanup EXIT INT TERM

# Generate workerd config for a kettle instance
generate_config() {
    local index="$1"
    local workerd_port=$((3001 + index * 2))
    local quote_port=$((3002 + index * 2))
    local storage_dir="$KETTLE_DATA_DIR/do-storage-$index"
    local static_dir="$KETTLE_BUNDLE_DIR/static"
    local config_file="$KETTLE_DATA_DIR/workerd-$index.config.capnp"

    # Create storage directory
    mkdir -p "$storage_dir"

    # Generate workerd config
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
          # Package mappings
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
    ( name = "static-files", disk = "$static_dir" ),
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
    local quote_port=$((3002 + index * 2))

    log_info "[$index] Launching kettle on port $workerd_port (quote: $quote_port)..."

    # Generate config for this instance
    local config_file
    config_file=$(generate_config "$index")
    log_info "[$index] Generated config: $config_file"

    cd "$GRAMINE_DIR"

    if [ "$DIRECT_MODE" = true ]; then
        # Run workerd in Gramine-direct mode
        gramine-direct workerd serve \
            --experimental \
            "$config_file" \
            --socket-addr "http=0.0.0.0:$workerd_port" \
            --verbose &
    else
        # Run workerd in Gramine-SGX mode
        gramine-sgx workerd serve \
            --experimental \
            "$config_file" \
            --socket-addr "http=0.0.0.0:$workerd_port" \
            --verbose &
    fi

    local pid=$!
    KETTLE_PIDS+=("$pid")
    log_info "[$index] Launched kettle with PID $pid"
}

# Main
main() {
    log_info "=========================================="
    if [ "$DIRECT_MODE" = true ]; then
        log_info "Starting Kettle Launcher (DIRECT MODE)"
    else
        log_info "Starting Kettle Launcher (SGX MODE)"
    fi
    log_info "=========================================="

    # Create data directories
    mkdir -p "$KETTLE_DATA_DIR"

    # Load environment from cloud-launcher
    if [ -f "$ENV_FILE" ]; then
        log_info "Loading configuration from $ENV_FILE"
        # shellcheck source=/dev/null
        source "$ENV_FILE"
    fi

    # Check if MANIFEST is set
    if [ -n "${MANIFEST:-}" ]; then
        # Check if it's a comma-separated list (multiple manifests)
        if [[ "$MANIFEST" == *","* ]]; then
            log_info "Multiple manifests detected"
            IFS=',' read -ra MANIFEST_ARRAY <<< "$MANIFEST"
            log_info "Found ${#MANIFEST_ARRAY[@]} manifest(s) to launch"

            for i in "${!MANIFEST_ARRAY[@]}"; do
                launch_kettle "$i" || true
            done
        else
            # Single manifest
            log_info "Single manifest detected"
            launch_kettle 0
        fi
    else
        # No manifest - launch single default kettle
        log_info "No MANIFEST found, launching default kettle"
        launch_kettle 0
    fi

    # Check if we successfully launched any kettles
    if [ ${#KETTLE_PIDS[@]} -eq 0 ]; then
        log_error "Failed to launch any kettles!"
        exit 1
    fi

    log_info "Successfully launched ${#KETTLE_PIDS[@]} kettle(s)"
    log_info "PIDs: ${KETTLE_PIDS[*]}"
    log_info "Waiting for kettles to complete..."

    # Wait for all background kettles
    for pid in "${KETTLE_PIDS[@]}"; do
        wait "$pid" || log_warn "Kettle process $pid exited with non-zero status"
    done
}

main "$@"
