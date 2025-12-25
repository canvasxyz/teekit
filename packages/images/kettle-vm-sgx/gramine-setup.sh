#!/bin/bash
set -euo pipefail

# Pre-start script to configure the SGX environment
# Called by gramine-sgx.service as ExecStartPre

LOG_PREFIX="[gramine-setup]"
SERIAL_CONSOLE="/dev/ttyS0"

# Tee output to serial console for debugging
exec > >(tee >(sed "s/^/$LOG_PREFIX /" > "$SERIAL_CONSOLE" 2>/dev/null || true)) 2>&1

echo "Preparing SGX environment..."

# Ensure SGX device permissions
if [ -e /dev/sgx_enclave ]; then
    chmod 660 /dev/sgx_enclave
    chgrp sgx /dev/sgx_enclave
    echo "Configured /dev/sgx_enclave permissions"
fi
if [ -e /dev/sgx_provision ]; then
    chmod 660 /dev/sgx_provision
    chgrp sgx /dev/sgx_provision
    echo "Configured /dev/sgx_provision permissions"
fi

# Create data directories with correct ownership
mkdir -p /var/lib/kettle/do-storage
chown -R kettle:kettle /var/lib/kettle
echo "Created data directories"

# Wait for AESM socket (required for DCAP attestation)
echo "Waiting for AESM service..."
if ! timeout 30 bash -c 'until [ -S /var/run/aesmd/aesm.socket ]; do sleep 1; done'; then
    echo "ERROR: AESM socket not available after 30s"
    exit 1
fi

echo "SGX environment ready"
