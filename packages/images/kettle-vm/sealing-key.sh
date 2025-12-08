#!/bin/bash
set -euo pipefail

# SEV-SNP Sealing Key Generator (Reference: https://github.com/virtee/snpguest)
# This script derives a deterministic key using AMD SEV-SNP hardware.
# The same VM configuration will always produce the same key. The key is bound to:
#   - Guest Policy (bit 0)
#   - Measurement (bit 3) - ensures key changes if disk image changes

LOG_PREFIX="[sealing-key]"
SERIAL_CONSOLE="/dev/ttyS0"
KEY_DIR="/var/lib/kettle"
KEY_FILE="$KEY_DIR/sealing-key.bin"
SEV_GUEST_DEV="/dev/sev-guest"

# Tee all output to serial console (with prefix) while preserving stdout/stderr for systemd
exec > >(tee >(sed "s/^/$LOG_PREFIX /" > "$SERIAL_CONSOLE" 2>/dev/null || true)) 2>&1

echo "Starting SEV-SNP sealing key derivation..."

# Check if we're running on SEV-SNP hardware
if [ ! -e "$SEV_GUEST_DEV" ]; then
    echo "$SEV_GUEST_DEV not found - not running on SEV-SNP hardware"
    echo "Exiting (this is expected on TDX or non-confidential VMs)"
    exit 0
fi

# Check if snpguest is available
if ! command -v snpguest &> /dev/null; then
    echo "ERROR: snpguest command not found"
    exit 1
fi

# Create key directory if it doesn't exist
mkdir -p "$KEY_DIR"

# Derive the sealing key using snpguest
# Parameters:
#   vcek - Use Versioned Chip Endorsement Key as root
#   --vmpl 1 - VM Privilege Level 1 (default for guest kernel)
#   --guest_field_select 9 - Bind to Policy (bit 0) + Measurement (bit 3) = 0b1001 = 9
echo "Deriving sealing key from SEV-SNP hardware..."

if ! snpguest key "$KEY_FILE" vcek --vmpl 1 --guest_field_select 9; then
    echo "ERROR: Failed to derive sealing key"
    exit 1
fi

# Verify the key file was created and has expected size (64 bytes)
if [ ! -f "$KEY_FILE" ]; then
    echo "ERROR: Key file was not created"
    exit 1
fi

KEY_SIZE=$(stat -c%s "$KEY_FILE")
if [ "$KEY_SIZE" -ne 64 ]; then
    echo "WARNING: Key file size is $KEY_SIZE bytes (expected 64)"
fi

# Set restrictive permissions on the key file
chmod 600 "$KEY_FILE"
echo "Sealing key derived successfully"
echo "Key file: $KEY_FILE ($KEY_SIZE bytes)"
echo "Key (hex): $(xxd -p -c 64 "$KEY_FILE")"

