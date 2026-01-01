#!/bin/bash
#
# Generate Secure Boot signing keys for Azure Trusted Launch
#
# This script generates the cryptographic keys needed to sign the UKI
# (Unified Kernel Image) for UEFI Secure Boot on Azure Trusted Launch VMs.
#
# Generated files:
#   - mkosi.secureboot.key: Private signing key (keep secret!)
#   - mkosi.secureboot.crt: Public certificate (enrolled in Azure UEFI)
#   - mkosi.secureboot.GUID.txt: Unique identifier for key enrollment
#
# These keys will be used by mkosi during the build process to sign
# the SGX image for Azure Trusted Launch with Secure Boot enabled.
#
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

KEY_FILE="mkosi.secureboot.key"
CERT_FILE="mkosi.secureboot.crt"
GUID_FILE="mkosi.secureboot.GUID.txt"

echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Secure Boot Key Generation${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo ""

# Check if keys already exist
if [ -f "$KEY_FILE" ] || [ -f "$CERT_FILE" ]; then
    echo -e "${YELLOW}[WARNING]${NC} Secure Boot keys already exist:"
    [ -f "$KEY_FILE" ] && echo "  - $KEY_FILE"
    [ -f "$CERT_FILE" ] && echo "  - $CERT_FILE"
    [ -f "$GUID_FILE" ] && echo "  - $GUID_FILE"
    echo ""
    echo -n "Overwrite existing keys? [y/N] "
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}[INFO]${NC} Keeping existing keys. Exiting."
        exit 0
    fi
    echo ""
    echo -e "${YELLOW}[WARNING]${NC} Removing existing keys..."
    rm -f "$KEY_FILE" "$CERT_FILE" "$GUID_FILE"
fi

# Check if openssl is available
if ! command -v openssl &>/dev/null; then
    echo -e "${RED}[ERROR]${NC} openssl is not installed."
    echo "Please install openssl and try again."
    exit 1
fi

# Check if uuidgen is available
if ! command -v uuidgen &>/dev/null; then
    echo -e "${RED}[ERROR]${NC} uuidgen is not installed."
    echo "Please install uuid-runtime (or equivalent) and try again."
    exit 1
fi

echo -e "${GREEN}[1/3]${NC} Generating GUID for key identification..."
# Prefer uuidgen --random but fall back to default if RNG option unsupported
if ! uuidgen --random > "$GUID_FILE" 2>/dev/null; then
    if ! uuidgen > "$GUID_FILE"; then
        echo -e "${RED}[ERROR]${NC} Failed to generate GUID with uuidgen"
        exit 1
    fi
fi
GUID=$(cat "$GUID_FILE")
echo "      GUID: $GUID"
echo ""

echo -e "${GREEN}[2/3]${NC} Generating RSA-4096 private key and certificate..."
echo "      This may take a moment..."
if ! openssl req -newkey rsa:4096 -noenc \
    -keyout "$KEY_FILE" \
    -new -x509 -sha256 -days 3650 \
    -subj "/CN=TeeKit Secure Boot Signing Key/" \
    -out "$CERT_FILE" 2>/dev/null; then
    echo -e "${RED}[ERROR]${NC} Failed to generate keys"
    exit 1
fi
echo "      Private key: $KEY_FILE"
echo "      Certificate: $CERT_FILE"
echo ""

echo -e "${GREEN}[3/3]${NC} Verifying certificate..."
CERT_SUBJECT=$(openssl x509 -in "$CERT_FILE" -noout -subject | sed 's/subject=//')
CERT_DATES=$(openssl x509 -in "$CERT_FILE" -noout -dates)
echo "      Subject: $CERT_SUBJECT"
echo "      $CERT_DATES"
echo ""

echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Secure Boot keys generated successfully!${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "Generated files:"
echo "  - $KEY_FILE (private key - keep secret!)"
echo "  - $CERT_FILE (public certificate)"
echo "  - $GUID_FILE (unique identifier)"
echo ""
echo -e "${YELLOW}IMPORTANT:${NC}"
echo "  1. Keep $KEY_FILE secure and never commit it to version control"
echo "  2. The certificate ($CERT_FILE) will be enrolled in Azure UEFI"
echo "  3. These keys are specific to your builds - do not share them"
echo ""
echo "Next steps:"
echo "  1. Build an SGX image: npm run build:azsgx"
echo "  2. Deploy with Secure Boot: npm run deploy:azsgx"
echo ""
