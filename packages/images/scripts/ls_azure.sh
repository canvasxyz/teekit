#!/bin/bash
#
# Lists currently active Azure VMs in the TDX resource group.
# Usage: ./ls_azure.sh
#
# Prerequisites:
# - Azure CLI installed and logged in (az login)
#

set -euo pipefail

# Configuration
RESOURCE_GROUP="tdx-group"

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

# ============================================================================
# STEP 1: Verify Azure CLI login
# ============================================================================
log_info "Verifying Azure CLI login..."

if ! az account show &>/dev/null; then
    log_error "Not logged into Azure CLI. Please run 'az login' first."
    exit 1
fi

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
log_success "Logged in to Azure (Subscription: $SUBSCRIPTION_ID)"

# ============================================================================
# STEP 2: List VMs in the resource group
# ============================================================================
echo ""
log_info "Listing VMs in resource group: $RESOURCE_GROUP"
echo ""

# Get VM list with details
VM_COUNT=$(az vm list --resource-group "$RESOURCE_GROUP" --query "length(@)" -o tsv 2>/dev/null || echo "0")

if [ "$VM_COUNT" -eq 0 ]; then
    log_warning "No VMs found in resource group '$RESOURCE_GROUP'"
    exit 0
fi

log_success "Found $VM_COUNT VM(s)"
echo ""

# Print header
printf "${GREEN}%-30s %-15s %-16s %-15s %-20s${NC}\n" "NAME" "STATUS" "PUBLIC IP" "SIZE" "LOCATION"
printf "%s\n" "$(printf '%.0s-' {1..100})"

# List VMs with details
az vm list --resource-group "$RESOURCE_GROUP" --show-details --query "[].{Name:name, Status:powerState, PublicIP:publicIps, Size:hardwareProfile.vmSize, Location:location}" -o tsv 2>/dev/null | while IFS=$'\t' read -r name status public_ip size location; do
    # Handle empty public IP
    if [ -z "$public_ip" ] || [ "$public_ip" = "None" ]; then
        public_ip="-"
    fi

    # Color status
    if [[ "$status" == *"running"* ]]; then
        status_display="${GREEN}${status}${NC}"
    elif [[ "$status" == *"stopped"* ]] || [[ "$status" == *"deallocated"* ]]; then
        status_display="${YELLOW}${status}${NC}"
    else
        status_display="${RED}${status}${NC}"
    fi

    printf "%-30s %-15b %-16s %-15s %-20s\n" "$name" "$status_display" "$public_ip" "$size" "$location"
done

echo ""
echo -e "${BLUE}Useful commands:${NC}"
echo "  Connect via serial console:"
echo "    az serial-console connect --name <VM_NAME> --resource-group $RESOURCE_GROUP"
echo ""
echo "  View boot logs:"
echo "    az vm boot-diagnostics get-boot-log --name <VM_NAME> --resource-group $RESOURCE_GROUP"
echo ""
echo "  Start/Stop VM:"
echo "    az vm start --name <VM_NAME> --resource-group $RESOURCE_GROUP"
echo "    az vm stop --name <VM_NAME> --resource-group $RESOURCE_GROUP"
echo ""
echo "  Delete VM:"
echo "    az vm delete --name <VM_NAME> --resource-group $RESOURCE_GROUP --yes"
