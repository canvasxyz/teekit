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

# Launch a single kettle instance
launch_kettle() {
    local index="$1"
    local workerd_port=$((3001 + index * 2))

    log_info "[$index] Launching kettle on port $workerd_port..."

    cd "$GRAMINE_DIR"

    # Use the static config from the gramine package
    # (measured into MRENCLAVE via Gramine manifest)
    local config_file="$GRAMINE_DIR/workerd.config.capnp"

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
