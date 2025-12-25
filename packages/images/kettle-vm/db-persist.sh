#!/bin/bash
set -euo pipefail

# db-persist.sh - Utility for encrypting/decrypting Kettle SQLite databases
# Uses AES-256-CBC + HMAC-SHA256 (encrypt-then-MAC) with SEV-SNP sealing key
# Similar to certbot-persist.sh but for database persistence

LOG_PREFIX="[db-persist]"
SEALING_KEY_FILE="/var/lib/kettle/sealing-key.bin"
PERSISTENT_DB_DIR="/persistent/db"
KETTLE_DB_BASE="/var/lib/kettle"

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

    # Derive encryption key: SHA256("db-enc" || sealing_key)
    (printf "db-enc"; cat "$SEALING_KEY_FILE") | openssl dgst -sha256 -binary | xxd -p | tr -d '\n'
}

# Derive MAC key from sealing key using SHA-256
# Usage: get_mac_key_hex
get_mac_key_hex() {
    if [ ! -f "$SEALING_KEY_FILE" ]; then
        error "Sealing key not found: $SEALING_KEY_FILE"
        return 1
    fi

    # Derive MAC key: SHA256("db-mac" || sealing_key)
    (printf "db-mac"; cat "$SEALING_KEY_FILE") | openssl dgst -sha256 -binary | xxd -p | tr -d '\n'
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

# Encrypt a database directory and store to persistent storage
# Usage: encrypt_db <db_name>
# db_name can be "db" for single kettle or "db-0", "db-1" for multiple
encrypt_db() {
    local db_name="$1"
    local db_dir="$KETTLE_DB_BASE/$db_name"
    local enc_file="$PERSISTENT_DB_DIR/${db_name}.enc"
    local meta_file="$PERSISTENT_DB_DIR/${db_name}.meta"

    log "Encrypting database: $db_name"

    if [ ! -d "$db_dir" ]; then
        log "Database directory not found: $db_dir (nothing to persist)"
        return 0
    fi

    # Check if directory has any content
    if [ -z "$(ls -A "$db_dir" 2>/dev/null)" ]; then
        log "Database directory is empty: $db_dir (nothing to persist)"
        return 0
    fi

    # Create persistent db directory if needed
    mkdir -p "$PERSISTENT_DB_DIR"

    # Get encryption and MAC keys
    local enc_key_hex mac_key_hex
    enc_key_hex=$(get_enc_key_hex) || return 1
    mac_key_hex=$(get_mac_key_hex) || return 1

    # Generate random IV (16 bytes for CBC)
    local iv_hex
    iv_hex=$(openssl rand -hex 16)

    # Create tarball of database directory and encrypt
    # Format: [16-byte IV][CBC ciphertext][32-byte HMAC]
    local temp_tar temp_enc temp_combined
    temp_tar=$(mktemp)
    temp_enc=$(mktemp)
    temp_combined=$(mktemp)

    if ! tar -C "$KETTLE_DB_BASE" -cf "$temp_tar" "$db_name"; then
        error "Failed to create tarball of $db_dir"
        rm -f "$temp_tar" "$temp_enc" "$temp_combined"
        return 1
    fi

    # Encrypt with AES-256-CBC
    if ! openssl enc -aes-256-cbc -K "$enc_key_hex" -iv "$iv_hex" -in "$temp_tar" -out "$temp_enc"; then
        error "Failed to encrypt database"
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

    # Get database size for metadata
    local db_size
    db_size=$(du -sb "$db_dir" 2>/dev/null | cut -f1 || echo "0")

    # Write metadata
    cat > "$meta_file" <<EOF
DB_NAME=$db_name
CREATED=$(date -Iseconds)
DB_SIZE=$db_size
EOF

    log "Database encrypted and stored to $enc_file"
    log "Metadata: db_name=$db_name, size=$db_size bytes"
    return 0
}

# Decrypt and restore database from persistent storage
# Usage: decrypt_db <db_name>
# Returns: 0 on success, 1 on failure
decrypt_db() {
    local db_name="$1"
    local db_dir="$KETTLE_DB_BASE/$db_name"
    local enc_file="$PERSISTENT_DB_DIR/${db_name}.enc"
    local meta_file="$PERSISTENT_DB_DIR/${db_name}.meta"

    log "Attempting to restore database: $db_name"

    if [ ! -f "$enc_file" ]; then
        log "No cached database found for $db_name"
        return 1
    fi

    # Verify metadata db_name matches
    if [ -f "$meta_file" ]; then
        local stored_db_name
        stored_db_name=$(grep "^DB_NAME=" "$meta_file" | cut -d= -f2)
        if [ "$stored_db_name" != "$db_name" ]; then
            error "Database name mismatch: expected $db_name, found $stored_db_name"
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
        error "Failed to decrypt database"
        rm -f "$temp_enc" "$temp_tar"
        return 1
    fi

    rm -f "$temp_enc"

    # Create parent directory if it doesn't exist
    mkdir -p "$KETTLE_DB_BASE"

    # Remove existing database directory if it exists
    if [ -d "$db_dir" ]; then
        rm -rf "$db_dir"
    fi

    # Extract tarball to kettle base directory
    if ! tar -C "$KETTLE_DB_BASE" -xf "$temp_tar"; then
        error "Failed to extract database tarball"
        rm -f "$temp_tar"
        return 1
    fi

    rm -f "$temp_tar"

    log "Database restored successfully to $db_dir"
    return 0
}

# Encrypt all databases in /var/lib/kettle
# Usage: encrypt_all
encrypt_all() {
    log "Encrypting all databases..."

    if ! has_sealing_key; then
        log "No sealing key available, skipping encryption"
        return 0
    fi

    if ! has_persistent_storage; then
        log "No persistent storage available, skipping encryption"
        return 0
    fi

    local count=0

    # Look for db directories (db, db-0, db-1, etc.)
    for db_dir in "$KETTLE_DB_BASE"/db*; do
        if [ -d "$db_dir" ]; then
            local db_name
            db_name=$(basename "$db_dir")
            if encrypt_db "$db_name"; then
                count=$((count + 1))
            fi
        fi
    done

    log "Encrypted $count database(s)"
    return 0
}

# Decrypt all databases from persistent storage
# Usage: decrypt_all
decrypt_all() {
    log "Decrypting all databases..."

    if ! has_sealing_key; then
        log "No sealing key available, skipping decryption"
        return 0
    fi

    if ! has_persistent_storage; then
        log "No persistent storage available, skipping decryption"
        return 0
    fi

    local count=0

    # Look for encrypted database files
    for enc_file in "$PERSISTENT_DB_DIR"/*.enc; do
        if [ -f "$enc_file" ]; then
            local db_name
            db_name=$(basename "$enc_file" .enc)
            if decrypt_db "$db_name"; then
                count=$((count + 1))
            fi
        fi
    done

    log "Decrypted $count database(s)"
    return 0
}

# Remove cached database
# Usage: remove_cached_db <db_name>
remove_cached_db() {
    local db_name="$1"
    local enc_file="$PERSISTENT_DB_DIR/${db_name}.enc"
    local meta_file="$PERSISTENT_DB_DIR/${db_name}.meta"

    rm -f "$enc_file" "$meta_file"
    log "Removed cached database: $db_name"
}

# Main entry point - called with subcommand
case "${1:-}" in
    encrypt)
        shift
        encrypt_db "$@"
        ;;
    decrypt)
        shift
        decrypt_db "$@"
        ;;
    encrypt-all)
        encrypt_all
        ;;
    decrypt-all)
        decrypt_all
        ;;
    remove)
        shift
        remove_cached_db "$@"
        ;;
    has-sealing-key)
        has_sealing_key
        ;;
    has-persistent-storage)
        has_persistent_storage
        ;;
    *)
        echo "Usage: $0 {encrypt|decrypt|encrypt-all|decrypt-all|remove|has-sealing-key|has-persistent-storage} [args]"
        echo ""
        echo "Commands:"
        echo "  encrypt <db_name>        Encrypt and store database (e.g., 'db' or 'db-0')"
        echo "  decrypt <db_name>        Decrypt and restore database"
        echo "  encrypt-all              Encrypt all databases in /var/lib/kettle"
        echo "  decrypt-all              Decrypt all databases from /persistent/db"
        echo "  remove <db_name>         Remove cached database"
        echo "  has-sealing-key          Check if sealing key is available (exit 0 if yes)"
        echo "  has-persistent-storage   Check if /persistent is mounted (exit 0 if yes)"
        exit 1
        ;;
esac
