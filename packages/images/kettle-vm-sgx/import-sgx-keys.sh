#!/bin/bash
set -euo pipefail

# Import GPG keys for Intel SGX and Gramine repositories
# This runs as a PrepareScript before package installation

echo "=== Importing SGX repository keys ==="

mkdir -p /usr/share/keyrings

# Intel SGX repository key
echo "Importing Intel SGX key..."
curl -fsSL https://download.01.org/intel-sgx/sgx_repo/ubuntu/intel-sgx-deb.pub | \
    gpg --dearmor -o /usr/share/keyrings/intel-sgx.gpg

# Gramine repository key
echo "Importing Gramine key..."
curl -fsSL https://packages.gramineproject.io/gramine-keyring.gpg | \
    gpg --dearmor -o /usr/share/keyrings/gramine.gpg

echo "=== Repository keys imported ==="
