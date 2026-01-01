#!/usr/bin/env bash
set -euo pipefail

# Prepare kettle artifacts before mkosi build
# This script should be run from packages/images directory

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$IMAGES_DIR/../.." && pwd)"
KETTLE_DIR="$REPO_ROOT/packages/kettle"

echo "Preparing kettle artifacts for mkosi build..."

# 1. Ensure kettle dependencies are installed
echo "Installing kettle dependencies..."
cd "$KETTLE_DIR"
if [ ! -d "node_modules" ]; then
  npm install
fi

# 2. Compile TypeScript services
echo "Compiling kettle services..."
npx tsc --build services

# 3. Build CLI bundle
echo "Building CLI bundle..."
"$IMAGES_DIR/bundle.sh"

# 4. Build app and worker using the CLI
# The CLI expects relative paths from the kettle directory
echo "Building app and worker..."
cd "$KETTLE_DIR"
CLI_COMPILED="$KETTLE_DIR/services/lib/cli.js"
node "$CLI_COMPILED" build-app "app.ts"
node "$CLI_COMPILED" build-worker

# 5. Generate manifest
echo "Generating manifest..."
node "$CLI_COMPILED" publish-local "dist/app.js" --path "/lib/kettle/app.js"

# 6. Build sgx-entrypoint and create hardlinks to gramine files
echo "Building sgx-entrypoint binary..."
GRAMINE_SRC="$REPO_ROOT/packages/gramine"
GRAMINE_DEST="$IMAGES_DIR/gramine"
mkdir -p "$GRAMINE_DEST"

# Build sgx-entrypoint using go (must be done before mkosi build)
(
    cd "$GRAMINE_SRC"
    # Clean any previous build
    rm -f sgx-entrypoint
    # Build with reproducible flags (from sgx-entrypoint.mk)
    CGO_ENABLED=0 go build \
        -trimpath \
        -mod=readonly \
        -ldflags="-s -w -extldflags=-static" \
        -o sgx-entrypoint \
        sgx-entrypoint.go
    echo "Built sgx-entrypoint binary ($(stat -c%s sgx-entrypoint | numfmt --to=iec-i --suffix=B))"
)

# Use hardlinks to avoid file duplication (same inode, no extra disk space)
ln -f "$GRAMINE_SRC/sgx-entrypoint" "$GRAMINE_DEST/"
ln -f "$GRAMINE_SRC/sgx-entrypoint.go" "$GRAMINE_DEST/"
ln -f "$GRAMINE_SRC/sgx-entrypoint.mk" "$GRAMINE_DEST/"
ln -f "$GRAMINE_SRC/workerd.manifest.template" "$GRAMINE_DEST/"
ln -f "$GRAMINE_SRC/workerd.zst" "$GRAMINE_DEST/"

# Generate or copy deterministic enclave signing key for reproducible builds
mkdir -p "$IMAGES_DIR/kettle-vm-sgx/keys"
mkdir -p "$GRAMINE_DEST/keys"

if [ ! -f "$IMAGES_DIR/kettle-vm-sgx/keys/enclave-key.pem" ]; then
    echo "Generating deterministic enclave signing key..."
    # Generate RSA key with exponent 3 (required by Gramine)
    # This key is for development/testing only
    openssl genrsa -3 3072 > "$IMAGES_DIR/kettle-vm-sgx/keys/enclave-key.pem" 2>/dev/null
    echo "Generated enclave-key.pem (development key)"
fi

cp "$IMAGES_DIR/kettle-vm-sgx/keys/enclave-key.pem" "$GRAMINE_DEST/keys/"
echo "Copied enclave signing key to gramine/"

# 7. Copy necessary files to images directory for mkosi
echo "Copying artifacts to images directory..."
mkdir -p "$IMAGES_DIR/kettle-artifacts"
cp "$KETTLE_DIR/app.ts" "$IMAGES_DIR/kettle-artifacts/"
cp "$KETTLE_DIR/manifest.json" "$IMAGES_DIR/kettle-artifacts/"
cp "$KETTLE_DIR/dist/app.js" "$IMAGES_DIR/kettle-artifacts/"
cp "$KETTLE_DIR/dist/worker.js" "$IMAGES_DIR/kettle-artifacts/"
cp "$KETTLE_DIR/dist/externals.js" "$IMAGES_DIR/kettle-artifacts/"

# 8. Normalize artifact timestamps for reproducibility
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
TOUCH_TIME=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || \
             date -u -r "$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || \
             echo "197001010000.00")

echo "Normalizing artifact timestamps to $TOUCH_TIME..."
find "$IMAGES_DIR/kettle-artifacts" -exec touch -h -t "$TOUCH_TIME" {} \; 2>/dev/null || true
find "$IMAGES_DIR/gramine" -exec touch -h -t "$TOUCH_TIME" {} \; 2>/dev/null || true
touch -h -t "$TOUCH_TIME" "$IMAGES_DIR/cli.bundle.js" 2>/dev/null || true
# Ensure the key file also has normalized timestamp
touch -h -t "$TOUCH_TIME" "$IMAGES_DIR/gramine/keys/enclave-key.pem" 2>/dev/null || true

echo "Kettle artifacts prepared successfully!"
echo "  - CLI bundle: $IMAGES_DIR/cli.bundle.js"
echo "  - Artifacts: $IMAGES_DIR/kettle-artifacts/"
