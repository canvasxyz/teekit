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
GRAMINE_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$(dirname "$GRAMINE_DIR")")"
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

# Create output directory
mkdir -p "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/static"

# Copy bundle files
log_info "Copying bundle files to $OUTPUT_DIR..."
cp "$KETTLE_DIR/dist/app.js" "$OUTPUT_DIR/"
cp "$KETTLE_DIR/dist/worker.js" "$OUTPUT_DIR/"
cp "$KETTLE_DIR/dist/externals.js" "$OUTPUT_DIR/"

# Copy static files if they exist
if [ -d "$KETTLE_DIR/dist/static" ]; then
    cp -r "$KETTLE_DIR/dist/static/"* "$OUTPUT_DIR/static/" 2>/dev/null || true
fi

# Generate workerd config for SGX
# Uses Durable Objects SQLite for database (single-process, SGX-compatible)
log_info "Generating workerd configuration..."
cat > "$OUTPUT_DIR/workerd.config.capnp" << 'EOF'
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  v8Flags = ["--abort-on-uncaught-exception"],
  services = [
    (
      name = "main",
      worker = (
        modules = [
          ( name = "worker.js", esModule = embed "worker.js" ),
          ( name = "app.js", esModule = embed "app.js" ),
          ( name = "externals.js", esModule = embed "externals.js" ),
          # Package mappings
          ( name = "hono", esModule = embed "externals.js" ),
          ( name = "hono/cors", esModule = embed "externals.js" ),
          ( name = "hono/ws", esModule = embed "externals.js" ),
          ( name = "hono/cloudflare-workers", esModule = embed "externals.js" ),
          ( name = "hono/utils/http-status", esModule = embed "externals.js" ),
          ( name = "@teekit/kettle/worker", esModule = embed "externals.js" ),
          ( name = "@teekit/tunnel", esModule = embed "externals.js" ),
          ( name = "@teekit/tunnel/samples", esModule = embed "externals.js" ),
          ( name = "@teekit/qvl", esModule = embed "externals.js" ),
          ( name = "@teekit/qvl/utils", esModule = embed "externals.js" ),
          ( name = "cbor-x", esModule = embed "externals.js" ),
          ( name = "@noble/ciphers", esModule = embed "externals.js" ),
          ( name = "@noble/ciphers/salsa", esModule = embed "externals.js" ),
          ( name = "@noble/hashes", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/sha256", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/sha512", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/blake2b", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/crypto", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/sha1", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/sha2", esModule = embed "externals.js" ),
          ( name = "@noble/hashes/utils", esModule = embed "externals.js" ),
          ( name = "@noble/curves", esModule = embed "externals.js" ),
          ( name = "@noble/curves/ed25519", esModule = embed "externals.js" ),
          ( name = "@scure/base", esModule = embed "externals.js" ),
        ],
        compatibilityDate = "2025-11-05",
        compatibilityFlags = ["nodejs_compat", "new_module_registry"],

        bindings = [
          # Durable Objects (with built-in SQLite storage)
          ( name = "HONO_DO", durableObjectNamespace = "HonoDurableObject" ),
          # Quote service (SGX attestation)
          ( name = "QUOTE_SERVICE", service = "quote" ),
          # Static files
          ( name = "STATIC_FILES", service = "static-files" ),
        ],
        durableObjectNamespaces = [
          ( className = "HonoDurableObject", uniqueKey = "hono-durable-object", enableSql = true ),
        ],
        durableObjectStorage = (localDisk = "do-storage"),
      ),
    ),
    # SGX quote service
    ( name = "quote", external = ( address = "127.0.0.1:3002" ) ),
    # Static files
    ( name = "static-files", disk = "/opt/kettle/static" ),
    # DO SQLite storage (writable)
    ( name = "do-storage", disk = ( path = "/var/lib/kettle/do-storage", writable = true ) ),
  ],

  sockets = [
    ( name = "http", address = "*:3001", http = (), service = "main" ),
  ]
);
EOF

log_info "=========================================="
log_info "Kettle bundle built successfully!"
log_info "=========================================="
echo ""
echo "Bundle contents:"
ls -la "$OUTPUT_DIR"
echo ""
echo "Next steps:"
echo "  1. Build the SGX enclave: cd packages/gramine && make"
echo "  2. Run the enclave: make run"
