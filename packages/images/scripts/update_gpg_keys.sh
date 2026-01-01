#!/bin/bash
#
# Update embedded GPG keys for third-party APT repositories.
#
# This script fetches the latest GPG keys from upstream sources and updates
# all embedded copies in the repository. Run this periodically or when builds
# fail due to stale/expired keys.
#
# Keys updated:
#   - Intel SGX (https://download.01.org/intel-sgx/)
#   - Gramine (https://packages.gramineproject.io/)
#   - Microsoft (https://packages.microsoft.com/)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_header() { echo -e "\n${BLUE}=== $1 ===${NC}"; }

# Temporary directory for downloads
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

show_key_info() {
    local keyfile="$1"
    local name="$2"

    if [ -f "$keyfile" ]; then
        echo -e "${BLUE}$name:${NC}"
        # Use human-readable output which is more reliable
        gpg --show-keys "$keyfile" 2>/dev/null | sed 's/^/  /'
    else
        echo -e "${RED}$name: FILE NOT FOUND${NC}"
    fi
}

fetch_key() {
    local url="$1"
    local output="$2"
    local name="$3"

    log_info "Fetching $name from $url"

    if curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$TMPDIR/key.tmp" 2>/dev/null; then
        # Check if key is armored (ASCII) or binary
        if file "$TMPDIR/key.tmp" | grep -q "ASCII\|PGP public key block"; then
            # Armored key - dearmor it
            gpg --dearmor -o "$output" < "$TMPDIR/key.tmp" 2>/dev/null
        else
            # Already binary
            cp "$TMPDIR/key.tmp" "$output"
        fi
        return 0
    else
        log_error "Failed to fetch $name"
        return 1
    fi
}

update_intel_sgx_key() {
    log_header "Intel SGX Key"

    local key_url="https://download.01.org/intel-sgx/sgx_repo/ubuntu/intel-sgx-deb.key"
    local tmp_key="$TMPDIR/intel-sgx.gpg"

    if fetch_key "$key_url" "$tmp_key" "Intel SGX key"; then
        show_key_info "$tmp_key" "New Intel SGX key"

        # Update all copies
        local targets=(
            "$IMAGES_DIR/kettle-vm-sgx/mkosi.skeleton/usr/share/keyrings/intel-sgx.gpg"
            "$IMAGES_DIR/kettle-vm-sgx/mkosi.sandbox/etc/apt/keyrings/intel-sgx.gpg"
        )

        for target in "${targets[@]}"; do
            if [ -f "$target" ]; then
                cp "$tmp_key" "$target"
                log_info "Updated: $target"
            else
                log_warn "Target not found: $target"
            fi
        done
    fi
}

update_gramine_key() {
    log_header "Gramine Key"

    local key_url="https://packages.gramineproject.io/gramine-keyring.gpg"
    local tmp_key="$TMPDIR/gramine.gpg"

    if fetch_key "$key_url" "$tmp_key" "Gramine key"; then
        show_key_info "$tmp_key" "New Gramine key"

        # Update all copies
        local targets=(
            "$IMAGES_DIR/kettle-vm-sgx/mkosi.skeleton/usr/share/keyrings/gramine.gpg"
            "$IMAGES_DIR/kettle-vm-sgx/mkosi.sandbox/etc/apt/keyrings/gramine.gpg"
        )

        for target in "${targets[@]}"; do
            if [ -f "$target" ]; then
                cp "$tmp_key" "$target"
                log_info "Updated: $target"
            else
                log_warn "Target not found: $target"
            fi
        done
    fi
}

update_microsoft_key() {
    log_header "Microsoft Key"

    local key_url="https://packages.microsoft.com/keys/microsoft.asc"
    local tmp_key="$TMPDIR/microsoft.gpg"

    if fetch_key "$key_url" "$tmp_key" "Microsoft key"; then
        show_key_info "$tmp_key" "New Microsoft key"

        # Update all copies
        local targets=(
            "$IMAGES_DIR/mkosi.profiles/azsgx/mkosi.skeleton/usr/share/keyrings/microsoft.gpg"
            "$IMAGES_DIR/mkosi.profiles/azsgx/mkosi.sandbox/etc/apt/keyrings/microsoft.gpg"
            "$IMAGES_DIR/mkosi.profiles/azsgx-devtools/mkosi.skeleton/usr/share/keyrings/microsoft.gpg"
            "$IMAGES_DIR/mkosi.profiles/azsgx-devtools/mkosi.sandbox/etc/apt/keyrings/microsoft.gpg"
        )

        for target in "${targets[@]}"; do
            if [ -f "$target" ]; then
                cp "$tmp_key" "$target"
                log_info "Updated: $target"
            else
                log_warn "Target not found: $target"
            fi
        done
    fi
}

show_current_keys() {
    log_header "Current Embedded Keys"

    show_key_info "$IMAGES_DIR/kettle-vm-sgx/mkosi.skeleton/usr/share/keyrings/intel-sgx.gpg" "Intel SGX"
    echo ""
    show_key_info "$IMAGES_DIR/kettle-vm-sgx/mkosi.skeleton/usr/share/keyrings/gramine.gpg" "Gramine"
    echo ""
    show_key_info "$IMAGES_DIR/mkosi.profiles/azsgx/mkosi.skeleton/usr/share/keyrings/microsoft.gpg" "Microsoft"
}

main() {
    echo -e "${BLUE}GPG Key Updater for packages/images${NC}"
    echo "This script fetches the latest GPG keys from upstream sources."
    echo ""

    case "${1:-all}" in
        --show|show)
            show_current_keys
            ;;
        --intel|intel)
            update_intel_sgx_key
            ;;
        --gramine|gramine)
            update_gramine_key
            ;;
        --microsoft|microsoft)
            update_microsoft_key
            ;;
        --all|all)
            show_current_keys
            echo ""
            log_header "Updating All Keys"
            update_intel_sgx_key
            update_gramine_key
            update_microsoft_key
            echo ""
            log_header "Update Complete"
            log_info "Run 'git diff' to review changes, then commit if everything looks correct."
            ;;
        --help|help|-h)
            echo "Usage: $0 [command]"
            echo ""
            echo "Commands:"
            echo "  all        Update all keys (default)"
            echo "  show       Show current embedded key info"
            echo "  intel      Update Intel SGX key only"
            echo "  gramine    Update Gramine key only"
            echo "  microsoft  Update Microsoft key only"
            echo "  help       Show this help"
            ;;
        *)
            log_error "Unknown command: $1"
            echo "Run '$0 help' for usage."
            exit 1
            ;;
    esac
}

main "$@"
