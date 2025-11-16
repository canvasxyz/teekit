#!/bin/bash
set -euo pipefail

# Kettle launcher init script that supports manifest from environment variable
# This script is installed to /usr/bin/kettle-init in the VM

LOG_PREFIX="[kettle-init]"

echo "$LOG_PREFIX Starting kettle launcher init script..."

# Check if MANIFEST environment variable is set
if [ -n "${MANIFEST:-}" ]; then
  echo "$LOG_PREFIX MANIFEST environment variable found, decoding base64..."

  # Create temporary file for decoded manifest
  MANIFEST_FILE="/tmp/kettle-manifest.json"

  # Decode base64 manifest and save to temporary file
  echo "$MANIFEST" | base64 -d > "$MANIFEST_FILE"

  echo "$LOG_PREFIX Decoded manifest to $MANIFEST_FILE"
  echo "$LOG_PREFIX Manifest contents:"
  cat "$MANIFEST_FILE"

  # Launch kettle with the decoded manifest
  exec /usr/bin/kettle launch "$MANIFEST_FILE" --port 3001 --db-dir /var/lib/kettle/db
else
  echo "$LOG_PREFIX No MANIFEST environment variable found"
  echo "$LOG_PREFIX Using default manifest at /usr/lib/kettle/manifest.json"

  # Fall back to default manifest if it exists
  if [ -f "/usr/lib/kettle/manifest.json" ]; then
    exec /usr/bin/kettle launch /usr/lib/kettle/manifest.json --port 3001 --db-dir /var/lib/kettle/db
  else
    echo "$LOG_PREFIX ERROR: No manifest available!"
    echo "$LOG_PREFIX Please set MANIFEST environment variable or provide /usr/lib/kettle/manifest.json"
    exit 1
  fi
fi
