#!/bin/bash
set -euo pipefail

# sgx-persist.sh - Persist Gramine-encrypted data across reboots
#
# Gramine's Protected File System (PFS) encrypts /var/lib/kettle using
# SGX sealing keys bound to MRENCLAVE. The encrypted files are stored on
# the host filesystem, but since the rootfs is ephemeral (UKI boot), we
# need to sync them to persistent storage.
#
# This script simply copies the encrypted blobs to/from /persistent.
# No additional encryption is needed - Gramine already handles that.
#
# SECURITY NOTE: Unlike SEV-SNP's certbot-persist which encrypts certificates
# with a sealing key, this script stores /etc/letsencrypt UNENCRYPTED on the
# persistent disk. This is intentional: Azure SGX VMs use Trusted Launch (not
# full memory encryption), so the TLS certificates are not in the enclave's
# trust boundary anyway. The security-sensitive data (DO storage, app state)
# IS encrypted by Gramine PFS.

LOG_PREFIX="[sgx-persist]"
SERIAL_CONSOLE="/dev/ttyS0"
KETTLE_DATA_DIR="/var/lib/kettle"
PERSISTENT_KETTLE_DIR="/persistent/kettle-data"
PERSISTENT_CERTS_DIR="/persistent/certs"
LETSENCRYPT_DIR="/etc/letsencrypt"

# Tee output to serial console for debugging
exec > >(tee >(sed "s/^/$LOG_PREFIX /" > "$SERIAL_CONSOLE" 2>/dev/null || true)) 2>&1

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
}

# Check if persistent storage is available
has_persistent_storage() {
    grep -q " /persistent " /proc/mounts 2>/dev/null
}

# Restore kettle data from persistent storage
# Called at boot, before Gramine starts
restore_data() {
    log "Restoring data from persistent storage..."

    if ! has_persistent_storage; then
        log "No persistent storage available, skipping restore"
        return 0
    fi

    # Restore kettle data (Gramine-encrypted database files)
    if [ -d "$PERSISTENT_KETTLE_DIR" ] && [ -n "$(ls -A "$PERSISTENT_KETTLE_DIR" 2>/dev/null)" ]; then
        log "Restoring kettle data from $PERSISTENT_KETTLE_DIR..."
        mkdir -p "$KETTLE_DATA_DIR"

        # Use rsync for efficient sync, preserving all attributes
        if command -v rsync &> /dev/null; then
            rsync -a --delete "$PERSISTENT_KETTLE_DIR/" "$KETTLE_DATA_DIR/"
        else
            # Fallback to cp if rsync not available
            rm -rf "$KETTLE_DATA_DIR"/*
            cp -a "$PERSISTENT_KETTLE_DIR"/* "$KETTLE_DATA_DIR/" 2>/dev/null || true
        fi

        # Ensure correct ownership for kettle user
        if id kettle &>/dev/null; then
            chown -R kettle:kettle "$KETTLE_DATA_DIR"
        fi

        log "Restored $(find "$KETTLE_DATA_DIR" -type f 2>/dev/null | wc -l) files from persistent storage"
    else
        log "No persisted kettle data found at $PERSISTENT_KETTLE_DIR"
    fi

    # Restore Let's Encrypt certificates (unencrypted on disk, but harmless)
    # These are NOT in the Gramine enclave, just stored on the host
    if [ -d "$PERSISTENT_CERTS_DIR" ] && [ -n "$(ls -A "$PERSISTENT_CERTS_DIR" 2>/dev/null)" ]; then
        log "Restoring certificates from $PERSISTENT_CERTS_DIR..."
        mkdir -p "$LETSENCRYPT_DIR"

        if command -v rsync &> /dev/null; then
            rsync -a "$PERSISTENT_CERTS_DIR/" "$LETSENCRYPT_DIR/"
        else
            cp -a "$PERSISTENT_CERTS_DIR"/* "$LETSENCRYPT_DIR/" 2>/dev/null || true
        fi

        log "Restored certificates"
    else
        log "No persisted certificates found at $PERSISTENT_CERTS_DIR"
    fi

    log "Data restore complete"
    return 0
}

# Save kettle data to persistent storage
# Called at shutdown, after Gramine stops
save_data() {
    log "Saving data to persistent storage..."

    if ! has_persistent_storage; then
        log "No persistent storage available, skipping save"
        return 0
    fi

    # Save kettle data (Gramine-encrypted database files)
    if [ -d "$KETTLE_DATA_DIR" ] && [ -n "$(ls -A "$KETTLE_DATA_DIR" 2>/dev/null)" ]; then
        log "Saving kettle data to $PERSISTENT_KETTLE_DIR..."
        mkdir -p "$PERSISTENT_KETTLE_DIR"

        if command -v rsync &> /dev/null; then
            rsync -a --delete "$KETTLE_DATA_DIR/" "$PERSISTENT_KETTLE_DIR/"
        else
            rm -rf "$PERSISTENT_KETTLE_DIR"/*
            cp -a "$KETTLE_DATA_DIR"/* "$PERSISTENT_KETTLE_DIR/" 2>/dev/null || true
        fi

        log "Saved $(find "$KETTLE_DATA_DIR" -type f 2>/dev/null | wc -l) files to persistent storage"
    else
        log "No kettle data to save at $KETTLE_DATA_DIR"
    fi

    # Save Let's Encrypt certificates
    if [ -d "$LETSENCRYPT_DIR" ] && [ -n "$(ls -A "$LETSENCRYPT_DIR" 2>/dev/null)" ]; then
        log "Saving certificates to $PERSISTENT_CERTS_DIR..."
        mkdir -p "$PERSISTENT_CERTS_DIR"

        if command -v rsync &> /dev/null; then
            rsync -a --delete "$LETSENCRYPT_DIR/" "$PERSISTENT_CERTS_DIR/"
        else
            rm -rf "$PERSISTENT_CERTS_DIR"/*
            cp -a "$LETSENCRYPT_DIR"/* "$PERSISTENT_CERTS_DIR/" 2>/dev/null || true
        fi

        log "Saved certificates"
    else
        log "No certificates to save at $LETSENCRYPT_DIR"
    fi

    # Sync to ensure data is written to disk
    sync

    log "Data save complete"
    return 0
}

# Check if persistent storage is available
check_persistent() {
    if has_persistent_storage; then
        log "Persistent storage is available"
        df -h /persistent | tail -1
        return 0
    else
        log "Persistent storage is NOT available"
        return 1
    fi
}

# Show status
status() {
    log "=== SGX Persist Status ==="

    if has_persistent_storage; then
        log "Persistent storage: AVAILABLE"
        df -h /persistent | tail -1
    else
        log "Persistent storage: NOT AVAILABLE"
    fi

    if [ -d "$PERSISTENT_KETTLE_DIR" ]; then
        local file_count=$(find "$PERSISTENT_KETTLE_DIR" -type f 2>/dev/null | wc -l)
        local size=$(du -sh "$PERSISTENT_KETTLE_DIR" 2>/dev/null | cut -f1)
        log "Persisted kettle data: $file_count files, $size"
    else
        log "Persisted kettle data: none"
    fi

    if [ -d "$PERSISTENT_CERTS_DIR" ]; then
        log "Persisted certificates: yes"
    else
        log "Persisted certificates: none"
    fi

    if [ -d "$KETTLE_DATA_DIR" ]; then
        local file_count=$(find "$KETTLE_DATA_DIR" -type f 2>/dev/null | wc -l)
        local size=$(du -sh "$KETTLE_DATA_DIR" 2>/dev/null | cut -f1)
        log "Current kettle data: $file_count files, $size"
    else
        log "Current kettle data: none"
    fi
}

# Main entry point
case "${1:-}" in
    restore)
        restore_data
        ;;
    save)
        save_data
        ;;
    check)
        check_persistent
        ;;
    status)
        status
        ;;
    *)
        echo "Usage: $0 {restore|save|check|status}"
        echo ""
        echo "Commands:"
        echo "  restore    Restore data from persistent storage (run at boot)"
        echo "  save       Save data to persistent storage (run at shutdown)"
        echo "  check      Check if persistent storage is available"
        echo "  status     Show persistence status"
        exit 1
        ;;
esac
