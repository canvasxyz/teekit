#!/bin/bash
#
# Configures a hostname for an Azure VM for TLS certificate acquisition.
# Usage: ./config_azure.sh
#
# The script will:
# 1. Prompt for an Azure VM name or IP address
# 2. Let user choose between sslip.io (automatic) or a custom domain
# 3. Set the hostname metadata on the VM
# 4. Optionally restart the VM to acquire TLS certificates
#
# Prerequisites:
# - Azure CLI installed and logged in (if using VM name)
#

set -euo pipefail

# Colors for logging
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}STEP: $1${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
}

# Default resource group (same as deploy_azure.sh)
RESOURCE_GROUP="tdx-group"
AZURE_NAME_FILE=".vm_name_azure"

# ============================================================================
# STEP 1: Get VM IP address
# ============================================================================
log_step "Getting VM IP address"

# Check for cached VM name/IP
CACHED_VM_INPUT=""
if [ -f "$AZURE_NAME_FILE" ]; then
    CACHED_VM_INPUT=$(cat "$AZURE_NAME_FILE")
fi

echo ""
if [ -n "$CACHED_VM_INPUT" ]; then
    log_info "Enter an Azure VM name or an IP address directly."
    read -p "Azure VM name or IP address [$CACHED_VM_INPUT]: " VM_INPUT
    if [ -z "$VM_INPUT" ]; then
        VM_INPUT="$CACHED_VM_INPUT"
    fi
else
    log_info "Enter an Azure VM name or an IP address directly."
    read -p "Azure VM name or IP address: " VM_INPUT
fi

if [ -z "$VM_INPUT" ]; then
    log_error "VM name or IP address is required"
    exit 1
fi

# Save for next time
echo "$VM_INPUT" > "$AZURE_NAME_FILE"

# Check if input looks like an IP address
if [[ "$VM_INPUT" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    PUBLIC_IP="$VM_INPUT"
    log_success "Using IP address: $PUBLIC_IP"
else
    # Treat as Azure VM name
    VM_NAME="$VM_INPUT"
    log_info "Looking up public IP for Azure VM: $VM_NAME"

    if ! az account show &>/dev/null; then
        log_error "Not logged into Azure CLI. Please run 'az login' first."
        exit 1
    fi

    PUBLIC_IP=$(az vm show \
        --name "$VM_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --show-details \
        --query publicIps -o tsv 2>/dev/null) || {
        log_error "Failed to get public IP for VM '$VM_NAME' in resource group '$RESOURCE_GROUP'"
        echo ""
        echo "Make sure the VM exists and you have access to it:"
        echo "  az vm list --resource-group $RESOURCE_GROUP -o table"
        exit 1
    }

    if [ -z "$PUBLIC_IP" ] || [ "$PUBLIC_IP" == "None" ]; then
        log_error "VM '$VM_NAME' does not have a public IP address"
        exit 1
    fi

    log_success "Found public IP: $PUBLIC_IP"
fi

# ============================================================================
# STEP 2: Choose hostname type
# ============================================================================
log_step "Configuring hostname"

# Default hostnames
SSLIP_HOSTNAME="${PUBLIC_IP}.sslip.io"
NIP_HOSTNAME="${PUBLIC_IP}.nip.io"

echo ""
log_info "Choose how to configure the hostname for TLS certificates:"
echo ""
echo "  1) Use sslip.io (automatic DNS based on IP address)"
echo "     Hostname will be: $SSLIP_HOSTNAME"
echo ""
echo "  2) Use nip.io (automatic DNS based on IP address)"
echo "     Hostname will be: $NIP_HOSTNAME"
echo ""
echo "  3) Use a custom domain (you manage DNS)"
echo "     You'll need to configure DNS to point to: $PUBLIC_IP"
echo ""
read -p "Enter choice [1]: " HOSTNAME_CHOICE

if [ -z "$HOSTNAME_CHOICE" ] || [ "$HOSTNAME_CHOICE" == "1" ]; then
    HOSTNAME="$SSLIP_HOSTNAME"
    log_success "Using sslip.io hostname: $HOSTNAME"
elif [ "$HOSTNAME_CHOICE" == "2" ]; then
    HOSTNAME="$NIP_HOSTNAME"
    log_success "Using nip.io hostname: $HOSTNAME"
elif [ "$HOSTNAME_CHOICE" == "3" ]; then
    echo ""
    log_info "Enter your custom domain (e.g., myvm.example.com)"
    log_info "Make sure DNS is configured to point this domain to: $PUBLIC_IP"
    read -p "Custom domain: " CUSTOM_HOSTNAME

    if [ -z "$CUSTOM_HOSTNAME" ]; then
        log_error "Custom domain is required"
        exit 1
    fi

    # Basic validation - must look like a hostname
    if [[ ! "$CUSTOM_HOSTNAME" =~ ^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)*$ ]]; then
        log_error "Invalid hostname format: $CUSTOM_HOSTNAME"
        exit 1
    fi

    HOSTNAME="$CUSTOM_HOSTNAME"
    log_success "Using custom hostname: $HOSTNAME"
    echo ""
    log_warning "Remember to configure DNS for '$HOSTNAME' to point to $PUBLIC_IP"
else
    log_error "Invalid choice: $HOSTNAME_CHOICE"
    exit 1
fi

# ============================================================================
# STEP 3: Verify DNS resolution (quick check)
# ============================================================================
log_step "Verifying DNS resolution"

echo ""
log_info "Checking if $HOSTNAME resolves to $PUBLIC_IP..."

RESOLVED_IP=$(dig +short "$HOSTNAME" A 2>/dev/null | head -1 || true)

if [ "$RESOLVED_IP" == "$PUBLIC_IP" ]; then
    log_success "DNS verified: $HOSTNAME -> $PUBLIC_IP"
elif [ -n "$RESOLVED_IP" ]; then
    log_warning "DNS resolves to $RESOLVED_IP instead of $PUBLIC_IP"
    log_info "Proceeding anyway - make sure DNS is configured correctly."
else
    if [[ "$HOSTNAME" == *".sslip.io" ]]; then
        log_warning "Could not verify DNS (sslip.io may be temporarily unavailable)"
        log_info "sslip.io should resolve automatically - proceeding."
    elif [[ "$HOSTNAME" == *".nip.io" ]]; then
        log_warning "Could not verify DNS (nip.io may be temporarily unavailable)"
        log_info "nip.io should resolve automatically - proceeding."
    else
        log_warning "DNS does not resolve yet for $HOSTNAME"
        log_info "Make sure to configure DNS before the VM tries to get certificates."
    fi
fi

# ============================================================================
# STEP 4: Update Azure VM metadata
# ============================================================================
log_step "Updating Azure VM metadata"

# If we only have an IP, prompt for VM name
if [ -z "${VM_NAME:-}" ]; then
    echo ""
    log_info "To set the hostname tag on an Azure VM, enter the VM name."
    log_info "Leave blank to skip this step."
    read -p "Azure VM name (or Enter to skip): " VM_NAME_INPUT

    if [ -n "$VM_NAME_INPUT" ]; then
        VM_NAME="$VM_NAME_INPUT"
    fi
fi

HOSTNAME_TAG_SET=false

if [ -n "${VM_NAME:-}" ]; then
    echo ""
    log_info "This will set the 'hostname' tag on VM '$VM_NAME' to '$HOSTNAME'"
    log_info "The VM will use this hostname for TLS certificates."
    read -p "Set hostname tag on VM? [Y/n]: " SET_HOSTNAME

    if [[ "$SET_HOSTNAME" == "n" || "$SET_HOSTNAME" == "N" ]]; then
        log_info "Skipping hostname tag update"
        echo ""
        echo "You can set it manually later with:"
        echo "  az vm update --name $VM_NAME --resource-group $RESOURCE_GROUP --set tags.hostname=$HOSTNAME"
    else
        log_info "Setting hostname tag on VM '$VM_NAME'..."

        if az vm update \
            --name "$VM_NAME" \
            --resource-group "$RESOURCE_GROUP" \
            --set "tags.hostname=$HOSTNAME" \
            --output none 2>/dev/null; then
            log_success "Set hostname tag: $HOSTNAME"
            HOSTNAME_TAG_SET=true
        else
            log_warning "Failed to set hostname tag on VM"
            echo ""
            echo "You can set it manually with:"
            echo "  az vm update --name $VM_NAME --resource-group $RESOURCE_GROUP --set tags.hostname=$HOSTNAME"
        fi
    fi
else
    log_info "Skipping Azure VM metadata update (no VM name provided)"
fi

# ============================================================================
# STEP 5: Reboot VM (if hostname was set)
# ============================================================================
if [ "$HOSTNAME_TAG_SET" = true ]; then
    echo ""
    log_info "The VM needs to reboot to pick up the new hostname configuration."
    log_info "This will enable TLS certificate acquisition on next boot."
    read -p "Reboot VM now? [Y/n]: " REBOOT_VM

    if [[ "$REBOOT_VM" == "n" || "$REBOOT_VM" == "N" ]]; then
        log_info "Skipping reboot"
        echo ""
        echo "You can reboot the VM manually with:"
        echo "  az vm restart --name $VM_NAME --resource-group $RESOURCE_GROUP"
    else
        log_info "Rebooting VM '$VM_NAME'..."

        if az vm restart \
            --name "$VM_NAME" \
            --resource-group "$RESOURCE_GROUP" \
            --output none 2>/dev/null; then
            log_success "VM reboot initiated"
            log_info "The VM will acquire a TLS certificate for $HOSTNAME after reboot."

            # Wait for HTTPS to come up
            echo ""
            log_info "Waiting for HTTPS to become available at https://$HOSTNAME ..."
            log_info "You can press Ctrl+C to exit at any time."
            echo ""

            HTTPS_URL="https://$HOSTNAME"
            HTTPS_MAX_ATTEMPTS=120  # 30 minutes max (120 * 15s)
            HTTPS_ATTEMPT=0
            HTTPS_SLEEP=15

            while [ $HTTPS_ATTEMPT -lt $HTTPS_MAX_ATTEMPTS ]; do
                HTTPS_ATTEMPT=$((HTTPS_ATTEMPT + 1))

                # Try to connect via HTTPS - any HTTP response means TLS is working
                # (we accept 2xx, 3xx, 4xx, 5xx - the server may return 404 on root path)
                if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$HTTPS_URL" 2>/dev/null | grep -qE "^[2345]"; then
                    echo ""
                    log_success "HTTPS is up!"
                    log_success "$HTTPS_URL is now accessible"
                    break
                fi

                echo -ne "\r${YELLOW}[WAITING]${NC} Attempt $HTTPS_ATTEMPT: Waiting for HTTPS... (${HTTPS_SLEEP}s intervals)    "
                sleep $HTTPS_SLEEP
            done

            if [ $HTTPS_ATTEMPT -ge $HTTPS_MAX_ATTEMPTS ]; then
                echo ""
                log_warning "HTTPS check timed out after $((HTTPS_MAX_ATTEMPTS * HTTPS_SLEEP / 60)) minutes"
                log_info "The VM may still be starting up. Check manually:"
                log_info "  curl -v $HTTPS_URL"
            fi
        else
            log_warning "Failed to reboot VM"
            echo ""
            echo "You can reboot the VM manually with:"
            echo "  az vm restart --name $VM_NAME --resource-group $RESOURCE_GROUP"
        fi
    fi
fi

# ============================================================================
# Configuration Complete
# ============================================================================
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║             CONFIGURATION COMPLETE                             ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Hostname:       $HOSTNAME"
echo "IP Address:     $PUBLIC_IP"
echo ""
echo "Test the hostname:"
echo "  dig $HOSTNAME"
echo "  curl http://$HOSTNAME:3001/healthz"
echo ""
if [ -n "${VM_NAME:-}" ]; then
echo "View serial console output:"
echo "  az serial-console connect --name $VM_NAME --resource-group $RESOURCE_GROUP"
echo ""
fi
