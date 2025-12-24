#!/bin/bash
#
# Start Kettle in SGX mode
#
# This script starts workerd (Cloudflare's JavaScript runtime) in an SGX enclave:
# - Uses Durable Objects SQLite for in-memory database storage
# - Runs inside the enclave via Gramine
# - Provides SGX attestation via the quote service
#
# Usage:
#   ./scripts/start-kettle-sgx.sh [--direct]
#
# Options:
#   --direct    Run in direct mode (no SGX, for testing)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GRAMINE_DIR="$(dirname "$SCRIPT_DIR")"
KETTLE_BUNDLE_DIR="${KETTLE_BUNDLE_DIR:-/opt/kettle}"
KETTLE_DATA_DIR="${KETTLE_DATA_DIR:-/var/lib/kettle}"
DEFAULT_SGX_KEY="/opt/kettle/enclave-key.pem"
WORKERD_BIN="$GRAMINE_DIR/workerd"
WORKERD_ZST="$GRAMINE_DIR/workerd.zst"

# Mode
DIRECT_MODE=false
if [ "${1:-}" = "--direct" ]; then
    DIRECT_MODE=true
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

cleanup() {
    log_info "Shutting down..."
    log_info "Shutdown complete"
}

trap cleanup EXIT INT TERM

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check for make
    if ! command -v make &> /dev/null; then
        log_error "make not found. Install with: apt install build-essential"
        exit 1
    fi

    # Check for Gramine (if not in direct mode)
    if [ "$DIRECT_MODE" = false ]; then
        if ! command -v gramine-sgx &> /dev/null; then
            log_error "Gramine not found. Install with: apt install gramine"
            exit 1
        fi
    else
        if ! command -v gramine-direct &> /dev/null; then
            log_error "Gramine not found. Install with: apt install gramine"
            exit 1
        fi
    fi

    # Check for bundle files
    if [ ! -f "$KETTLE_BUNDLE_DIR/app.js" ]; then
        log_error "Kettle bundle not found at $KETTLE_BUNDLE_DIR"
        log_error "Run: ./scripts/build-kettle-bundle.sh"
        exit 1
    fi

    # Check for workerd binary or compressed archive
    if [ ! -f "$WORKERD_BIN" ]; then
        if [ -f "$WORKERD_ZST" ]; then
            if ! command -v zstd &> /dev/null; then
                log_error "zstd not found. Install with: apt install zstd"
                exit 1
            fi
            log_warn "workerd binary not found; it will be decompressed from workerd.zst"
        else
            log_error "workerd.zst not found in $GRAMINE_DIR"
            log_error "Ensure the compressed workerd binary is present in the repo"
            exit 1
        fi
    fi
}

# Start workerd in SGX enclave
start_workerd_sgx() {
    log_info "Starting workerd in SGX enclave (via Makefile)..."
    export KETTLE_BUNDLE_DIR KETTLE_DATA_DIR
    if [ -z "${SGX_SIGN_KEY:-}" ] && [ -f "$DEFAULT_SGX_KEY" ] && [ ! -f "$GRAMINE_DIR/enclave-key.pem" ]; then
        SGX_SIGN_KEY="$DEFAULT_SGX_KEY"
    fi
    if [ -n "${SGX_SIGN_KEY:-}" ]; then
        export SGX_SIGN_KEY
    fi
    (cd "$GRAMINE_DIR" && make SGX=1 run)
}

# Start workerd in direct mode (no SGX)
start_workerd_direct() {
    log_info "Starting workerd in direct mode (via Makefile)..."
    export KETTLE_BUNDLE_DIR KETTLE_DATA_DIR
    (cd "$GRAMINE_DIR" && make SGX=0 direct-run)
}

# Main
main() {
    log_info "=========================================="
    if [ "$DIRECT_MODE" = true ]; then
        log_info "Starting Kettle (DIRECT MODE - no SGX)"
    else
        log_info "Starting Kettle in SGX enclave"
    fi
    log_info "=========================================="
    echo ""
    log_info "Configuration:"
    log_info "  Bundle dir:   $KETTLE_BUNDLE_DIR"
    log_info "  Data dir:     $KETTLE_DATA_DIR"
    log_info "  Storage:      Durable Objects SQLite (in-memory)"
    echo ""

    check_prerequisites

    # Create data directories for persistent files and DO SQLite storage
    mkdir -p "$KETTLE_DATA_DIR"
    mkdir -p "$KETTLE_DATA_DIR/sealed"
    mkdir -p "$KETTLE_DATA_DIR/do-storage"

    echo ""
    log_info "=========================================="
    log_info "Kettle is starting..."
    log_info "  HTTP: http://localhost:3001"
    log_info "=========================================="
    echo ""

    if [ "$DIRECT_MODE" = true ]; then
        start_workerd_direct
    else
        start_workerd_sgx
    fi
}

main "$@"
