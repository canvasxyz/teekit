#!/bin/bash
set -euxo pipefail

# Install Azure-specific Intel Trust Authority CLI for TDX attestation
# This script overwrites the base trustauthority-cli with the Azure version.
#
# Azure TDX requires a separate binary because it uses vTPM-based attestation
# instead of the configfs-based approach used by GCP TDX.
#
# Usage: trustauthority-cli quote --aztdx --user-data '<base64>'
#
# Reference: https://github.com/intel/trustauthority-client-for-go

# Pin the Azure-specific version for reproducible builds
CLI_VERSION="v1.6.1"
CLI_SHA256="087a41d0a69f49ea502b0184ef193bdef657bb7c09fb8f3af6e7192e37e5c8ca"

DOWNLOAD_URL="https://github.com/intel/trustauthority-client-for-go/releases/download/${CLI_VERSION}/trustauthority-cli-azure-${CLI_VERSION}.tar.gz"
TARBALL="/tmp/trustauthority-cli-azure-${CLI_VERSION}.tar.gz"

echo "Installing Azure-specific trustauthority-cli ${CLI_VERSION}..."

# Download the tarball
echo "Downloading from ${DOWNLOAD_URL}..."
curl -sL -o "$TARBALL" "$DOWNLOAD_URL"

# Verify SHA256 checksum
echo "Verifying SHA256 checksum..."
echo "${CLI_SHA256}  ${TARBALL}" | sha256sum -c -

# Extract to a temporary directory
EXTRACT_DIR="/tmp/trustauthority-cli-azure-extract"
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

# Install to /usr/bin in the BUILDROOT, overwriting the base version
echo "Installing Azure trustauthority-cli to ${BUILDROOT}/usr/bin/ (overwriting base version)..."
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

echo "Azure trustauthority-cli ${CLI_VERSION} installed successfully"
