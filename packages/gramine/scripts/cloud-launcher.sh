#!/bin/bash
set -euo pipefail

# Cloud configuration script that detects the cloud provider and fetches manifest
# This script runs OUTSIDE the SGX enclave on the host system.
# It writes configuration to /etc/kettle/cloud-launcher.env which is read by
# the enclave startup script.

LOG_PREFIX="[cloud-launcher]"
CONFIG_DIR="/etc/kettle"
ENV_FILE="$CONFIG_DIR/cloud-launcher.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "$LOG_PREFIX Starting cloud configuration..."

# Create config directory
mkdir -p "$CONFIG_DIR"

# Detect cloud provider and run appropriate configuration script
# Try to detect based on metadata service availability
# Check local first (for testing) to avoid false positives from cloud checks

# Check for local metadata service (testing/development)
if timeout 2 curl -s -f http://10.0.2.2:8090/health > /dev/null 2>&1; then
  echo "$LOG_PREFIX Detected local metadata service (QEMU/testing)"
  if [ -x "$SCRIPT_DIR/config_local" ]; then
    "$SCRIPT_DIR/config_local"
    exit 0
  else
    echo "$LOG_PREFIX Warning: config_local not found"
  fi
fi

# Check for GCP metadata service
if timeout 2 curl -s -f -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/ > /dev/null 2>&1; then
  echo "$LOG_PREFIX Detected GCP environment"
  if [ -x "$SCRIPT_DIR/config_gcp" ]; then
    "$SCRIPT_DIR/config_gcp"
    exit 0
  else
    echo "$LOG_PREFIX Warning: config_gcp not found"
  fi
fi

# Check for Azure metadata service
if timeout 2 curl -s -f -H "Metadata: true" "http://169.254.169.254/metadata/instance?api-version=2021-02-01" > /dev/null 2>&1; then
  echo "$LOG_PREFIX Detected Azure environment"
  if [ -x "$SCRIPT_DIR/config_azure" ]; then
    "$SCRIPT_DIR/config_azure"
    exit 0
  else
    echo "$LOG_PREFIX Warning: config_azure not found"
  fi
fi

echo "$LOG_PREFIX No cloud metadata service detected"
echo "$LOG_PREFIX Kettle will use default manifest if available"

# Create empty env file so the enclave startup doesn't fail
touch "$ENV_FILE"
exit 0
