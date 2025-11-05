#!/bin/bash
set -e

MANIFEST_PATH="/etc/kettle/manifest.json"
FALLBACK_MANIFEST="/etc/kettle/manifest.example.json"

echo "Fetching kettle manifest..."

# Try Azure metadata service
if curl -H "Metadata:true" --connect-timeout 5 --max-time 10 \
    "http://169.254.169.254/metadata/instance/compute/userData?api-version=2021-01-01&format=text" \
    -o "$MANIFEST_PATH" 2>/dev/null; then
    echo "Fetched manifest from Azure metadata service"
    exit 0
fi

# Try GCP metadata service
if curl -H "Metadata-Flavor: Google" --connect-timeout 5 --max-time 10 \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/kettle-manifest" \
    -o "$MANIFEST_PATH" 2>/dev/null; then
    echo "Fetched manifest from GCP metadata service"
    exit 0
fi

# Try AWS metadata service
if curl --connect-timeout 5 --max-time 10 \
    "http://169.254.169.254/latest/user-data" \
    -o "$MANIFEST_PATH" 2>/dev/null; then
    echo "Fetched manifest from AWS metadata service"
    exit 0
fi

# Fallback to example manifest
echo "No metadata service available, using example manifest"
if [ -f "$FALLBACK_MANIFEST" ]; then
    cp "$FALLBACK_MANIFEST" "$MANIFEST_PATH"
else
    echo "Error: No manifest available"
    exit 1
fi
