#!/bin/bash
# Script to fetch SGX quote from kettle-sgx and submit to Microsoft Azure Attestation

set -e

# Configuration
KETTLE_QUOTE_URL="${KETTLE_QUOTE_URL:-http://localhost:3333/quote}"
MAA_ENDPOINT="${MAA_ENDPOINT:-https://maa.eus.attest.azure.net}"
API_VERSION="${API_VERSION:-2025-06-01}"

echo "=== Fetching SGX Quote from Kettle-SGX ==="
echo "Quote URL: $KETTLE_QUOTE_URL"

# Fetch quote from kettle-sgx service
QUOTE_RESPONSE=$(curl "$KETTLE_QUOTE_URL")

# Extract the quote field (base64-encoded)
QUOTE=$(echo "$QUOTE_RESPONSE" | jq -r '.quote')

if [ "$QUOTE" = "null" ] || [ -z "$QUOTE" ]; then
    echo "Error: Failed to get quote from kettle-sgx service"
    echo "Response: $QUOTE_RESPONSE"
    exit 1
fi

echo "✓ Quote retrieved successfully (${#QUOTE} bytes base64-encoded)"

# Optionally extract report_data for runtime data
REPORT_DATA=$(echo "$QUOTE_RESPONSE" | jq -r '.report_data')

# Prepare MAA request payload
MAA_REQUEST=$(jq -n \
    --arg quote "$QUOTE" \
    '{
        quote: $quote
    }')

# Optionally include runtimeData if you want to bind the report_data
# Uncomment the following to include runtime data:
# MAA_REQUEST=$(jq -n \
#     --arg quote "$QUOTE" \
#     --arg report_data "$REPORT_DATA" \
#     '{
#         quote: $quote,
#         runtimeData: {
#             data: $report_data,
#             dataType: "BINARY"
#         }
#     }')

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
