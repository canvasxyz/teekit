#!/bin/bash
#
# Gramine enclave entrypoint
# Starts both the SGX quote service and workerd inside the enclave
#

set -euo pipefail

# Port configuration
QUOTE_SERVICE_PORT="${QUOTE_SERVICE_PORT:-3333}"

# Start the SGX quote service in the background
echo "[entrypoint] Starting SGX quote service on port $QUOTE_SERVICE_PORT..."
node /opt/kettle/sgx-quote-service.js &
QUOTE_PID=$!

# Wait for quote service to be ready
echo "[entrypoint] Waiting for quote service to start..."
for i in {1..10}; do
    if curl -sf http://127.0.0.1:$QUOTE_SERVICE_PORT/healthz > /dev/null 2>&1; then
        echo "[entrypoint] Quote service is ready (PID: $QUOTE_PID)"
        break
    fi

    # Check if the process is still running
    if ! kill -0 $QUOTE_PID 2>/dev/null; then
        echo "[entrypoint] ERROR: Quote service process died unexpectedly"
        exit 1
    fi

    if [ $i -eq 10 ]; then
        echo "[entrypoint] ERROR: Quote service failed to respond after 10 seconds"
        kill $QUOTE_PID 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

# Start workerd in the foreground
echo "[entrypoint] Starting workerd..."
exec /usr/local/bin/workerd "$@"
