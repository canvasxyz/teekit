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
node "$CLI_COMPILED" publish-local "app.ts"

# 6. Copy necessary files to images directory for mkosi
echo "Copying artifacts to images directory..."
mkdir -p "$IMAGES_DIR/kettle-artifacts"
cp "$KETTLE_DIR/app.ts" "$IMAGES_DIR/kettle-artifacts/"
cp "$KETTLE_DIR/manifest.json" "$IMAGES_DIR/kettle-artifacts/"
cp "$KETTLE_DIR/dist/app.js" "$IMAGES_DIR/kettle-artifacts/"
cp "$KETTLE_DIR/dist/worker.js" "$IMAGES_DIR/kettle-artifacts/"
cp "$KETTLE_DIR/dist/externals.js" "$IMAGES_DIR/kettle-artifacts/"

echo "Kettle artifacts prepared successfully!"
echo "  - CLI bundle: $IMAGES_DIR/cli.bundle.js"
echo "  - Artifacts: $IMAGES_DIR/kettle-artifacts/"
