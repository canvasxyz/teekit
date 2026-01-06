#!/bin/bash
# Script to fetch SGX quote from kettle-sgx and submit to Microsoft Azure Attestation

set -e

# Configuration
KETTLE_QUOTE_URL="${KETTLE_QUOTE_URL:-http://localhost:3333/quote}"
MAA_ENDPOINT="${MAA_ENDPOINT:-https://maa.eus.attest.azure.net}"
API_VERSION="${API_VERSION:-2025-06-01}"

echo "=== Generating Test Public Key ==="
# Generate a random 32-byte x25519 public key for testing
# (In production, this would be your actual ephemeral public key)
PUBLIC_KEY_BYTES=$(openssl rand -hex 32)
echo "Public Key (hex): $PUBLIC_KEY_BYTES"

# Convert hex to JSON array of decimal bytes for the quote service
PUBLIC_KEY_JSON=$(echo -n "$PUBLIC_KEY_BYTES" | sed 's/../0x& /g' | xargs printf '%d,' | sed 's/,$//' | sed 's/^/[/' | sed 's/$/]/')

echo ""
echo "=== Fetching SGX Quote from Kettle-SGX ==="
echo "Quote URL: $KETTLE_QUOTE_URL"

# Fetch quote from kettle-sgx service with the public key
QUOTE_REQUEST=$(jq -n --argjson pubkey "$PUBLIC_KEY_JSON" '{publicKey: $pubkey}')
QUOTE_RESPONSE=$(curl -s -X POST "$KETTLE_QUOTE_URL" \
    -H "Content-Type: application/json" \
    -d "$QUOTE_REQUEST")

# Extract the quote field (base64-encoded)
QUOTE=$(echo "$QUOTE_RESPONSE" | jq -r '.quote')

if [ "$QUOTE" = "null" ] || [ -z "$QUOTE" ]; then
    echo "Error: Failed to get quote from kettle-sgx service"
    echo "Response: $QUOTE_RESPONSE"
    exit 1
fi

echo "✓ Quote retrieved successfully (${#QUOTE} bytes base64-encoded)"

# Convert the public key to base64 for runtimeData
# This is the original data that was hashed into report_data
PUBLIC_KEY_BASE64=$(echo -n "$PUBLIC_KEY_BYTES" | xxd -r -p | base64 -w0)

echo "✓ Public key encoded for runtime data (${#PUBLIC_KEY_BASE64} bytes base64)"

# Prepare MAA request payload with runtimeData
MAA_REQUEST=$(jq -n \
    --arg quote "$QUOTE" \
    --arg runtime_data "$PUBLIC_KEY_BASE64" \
    '{
        quote: $quote,
        runtimeData: {
            data: $runtime_data,
            dataType: "BINARY"
        }
    }')

echo ""
echo "=== Submitting to Microsoft Azure Attestation ==="
echo "MAA Endpoint: $MAA_ENDPOINT/attest/SgxEnclave?api-version=$API_VERSION"

# Submit to MAA
MAA_RESPONSE=$(curl -s -X POST \
    "$MAA_ENDPOINT/attest/SgxEnclave?api-version=$API_VERSION" \
    -H "Content-Type: application/json" \
    -d "$MAA_REQUEST" \
    -w "\nHTTP_STATUS:%{http_code}")

# Extract HTTP status
HTTP_STATUS=$(echo "$MAA_RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
RESPONSE_BODY=$(echo "$MAA_RESPONSE" | sed '/HTTP_STATUS/d')

echo "HTTP Status: $HTTP_STATUS"
echo ""

if [ "$HTTP_STATUS" = "200" ]; then
    echo "✓ Attestation successful!"
    echo ""
    echo "=== Attestation Token ==="
    echo "$RESPONSE_BODY" | jq '.'

    # Optionally decode and display the JWT token
    TOKEN=$(echo "$RESPONSE_BODY" | jq -r '.token')
    if [ "$TOKEN" != "null" ] && [ -n "$TOKEN" ]; then
        echo ""
        echo "=== Decoded JWT Header ==="
        echo "$TOKEN" | cut -d. -f1 | base64 -d 2>/dev/null | jq '.' || echo "(unable to decode)"

        echo ""
        echo "=== Decoded JWT Payload ==="
        echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq '.' || echo "(unable to decode)"
    fi
else
    echo "✗ Attestation failed!"
    echo "$RESPONSE_BODY" | jq '.' || echo "$RESPONSE_BODY"
    exit 1
fi
