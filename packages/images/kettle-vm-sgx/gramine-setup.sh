#!/bin/bash
set -euo pipefail

# Pre-start script to configure the SGX environment
# Called by gramine-sgx.service as ExecStartPre

LOG_PREFIX="[gramine-setup]"
SERIAL_CONSOLE="/dev/ttyS0"

# Tee output to serial console for debugging (only if writable)
if [ -w "$SERIAL_CONSOLE" ]; then
    exec > >(tee >(sed "s/^/$LOG_PREFIX /" > "$SERIAL_CONSOLE" 2>/dev/null || true)) 2>&1
else
    echo "$LOG_PREFIX Serial console not writable at $SERIAL_CONSOLE; logging to stdout only"
fi

echo "Preparing SGX environment..."

# Ensure SGX device permissions
# /dev/sgx_enclave needs world read/write (0666) for enclave loading
# /dev/sgx_provision requires group sgx_prv for DCAP attestation
echo "Configuring SGX device permissions..."
if [ -e /dev/sgx_enclave ]; then
    chmod 666 /dev/sgx_enclave
    echo "Configured /dev/sgx_enclave (mode: 0666)"
fi
if [ -e /dev/sgx_provision ]; then
    chmod 666 /dev/sgx_provision
    chgrp sgx_prv /dev/sgx_provision
    echo "Configured /dev/sgx_provision (group: sgx_prv, mode: 0666)"
fi

# Ensure kettle user is in sgx_prv group for DCAP attestation
# This is required for access to /dev/sgx_provision
if getent passwd kettle > /dev/null 2>&1; then
    if ! id -nG kettle | grep -qw sgx_prv; then
        usermod -a -G sgx_prv kettle
        echo "Added kettle user to sgx_prv group"
    else
        echo "kettle user already in sgx_prv group"
    fi
else
    echo "WARNING: kettle user not found, skipping sgx_prv group assignment"
fi

# Create ID enclave symlinks for AESM
# Required for DCAP attestation on some platforms (e.g., Debian)
echo "Creating ID enclave symlinks for AESM..."
AESM_DIR="/opt/intel/sgx-aesm-service/aesm"
ID_ENCLAVE_LIB="/usr/lib/x86_64-linux-gnu/libsgx_id_enclave.signed.so.1"
if [ ! -d "$AESM_DIR" ]; then
    echo "WARNING: AESM directory not found at $AESM_DIR"
elif [ ! -f "$ID_ENCLAVE_LIB" ]; then
    echo "WARNING: ID enclave not found at $ID_ENCLAVE_LIB"
else
    ln -sf "$ID_ENCLAVE_LIB" "$AESM_DIR/libsgx_id_enclave.signed.so.1"
    echo "ID enclave symlinks created"
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
