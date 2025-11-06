#!/usr/bin/env bash
set -euo pipefail

# Example script for preparing workspace to copy into VM image
# This demonstrates the approach but would need to be integrated with mkosi.build

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$IMAGES_DIR/../.." && pwd)"

echo "Preparing workspace for VM image copy..."

# 1. Ensure dependencies are installed at repo root
echo "Installing workspace dependencies..."
cd "$REPO_ROOT"
if [ ! -d "node_modules" ]; then
  npm install
fi

# 2. Compile TypeScript for all packages
echo "Compiling TypeScript..."
npm run build

# 3. Create staging directory for workspace copy
STAGING_DIR="$IMAGES_DIR/workspace-staging"
echo "Staging workspace in $STAGING_DIR..."
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# 4. Copy workspace files (excluding unnecessary files)
echo "Copying workspace files..."
rsync -av \
  --exclude='.git' \
  --exclude='node_modules/.cache' \
  --exclude='*.tsbuildinfo' \
  --exclude='dist' \
  --exclude='test' \
  --exclude='*.test.ts' \
  --exclude='.vscode' \
  --exclude='.idea' \
  --exclude='coverage' \
  --exclude='.nyc_output' \
  "$REPO_ROOT/" "$STAGING_DIR/"

# 5. Copy node_modules (or let npm install run in VM)
# Option A: Copy node_modules (faster, but larger)
# cp -r "$REPO_ROOT/node_modules" "$STAGING_DIR/"

# Option B: Copy package files only, let npm install in VM
# (package.json and package-lock.json are already copied)

# 6. Verify workspace structure
echo "Verifying workspace structure..."
if [ ! -f "$STAGING_DIR/package.json" ]; then
  echo "Error: package.json not found in staging" >&2
  exit 1
fi

if [ ! -d "$STAGING_DIR/packages/kettle" ]; then
  echo "Error: packages/kettle not found in staging" >&2
  exit 1
fi

echo "Workspace staged successfully in $STAGING_DIR"
echo "Ready for mkosi.build to copy to VM image"
