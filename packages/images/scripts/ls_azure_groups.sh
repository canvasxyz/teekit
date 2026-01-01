#!/bin/bash
#
# Lists all Azure resource groups and their VMs with public IPs.
# Usage: ./ls_azure_groups.sh
#
# Lists the following:
# - All resource groups
# - All VMs across all resource groups (with public IPs)
#
# Prerequisites:
# - Azure CLI installed and logged in (az login)
#

set -euo pipefail

# Colors for logging
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
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

log_section() {
    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}$1${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
}

# ============================================================================
# Verify Azure CLI login
# ============================================================================
log_info "Verifying Azure CLI login..."

if ! az account show &>/dev/null; then
    log_error "Not logged into Azure CLI. Please run 'az login' first."
    exit 1
fi

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
log_success "Logged in to Azure (Subscription: $SUBSCRIPTION_ID)"

# ============================================================================
# Resource Groups
# ============================================================================
log_section "RESOURCE GROUPS"

GROUP_COUNT=$(az group list --query "length(@)" -o tsv 2>/dev/null || echo "0")

if [ "$GROUP_COUNT" -eq 0 ]; then
    log_warning "No resource groups found"
else
    log_success "Found $GROUP_COUNT resource group(s)"
    echo ""
    printf "${GREEN}%-40s %-20s %-20s${NC}\n" "NAME" "LOCATION" "STATE"
    printf "%s\n" "$(printf '%.0s-' {1..80})"

    az group list --query "[].{Name:name, Location:location, State:properties.provisioningState}" -o tsv 2>/dev/null | \
    while IFS=$'\t' read -r name location state; do
        printf "%-40s %-20s %-20s\n" "$name" "$location" "$state"
    done
fi

# ============================================================================
# Virtual Machines (across all resource groups)
# ============================================================================
log_section "VIRTUAL MACHINES (ALL GROUPS)"

VM_COUNT=$(az vm list --query "length(@)" -o tsv 2>/dev/null || echo "0")

if [ "$VM_COUNT" -eq 0 ]; then
    log_warning "No VMs found"
else
    log_success "Found $VM_COUNT VM(s)"
    echo ""
    printf "${GREEN}%-25s %-30s %-18s %-12s${NC}\n" "NAME" "RESOURCE GROUP" "PUBLIC IP" "STATUS"
    printf "%s\n" "$(printf '%.0s-' {1..90})"

    az vm list --show-details \
        --query "sort_by([], &resourceGroup)[].{Name:name, ResourceGroup:resourceGroup, PublicIP:publicIps, Status:powerState}" -o tsv 2>/dev/null | \
    while IFS=$'\t' read -r name resource_group public_ip status; do
        # Handle empty public IP
        if [ -z "$public_ip" ] || [ "$public_ip" = "None" ]; then
            public_ip="-"
        fi

        # Handle empty status
        if [ -z "$status" ] || [ "$status" = "None" ]; then
            status="-"
        fi

        # Color status
        if [[ "$status" == *"running"* ]]; then
            status_display="${GREEN}${status}${NC}"
        elif [[ "$status" == *"stopped"* ]] || [[ "$status" == *"deallocated"* ]]; then
            status_display="${YELLOW}${status}${NC}"
        else
            status_display="${RED}${status}${NC}"
        fi

        printf "%-25s %-30s %-18s %-23b\n" "$name" "$resource_group" "$public_ip" "$status_display"
    done
fi

# ============================================================================
# Summary
# ============================================================================
log_section "USEFUL COMMANDS"

echo ""
echo "Inspect a resource group:"
echo "  npm run ls:az -- <GROUP_NAME>"
echo ""
echo "Delete a resource group (deletes all resources in it):"
echo "  az group delete --name <GROUP_NAME> --yes"
echo ""
