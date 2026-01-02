#!/bin/bash
#
# Build the kettle bundle for SGX deployment
#
# This script builds the kettle JavaScript bundles and prepares them
# for running inside an SGX enclave via Gramine.
#
# Usage:
#   ./scripts/build-kettle-bundle.sh [app.ts]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KETTLE_SGX_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$(dirname "$KETTLE_SGX_DIR")")"
KETTLE_DIR="$REPO_ROOT/packages/kettle"
OUTPUT_DIR="${OUTPUT_DIR:-/opt/kettle}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Default app source
APP_SOURCE="${1:-$KETTLE_DIR/app.ts}"

log_info "Building kettle bundle..."
log_info "  App source: $APP_SOURCE"
log_info "  Output dir: $OUTPUT_DIR"

# Check if kettle package exists
if [ ! -d "$KETTLE_DIR" ]; then
    echo "Error: Kettle package not found at $KETTLE_DIR"
    exit 1
fi

# Install dependencies if needed
if [ ! -d "$KETTLE_DIR/node_modules" ]; then
    log_info "Installing kettle dependencies..."
    cd "$KETTLE_DIR"
    npm install
fi

# Build the kettle worker bundle
log_info "Building worker bundle..."
cd "$KETTLE_DIR"
npm run build:worker

# Build sgx-entrypoint (combined quote service + workerd launcher)
log_info "Building sgx-entrypoint..."
cd "$KETTLE_SGX_DIR"
make -f sgx-entrypoint.mk

# Create output directory
mkdir -p "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/static"

# Copy bundle files
log_info "Copying bundle files to $OUTPUT_DIR..."
cp "$KETTLE_DIR/dist/app.js" "$OUTPUT_DIR/"
cp "$KETTLE_DIR/dist/worker.js" "$OUTPUT_DIR/"
cp "$KETTLE_DIR/dist/externals.js" "$OUTPUT_DIR/"
cp "$KETTLE_SGX_DIR/workerd.config.capnp" "$OUTPUT_DIR/"

# Copy sgx-entrypoint
cp "$KETTLE_SGX_DIR/sgx-entrypoint" "$OUTPUT_DIR/"
chmod +x "$OUTPUT_DIR/sgx-entrypoint"

# Copy static files if they exist
if [ -d "$KETTLE_DIR/dist/static" ]; then
    cp -r "$KETTLE_DIR/dist/static/"* "$OUTPUT_DIR/static/" 2>/dev/null || true
fi

log_info "=========================================="
log_info "Kettle bundle built successfully!"
log_info "=========================================="
echo ""
echo "Bundle contents:"
ls -la "$OUTPUT_DIR"
echo ""
echo "Next steps:"
echo "  1. Build the SGX enclave: cd packages/kettle-sgx && npm run build:enclave"
echo "  2. Run the enclave: make run"
