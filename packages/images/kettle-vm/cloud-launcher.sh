#!/bin/bash
set -euo pipefail

# Cloud configuration script that detects the cloud provider and fetches manifest
# This script is installed to /usr/bin/cloud-launcher in the VM

LOG_PREFIX="[cloud-launcher]"
CONFIG_DIR="/etc/kettle"
ENV_FILE="$CONFIG_DIR/cloud-launcher.env"
SERIAL_CONSOLE="/dev/ttyS0"

# Tee all output to serial console (with prefix) while preserving stdout/stderr for systemd
exec > >(tee >(sed "s/^/$LOG_PREFIX /" > "$SERIAL_CONSOLE" 2>/dev/null || true)) 2>&1

echo "Starting cloud configuration..."

# Create config directory
mkdir -p "$CONFIG_DIR"

# Detect cloud provider and run appropriate configuration script
# Try to detect based on metadata service availability
# Check local first (for QEMU/testing) to avoid false positives from cloud checks

# Check for local metadata service (QEMU/testing)
if timeout 2 curl -s -f http://10.0.2.2:8090/health > /dev/null 2>&1; then
  echo "$LOG_PREFIX Detected local metadata service (QEMU)"
  if [ -x /usr/lib/kettle/config_local ]; then
    /usr/lib/kettle/config_local
    exit 0
  else
    echo "$LOG_PREFIX Warning: config_local not found"
  fi
fi

# Check for GCP metadata service
if timeout 2 curl -s -f -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/ > /dev/null 2>&1; then
  echo "$LOG_PREFIX Detected GCP environment"
  if [ -x /usr/lib/kettle/config_gcp ]; then
    /usr/lib/kettle/config_gcp
    exit 0
  else
    echo "$LOG_PREFIX Warning: config_gcp not found"
  fi
fi

# Check for Azure metadata service
if timeout 2 curl -s -f -H "Metadata: true" http://169.254.169.254/metadata/instance?api-version=2021-02-01 > /dev/null 2>&1; then
  echo "$LOG_PREFIX Detected Azure environment"
  if [ -x /usr/lib/kettle/config_azure ]; then
    /usr/lib/kettle/config_azure
    exit 0
  else
    echo "$LOG_PREFIX Warning: config_azure not found"
  fi
fi

echo "$LOG_PREFIX No cloud metadata service detected"
echo "$LOG_PREFIX Kettle will use default manifest if available"

# Create empty env file so the service doesn't fail
touch "$ENV_FILE"
exit 0
