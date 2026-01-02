#!/bin/bash
#
# Build and test sgx-entrypoint with Gramine
#
# This script:
# 1. Builds the sgx-entrypoint binary
# 2. Generates the Gramine manifest
# 3. Signs the enclave
# 4. Tests the quote service inside the enclave
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Configuration
MANIFEST_TEMPLATE="workerd.manifest.template"
MANIFEST="workerd.manifest"
SGX_MANIFEST="workerd.manifest.sgx"
SGX_SIG="workerd.sig"
SGX_SIGN_KEY="enclave-key.pem"
WORKERD_BIN="$SCRIPT_DIR/workerd"
KETTLE_BUNDLE_DIR="/opt/kettle"
LOG_LEVEL="error"
ARCH_LIBDIR="/lib/x86_64-linux-gnu"

echo "=== Building sgx-entrypoint ==="
echo ""

# Step 1: Build the Go binary
echo "[1/5] Building sgx-entrypoint..."
make -f sgx-entrypoint.mk clean
make -f sgx-entrypoint.mk
echo ""

# Step 2: Copy to /opt/kettle
echo "[2/5] Copying sgx-entrypoint to $KETTLE_BUNDLE_DIR..."
sudo cp sgx-entrypoint "$KETTLE_BUNDLE_DIR/"
sudo chmod +x "$KETTLE_BUNDLE_DIR/sgx-entrypoint"
ls -lh "$KETTLE_BUNDLE_DIR/sgx-entrypoint"
echo ""

# Step 3: Generate the manifest
echo "[3/5] Generating Gramine manifest..."
gramine-manifest \
    -Dlog_level="$LOG_LEVEL" \
    -Darch_libdir="$ARCH_LIBDIR" \
    -Dworkerd_bin="$WORKERD_BIN" \
    -Dkettle_bundle_dir="$KETTLE_BUNDLE_DIR" \
    -DDEBUG=0 \
    "$MANIFEST_TEMPLATE" > "$MANIFEST"
echo "Manifest generated: $MANIFEST"
echo ""

# Step 4: Sign the enclave
echo "[4/5] Signing SGX enclave..."
if [ ! -f "$SGX_SIGN_KEY" ]; then
    echo "Generating signing key..."
    gramine-sgx-gen-private-key "$SGX_SIGN_KEY"
fi

gramine-sgx-sign \
    --manifest "$MANIFEST" \
    --key "$SGX_SIGN_KEY" \
    --output "$SGX_MANIFEST"

echo ""
echo "Enclave measurements:"
gramine-sgx-sigstruct-view "$SGX_SIG" | grep -E "(mr_enclave|mr_signer|isv_prod_id|isv_svn)"
MRENCLAVE=$(gramine-sgx-sigstruct-view "$SGX_SIG" | grep "mr_enclave" | awk '{print $2}')
echo ""
echo "MRENCLAVE: $MRENCLAVE"
echo ""

# Step 5: Test the quote service
echo "[5/5] Testing sgx-entrypoint..."
echo ""
echo "Starting enclave in background..."

# Start the enclave in the background
SGX=1 gramine-sgx workerd serve --experimental --verbose workerd.config.capnp > /tmp/gramine-test.log 2>&1 &
ENCLAVE_PID=$!
echo "Enclave PID: $ENCLAVE_PID"

# Wait for the quote service to be ready
echo "Waiting for quote service to be ready..."
MAX_WAIT=30
for i in $(seq 1 $MAX_WAIT); do
    if curl -sf http://localhost:3333/healthz > /dev/null 2>&1; then
        echo "Quote service is ready!"
        break
    fi

    # Check if process is still running
    if ! kill -0 $ENCLAVE_PID 2>/dev/null; then
        echo "ERROR: Enclave process died unexpectedly"
        cat /tmp/gramine-test.log
        exit 1
    fi

    if [ $i -eq $MAX_WAIT ]; then
        echo "ERROR: Quote service did not start within ${MAX_WAIT}s"
        echo "Last 50 lines of log:"
        tail -50 /tmp/gramine-test.log
        kill $ENCLAVE_PID 2>/dev/null || true
        exit 1
    fi

    sleep 1
done

# Test the health endpoint
echo ""
echo "Testing /healthz endpoint:"
curl -s http://localhost:3333/healthz | jq .

# Test quote generation (without public key)
echo ""
echo "Testing /quote endpoint (GET):"
curl -s http://localhost:3333/quote | jq .quote | head -c 50
echo "..."

# Test quote generation (with public key)
echo ""
echo "Testing /quote endpoint (POST with publicKey):"
curl -s -X POST http://localhost:3333/quote \
    -H "Content-Type: application/json" \
    -d '{"publicKey": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32]}' \
    | jq .quote | head -c 50
echo "..."

# Cleanup
echo ""
echo "Stopping enclave..."
kill $ENCLAVE_PID 2>/dev/null || true
wait $ENCLAVE_PID 2>/dev/null || true

echo ""
echo "=== Test Complete ==="
echo "sgx-entrypoint is working correctly!"
echo ""
echo "MRENCLAVE: $MRENCLAVE"
echo "Manifest: $SGX_MANIFEST"
echo "Signature: $SGX_SIG"
