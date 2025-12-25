#!/bin/bash
set -euo pipefail

# certbot-persist.sh - Utility for encrypting/decrypting Let's Encrypt certificates
# Uses AES-256-CBC + HMAC-SHA256 (encrypt-then-MAC) with SEV-SNP sealing key

LOG_PREFIX="[certbot-persist]"
SEALING_KEY_FILE="/var/lib/kettle/sealing-key.bin"
PERSISTENT_CERTS_DIR="/persistent/certs"
LETSENCRYPT_DIR="/etc/letsencrypt"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $LOG_PREFIX $*"
}

error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $LOG_PREFIX ERROR: $*" >&2
}

# Derive encryption key from sealing key using SHA-256
# Usage: get_enc_key_hex
get_enc_key_hex() {
    if [ ! -f "$SEALING_KEY_FILE" ]; then
        error "Sealing key not found: $SEALING_KEY_FILE"
        return 1
    fi

    local key_size
    key_size=$(stat -c%s "$SEALING_KEY_FILE" || stat -f%z "$SEALING_KEY_FILE")
    if [ "$key_size" -lt 32 ]; then
        error "Sealing key too small: $key_size bytes (need at least 32)"
        return 1
    fi

    # Derive encryption key: SHA256("enc" || sealing_key)
    (printf "enc"; cat "$SEALING_KEY_FILE") | openssl dgst -sha256 -binary | xxd -p | tr -d '\n'
}

# Derive MAC key from sealing key using SHA-256
# Usage: get_mac_key_hex
get_mac_key_hex() {
    if [ ! -f "$SEALING_KEY_FILE" ]; then
        error "Sealing key not found: $SEALING_KEY_FILE"
        return 1
    fi

    # Derive MAC key: SHA256("mac" || sealing_key)
    (printf "mac"; cat "$SEALING_KEY_FILE") | openssl dgst -sha256 -binary | xxd -p | tr -d '\n'
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
    key_size=$(stat -c%s "$SEALING_KEY_FILE" || stat -f%z "$SEALING_KEY_FILE")
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

    # Get encryption and MAC keys
    local enc_key_hex mac_key_hex
    enc_key_hex=$(get_enc_key_hex) || return 1
    mac_key_hex=$(get_mac_key_hex) || return 1

    # Generate random IV (16 bytes for CBC)
    local iv_hex
    iv_hex=$(openssl rand -hex 16)

    # Create tarball of letsencrypt directory and encrypt
    # Format: [16-byte IV][CBC ciphertext][32-byte HMAC]
    local temp_tar temp_enc temp_combined
    temp_tar=$(mktemp)
    temp_enc=$(mktemp)
    temp_combined=$(mktemp)

    if ! tar -C /etc -cf "$temp_tar" letsencrypt; then
        error "Failed to create tarball of $LETSENCRYPT_DIR"
        rm -f "$temp_tar" "$temp_enc" "$temp_combined"
        return 1
    fi

    # Encrypt with AES-256-CBC
    if ! openssl enc -aes-256-cbc -K "$enc_key_hex" -iv "$iv_hex" -in "$temp_tar" -out "$temp_enc"; then
        error "Failed to encrypt certificates"
        rm -f "$temp_tar" "$temp_enc" "$temp_combined"
        return 1
    fi

    # Build IV + ciphertext
    echo -n "$iv_hex" | xxd -r -p > "$temp_combined"
    cat "$temp_enc" >> "$temp_combined"

    # Compute HMAC-SHA256 over IV + ciphertext (encrypt-then-MAC)
    local hmac
    hmac=$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:$mac_key_hex" -binary "$temp_combined" | xxd -p | tr -d '\n')

    # Write final file: IV + ciphertext + HMAC
    cat "$temp_combined" > "$enc_file"
    echo -n "$hmac" | xxd -r -p >> "$enc_file"

    rm -f "$temp_tar" "$temp_enc" "$temp_combined"

    # Get certificate expiry date for metadata
    local cert_expiry=""
    local cert_file="$LETSENCRYPT_DIR/live/${hostname}/fullchain.pem"
    if [ -f "$cert_file" ]; then
        cert_expiry=$(openssl x509 -enddate -noout -in "$cert_file" | cut -d= -f2 || echo "")
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

    # Get decryption and MAC keys
    local enc_key_hex mac_key_hex
    enc_key_hex=$(get_enc_key_hex) || return 1
    mac_key_hex=$(get_mac_key_hex) || return 1

    # File format: [16-byte IV][CBC ciphertext][32-byte HMAC]
    local file_size
    file_size=$(stat -c%s "$enc_file" 2>/dev/null || stat -f%z "$enc_file")

    if [ "$file_size" -lt 49 ]; then  # 16 (IV) + 1 (min ciphertext) + 32 (HMAC)
        error "Encrypted file too small"
        return 1
    fi

    local temp_iv_cipher temp_enc temp_tar
    temp_iv_cipher=$(mktemp)
    temp_enc=$(mktemp)
    temp_tar=$(mktemp)

    # Extract IV + ciphertext (everything except last 32 bytes)
    local iv_cipher_size=$((file_size - 32))
    head -c "$iv_cipher_size" "$enc_file" > "$temp_iv_cipher"

    # Extract stored HMAC (last 32 bytes)
    local stored_hmac
    stored_hmac=$(tail -c 32 "$enc_file" | xxd -p | tr -d '\n')

    # Compute HMAC over IV + ciphertext and verify
    local computed_hmac
    computed_hmac=$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:$mac_key_hex" -binary "$temp_iv_cipher" | xxd -p | tr -d '\n')

    if [ "$stored_hmac" != "$computed_hmac" ]; then
        error "HMAC verification failed (key mismatch or corrupted data)"
        rm -f "$temp_iv_cipher" "$temp_enc" "$temp_tar"
        return 1
    fi

    # Extract IV (first 16 bytes)
    local iv_hex
    iv_hex=$(xxd -p -l 16 "$temp_iv_cipher" | tr -d '\n')

    # Extract ciphertext (skip first 16 bytes of IV)
    tail -c +17 "$temp_iv_cipher" > "$temp_enc"

    rm -f "$temp_iv_cipher"

    # Decrypt with AES-256-CBC
    if ! openssl enc -d -aes-256-cbc -K "$enc_key_hex" -iv "$iv_hex" -in "$temp_enc" -out "$temp_tar"; then
        error "Failed to decrypt certificates"
        rm -f "$temp_enc" "$temp_tar"
        return 1
    fi

    rm -f "$temp_enc"

    # Extract tarball to /etc
    if ! tar -C /etc -xf "$temp_tar"; then
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
    expiry_date=$(openssl x509 -enddate -noout -in "$cert_file" | cut -d= -f2)
    if [ -z "$expiry_date" ]; then
        error "Could not read certificate expiry"
        return 1
    fi

    local expiry_seconds
    local now_seconds
    expiry_seconds=$(date -d "$expiry_date" +%s || date -j -f "%b %d %H:%M:%S %Y %Z" "$expiry_date" +%s)
    now_seconds=$(date +%s)
    local buffer_seconds=$((7 * 24 * 60 * 60))  # 7 days

    if [ $((expiry_seconds - buffer_seconds)) -lt "$now_seconds" ]; then
        log "Certificate expires within 7 days or is already expired"
        return 1
    fi

    # Verify certificate matches hostname (check CN and SANs)
    local cert_cn
    cert_cn=$(openssl x509 -subject -noout -in "$cert_file" | sed -n 's/.*CN *= *\([^,]*\).*/\1/p' || echo "")

    local cert_sans
    cert_sans=$(openssl x509 -text -noout -in "$cert_file" | grep -A1 "Subject Alternative Name" | tail -1 | tr ',' '\n' | sed -n 's/.*DNS:\([^ ]*\).*/\1/p' || echo "")

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
