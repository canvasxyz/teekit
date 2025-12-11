#!/bin/bash
set -euo pipefail

# cert-persistence.sh - Utility for encrypting/decrypting Let's Encrypt certificates
# Uses AES-256-GCM with SEV-SNP sealing key for authenticated encryption

LOG_PREFIX="[cert-persistence]"
SEALING_KEY_FILE="/var/lib/kettle/sealing-key.bin"
PERSISTENT_CERTS_DIR="/persistent/certs"
LETSENCRYPT_DIR="/etc/letsencrypt"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $LOG_PREFIX $*"
}

error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $LOG_PREFIX ERROR: $*" >&2
}

# Get encryption key (first 32 bytes of sealing key as hex)
get_key_hex() {
    if [ ! -f "$SEALING_KEY_FILE" ]; then
        error "Sealing key not found: $SEALING_KEY_FILE"
        return 1
    fi

    local key_size
    key_size=$(stat -c%s "$SEALING_KEY_FILE" 2>/dev/null || stat -f%z "$SEALING_KEY_FILE" 2>/dev/null)
    if [ "$key_size" -lt 32 ]; then
        error "Sealing key too small: $key_size bytes (need at least 32)"
        return 1
    fi

    xxd -p -l 32 "$SEALING_KEY_FILE" | tr -d '\n'
}

# Generate hostname hash for filename (first 16 chars of SHA256)
hostname_hash() {
    local hostname="$1"
    echo -n "$hostname" | sha256sum | cut -c1-16
}

# Check if sealing key is available
has_sealing_key() {
    if [ ! -f "$SEALING_KEY_FILE" ]; then
        return 1
    fi

    local key_size
    key_size=$(stat -c%s "$SEALING_KEY_FILE" 2>/dev/null || stat -f%z "$SEALING_KEY_FILE" 2>/dev/null)
    [ "$key_size" -ge 32 ]
}

# Check if persistent storage is available
has_persistent_storage() {
    grep -q " /persistent " /proc/mounts 2>/dev/null
}

# Encrypt certificates and store to persistent storage
# Usage: encrypt_certs <hostname>
encrypt_certs() {
    local hostname="$1"
    local hash
    hash=$(hostname_hash "$hostname")
    local enc_file="$PERSISTENT_CERTS_DIR/${hash}.enc"
    local meta_file="$PERSISTENT_CERTS_DIR/${hash}.meta"

    log "Encrypting certificates for hostname: $hostname"

    if [ ! -d "$LETSENCRYPT_DIR" ]; then
        error "Let's Encrypt directory not found: $LETSENCRYPT_DIR"
        return 1
    fi

    # Create persistent certs directory if needed
    mkdir -p "$PERSISTENT_CERTS_DIR"

    # Get encryption key
    local key_hex
    key_hex=$(get_key_hex) || return 1

    # Generate random IV (12 bytes for GCM)
    local iv_hex
    iv_hex=$(openssl rand -hex 12)

    # Create tarball of letsencrypt directory and encrypt
    # Format: [12-byte IV][GCM ciphertext with auth tag]
    local temp_tar
    local temp_enc
    temp_tar=$(mktemp)
    temp_enc=$(mktemp)

    if ! tar -C /etc -cf "$temp_tar" letsencrypt 2>/dev/null; then
        error "Failed to create tarball of $LETSENCRYPT_DIR"
        rm -f "$temp_tar" "$temp_enc"
        return 1
    fi

    # Encrypt with AES-256-GCM
    if ! openssl enc -aes-256-gcm -K "$key_hex" -iv "$iv_hex" -in "$temp_tar" -out "$temp_enc" 2>/dev/null; then
        error "Failed to encrypt certificates"
        rm -f "$temp_tar" "$temp_enc"
        return 1
    fi

    # Write IV + ciphertext to final file
    echo -n "$iv_hex" | xxd -r -p > "$enc_file"
    cat "$temp_enc" >> "$enc_file"

    rm -f "$temp_tar" "$temp_enc"

    # Get certificate expiry date for metadata
    local cert_expiry=""
    local cert_file="$LETSENCRYPT_DIR/live/${hostname}/fullchain.pem"
    if [ -f "$cert_file" ]; then
        cert_expiry=$(openssl x509 -enddate -noout -in "$cert_file" 2>/dev/null | cut -d= -f2 || echo "")
    fi

    # Write metadata
    cat > "$meta_file" <<EOF
HOSTNAME=$hostname
CREATED=$(date -Iseconds)
CERT_EXPIRY=$cert_expiry
EOF

    log "Certificates encrypted and stored to $enc_file"
    log "Metadata: hostname=$hostname, expiry=$cert_expiry"
    return 0
}

# Decrypt and restore certificates from persistent storage
# Usage: decrypt_certs <hostname>
# Returns: 0 on success, 1 on failure
decrypt_certs() {
    local hostname="$1"
    local hash
    hash=$(hostname_hash "$hostname")
    local enc_file="$PERSISTENT_CERTS_DIR/${hash}.enc"
    local meta_file="$PERSISTENT_CERTS_DIR/${hash}.meta"

    log "Attempting to restore certificates for hostname: $hostname"

    if [ ! -f "$enc_file" ]; then
        log "No cached certificates found for $hostname"
        return 1
    fi

    # Verify metadata hostname matches
    if [ -f "$meta_file" ]; then
        local stored_hostname
        stored_hostname=$(grep "^HOSTNAME=" "$meta_file" | cut -d= -f2)
        if [ "$stored_hostname" != "$hostname" ]; then
            error "Hostname mismatch: expected $hostname, found $stored_hostname"
            return 1
        fi
    fi

    # Get decryption key
    local key_hex
    key_hex=$(get_key_hex) || return 1

    # Extract IV (first 12 bytes = 24 hex chars) and ciphertext
    local iv_hex
    iv_hex=$(xxd -p -l 12 "$enc_file" | tr -d '\n')

    local temp_enc
    local temp_tar
    temp_enc=$(mktemp)
    temp_tar=$(mktemp)

    # Skip first 12 bytes (IV) and write rest to temp file
    tail -c +13 "$enc_file" > "$temp_enc"

    # Decrypt with AES-256-GCM
    if ! openssl enc -d -aes-256-gcm -K "$key_hex" -iv "$iv_hex" -in "$temp_enc" -out "$temp_tar" 2>/dev/null; then
        error "Failed to decrypt certificates (key mismatch or corrupted data)"
        rm -f "$temp_enc" "$temp_tar"
        return 1
    fi

    rm -f "$temp_enc"

    # Extract tarball to /etc
    if ! tar -C /etc -xf "$temp_tar" 2>/dev/null; then
        error "Failed to extract certificate tarball"
        rm -f "$temp_tar"
        return 1
    fi

    rm -f "$temp_tar"

    log "Certificates restored successfully to $LETSENCRYPT_DIR"
    return 0
}

# Validate restored certificates
# Usage: validate_certs <hostname>
# Returns: 0 if valid, 1 if invalid/expired
validate_certs() {
    local hostname="$1"
    local cert_file="$LETSENCRYPT_DIR/live/${hostname}/fullchain.pem"
    local key_file="$LETSENCRYPT_DIR/live/${hostname}/privkey.pem"

    # Check files exist
    if [ ! -f "$cert_file" ] || [ ! -f "$key_file" ]; then
        error "Certificate files not found for $hostname"
        return 1
    fi

    # Check certificate not expired (with 7-day buffer)
    local expiry_date
    expiry_date=$(openssl x509 -enddate -noout -in "$cert_file" 2>/dev/null | cut -d= -f2)
    if [ -z "$expiry_date" ]; then
        error "Could not read certificate expiry"
        return 1
    fi

    local expiry_seconds
    local now_seconds
    expiry_seconds=$(date -d "$expiry_date" +%s 2>/dev/null || date -j -f "%b %d %H:%M:%S %Y %Z" "$expiry_date" +%s 2>/dev/null)
    now_seconds=$(date +%s)
    local buffer_seconds=$((7 * 24 * 60 * 60))  # 7 days

    if [ $((expiry_seconds - buffer_seconds)) -lt "$now_seconds" ]; then
        log "Certificate expires within 7 days or is already expired"
        return 1
    fi

    # Verify certificate matches hostname (check CN and SANs)
    local cert_cn
    cert_cn=$(openssl x509 -subject -noout -in "$cert_file" 2>/dev/null | sed -n 's/.*CN *= *\([^,]*\).*/\1/p' || echo "")

    local cert_sans
    cert_sans=$(openssl x509 -text -noout -in "$cert_file" 2>/dev/null | grep -A1 "Subject Alternative Name" | tail -1 | tr ',' '\n' | sed -n 's/.*DNS:\([^ ]*\).*/\1/p' || echo "")

    local found_match=false
    for name in $cert_cn $cert_sans; do
        if [ "$name" = "$hostname" ]; then
            found_match=true
            break
        fi
    done

    if [ "$found_match" = false ]; then
        error "Certificate does not match hostname $hostname"
        return 1
    fi

    log "Certificate validation passed for $hostname (expires: $expiry_date)"
    return 0
}

# Remove cached certificates for a hostname
# Usage: remove_cached_certs <hostname>
remove_cached_certs() {
    local hostname="$1"
    local hash
    hash=$(hostname_hash "$hostname")
    local enc_file="$PERSISTENT_CERTS_DIR/${hash}.enc"
    local meta_file="$PERSISTENT_CERTS_DIR/${hash}.meta"

    rm -f "$enc_file" "$meta_file"
    log "Removed cached certificates for $hostname"
}

# Main entry point - called with subcommand
case "${1:-}" in
    encrypt)
        shift
        encrypt_certs "$@"
        ;;
    decrypt)
        shift
        decrypt_certs "$@"
        ;;
    validate)
        shift
        validate_certs "$@"
        ;;
    remove)
        shift
        remove_cached_certs "$@"
        ;;
    has-sealing-key)
        has_sealing_key
        ;;
    has-persistent-storage)
        has_persistent_storage
        ;;
    *)
        echo "Usage: $0 {encrypt|decrypt|validate|remove|has-sealing-key|has-persistent-storage} [args]"
        echo ""
        echo "Commands:"
        echo "  encrypt <hostname>     Encrypt and store certificates for hostname"
        echo "  decrypt <hostname>     Decrypt and restore certificates for hostname"
        echo "  validate <hostname>    Validate restored certificates (not expired, hostname matches)"
        echo "  remove <hostname>      Remove cached certificates for hostname"
        echo "  has-sealing-key        Check if sealing key is available (exit 0 if yes)"
        echo "  has-persistent-storage Check if /persistent is mounted (exit 0 if yes)"
        exit 1
        ;;
esac
