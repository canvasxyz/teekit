#!/bin/bash
set -euxo pipefail

# Install snpguest CLI for AMD SEV-SNP attestation
# This script downloads a pinned version of snpguest and installs it
# to /usr/bin for use by kettle and other services.
#
# snpguest is a CLI tool for interacting with AMD SEV-SNP guest environment.
# It provides attestation report generation, certificate fetching, and more.
#
# Usage examples:
#   snpguest report attestation-report.bin request-data.txt --random
#   snpguest fetch ca pek ark vcek --certs-dir ./certs --endorser vcek
#   snpguest verify certs ./certs
#   snpguest verify attestation ./certs attestation-report.bin
#
# Reference: https://github.com/virtee/snpguest

# Pin the version for reproducible builds
SNPGUEST_VERSION="v0.10.0"
SNPGUEST_SHA256="70e700465e3523e67dd5104583dc36cd11eef630c6f04c5b9ccafd6ba2e76ca0"

DOWNLOAD_URL="https://github.com/virtee/snpguest/releases/download/${SNPGUEST_VERSION}/snpguest"
BINARY_PATH="/tmp/snpguest-${SNPGUEST_VERSION}"

echo "Installing snpguest ${SNPGUEST_VERSION}..."

# Download the binary
echo "Downloading from ${DOWNLOAD_URL}..."
curl -sL -o "$BINARY_PATH" "$DOWNLOAD_URL"

# Verify SHA256 checksum
echo "Verifying SHA256 checksum..."
echo "${SNPGUEST_SHA256}  ${BINARY_PATH}" | sha256sum -c -

# Install to /usr/bin in the BUILDROOT
echo "Installing snpguest to ${BUILDROOT}/usr/bin/..."
install -m 755 "$BINARY_PATH" "$BUILDROOT/usr/bin/snpguest"

# Normalize timestamp for reproducibility
# Use SOURCE_DATE_EPOCH if set, otherwise use epoch 0
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
TOUCH_TIME=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || \
             date -u -r "$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || \
             echo "197001010000.00")

echo "Normalizing timestamp to ${TOUCH_TIME}..."
touch -h -t "$TOUCH_TIME" "$BUILDROOT/usr/bin/snpguest"

# Clean up
rm -f "$BINARY_PATH"

# Verify installation
echo "Verifying installation..."
ls -la "$BUILDROOT/usr/bin/snpguest"

echo "snpguest ${SNPGUEST_VERSION} installed successfully"
