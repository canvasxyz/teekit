#!/bin/bash
set -euxo pipefail

# Install Intel Trust Authority CLI for TDX attestation (GCP version)
# This script downloads a pinned version of trustauthority-cli and installs it
# to /usr/bin for use by kettle and other services.
#
# This binary uses configfs-based TDX attestation (--tdx flag):
#   trustauthority-cli evidence --tdx --user-data '<base64>' -c config.json
#
# Note: Azure requires a separate binary with --aztdx flag, which is installed
# by the Azure profile (mkosi.profiles/azure/install-trustauthority-cli-azure.sh)
#
# Reference: https://github.com/intel/trustauthority-client-for-go

# Pin the version for reproducible builds
CLI_VERSION="v1.10.1"
CLI_SHA256="d3875adbee96268471c82dd54f012b726fa8d6eefdd8f3243c0e7650fb55ff4e"

DOWNLOAD_URL="https://github.com/intel/trustauthority-client-for-go/releases/download/${CLI_VERSION}/trustauthority-cli-${CLI_VERSION}.tar.gz"
TARBALL="/tmp/trustauthority-cli-${CLI_VERSION}.tar.gz"

echo "Installing trustauthority-cli ${CLI_VERSION}..."

# Download the tarball
echo "Downloading from ${DOWNLOAD_URL}..."
curl -sL -o "$TARBALL" "$DOWNLOAD_URL"

# Verify SHA256 checksum
echo "Verifying SHA256 checksum..."
echo "${CLI_SHA256}  ${TARBALL}" | sha256sum -c -

# Extract to a temporary directory
EXTRACT_DIR="/tmp/trustauthority-cli-extract"
mkdir -p "$EXTRACT_DIR"
# Note: Despite .tar.gz extension, the file is a plain tar archive (not gzip)
tar -xf "$TARBALL" -C "$EXTRACT_DIR"

# Find the binary - it should be in the extracted directory
CLI_BINARY=$(find "$EXTRACT_DIR" -name "trustauthority-cli" -type f | head -1)
if [ -z "$CLI_BINARY" ]; then
    echo "Error: trustauthority-cli binary not found in tarball"
    ls -laR "$EXTRACT_DIR"
    exit 1
fi

# Install to /usr/bin in the BUILDROOT
echo "Installing trustauthority-cli to ${BUILDROOT}/usr/bin/..."
install -m 755 "$CLI_BINARY" "$BUILDROOT/usr/bin/trustauthority-cli"

# Normalize timestamp for reproducibility
# Use SOURCE_DATE_EPOCH if set, otherwise use epoch 0
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
TOUCH_TIME=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || \
             date -u -r "$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || \
             echo "197001010000.00")

echo "Normalizing timestamp to ${TOUCH_TIME}..."
touch -h -t "$TOUCH_TIME" "$BUILDROOT/usr/bin/trustauthority-cli"

# Clean up
rm -rf "$TARBALL" "$EXTRACT_DIR"

# Verify installation
echo "Verifying installation..."
ls -la "$BUILDROOT/usr/bin/trustauthority-cli"

echo "trustauthority-cli ${CLI_VERSION} installed successfully (GCP, uses --tdx flag)"
