#!/usr/bin/env bash
set -euo pipefail

# Bundle the Kettle CLI into a single ESM file using esbuild.
# Output: packages/kettle/services/lib/cli.bundle.js

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root is two levels up from packages/images
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENTRY_REL="packages/kettle/services/cli.ts"
OUT_REL="packages/images/cli.bundle.js"

ENTRY_PATH="$REPO_ROOT/$ENTRY_REL"
OUT_PATH="$REPO_ROOT/$OUT_REL"

ESBUILD_BIN="$REPO_ROOT/packages/kettle/node_modules/.bin/esbuild"

if [[ ! -x "$ESBUILD_BIN" ]]; then
  echo "esbuild not found at $ESBUILD_BIN" >&2
  echo "Please run 'npm install' at repo root to install dependencies." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_PATH")"

# Ensure no stale sourcemap remains
rm -f "$OUT_PATH.map" || true

"$ESBUILD_BIN" \
  "$ENTRY_PATH" \
  --bundle \
  --platform=node \
  --format=esm \
  --banner:js="import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);" \
  --outfile="$OUT_PATH"

chmod +x "$OUT_PATH"

echo "Bundled CLI -> $OUT_REL"
