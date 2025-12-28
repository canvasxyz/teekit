#!/bin/bash
#
# Lists currently active Azure resources in the TDX resource group.
# Usage: ./ls_azure.sh
#
# Lists the following resources:
# - Virtual Machines (with status, IP, size)
# - Disks
# - Network Interfaces
# - Public IPs
# - Network Security Groups
# - Storage Account and VHD blobs
# - Azure Compute Gallery, Image Definitions, and Image Versions
#
# Prerequisites:
# - Azure CLI installed and logged in (az login)
#

set -euo pipefail

# Configuration
RESOURCE_GROUP_FILE=".resourcegroup"
if [ -f "$RESOURCE_GROUP_FILE" ]; then
    RESOURCE_GROUP=$(cat "$RESOURCE_GROUP_FILE")
else
    RESOURCE_GROUP="tdx-group"
fi
GALLERY_NAME="tdxGallery"
CONTAINER_NAME="vhds"

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
echo ""
log_info "Resource Group: $RESOURCE_GROUP"

# ============================================================================
# Virtual Machines
# ============================================================================
log_section "VIRTUAL MACHINES"

VM_COUNT=$(az vm list --resource-group "$RESOURCE_GROUP" --query "length(@)" -o tsv 2>/dev/null || echo "0")

if [ "$VM_COUNT" -eq 0 ]; then
    log_warning "No VMs found"
else
    log_success "Found $VM_COUNT VM(s)"
    echo ""
    printf "${GREEN}%-20s %-12s %-20s %-20s %-15s${NC}\n" "NAME" "STATUS" "PUBLIC IP" "SIZE" "LOCATION"
    printf "%s\n" "$(printf '%.0s-' {1..90})"

    az vm list --resource-group "$RESOURCE_GROUP" --show-details \
        --query "[].{Name:name, Status:powerState, PublicIP:publicIps, Size:hardwareProfile.vmSize, Location:location, Hostname:tags.hostname}" -o tsv 2>/dev/null | \
    while IFS=$'\t' read -r name status public_ip size location hostname; do
        # Handle empty public IP
        if [ -z "$public_ip" ] || [ "$public_ip" = "None" ]; then
            public_ip="-"
        fi

        # Handle empty hostname
        if [ -z "$hostname" ] || [ "$hostname" = "None" ]; then
            hostname=""
        fi

        # Color status
        if [[ "$status" == *"running"* ]]; then
            status_display="${GREEN}${status}${NC}"
        elif [[ "$status" == *"stopped"* ]] || [[ "$status" == *"deallocated"* ]]; then
            status_display="${YELLOW}${status}${NC}"
        else
            status_display="${RED}${status}${NC}"
        fi

        # Build public IP display with hostname underneath if available
        if [ -n "$hostname" ]; then
            ip_display=$(printf "%s\n%s" "$public_ip" "$hostname")
        else
            ip_display="$public_ip"
        fi

        printf "%-20s %-23b %-20s %-20s %-15s\n" "$name" "$status_display" "$public_ip" "$size" "$location"
        if [ -n "$hostname" ]; then
            port=3001
            IFS=',' read -ra hostnames <<< "$hostname"
            for h in "${hostnames[@]}"; do
                h=$(echo "$h" | xargs)  # trim whitespace
                printf "%-20s %-12s ${CYAN}%-40s${NC}\n" "" "" "http://$h:$port"
                printf "%-20s %-12s ${CYAN}%-40s${NC}\n" "" "" "https://$h"
                port=$((port + 1))
            done
        fi
    done
fi

# ============================================================================
# Disks
# ============================================================================
log_section "DISKS"

DISK_COUNT=$(az disk list --resource-group "$RESOURCE_GROUP" --query "length(@)" -o tsv 2>/dev/null || echo "0")

if [ "$DISK_COUNT" -eq 0 ]; then
    log_warning "No disks found"
else
    log_success "Found $DISK_COUNT disk(s)"
    echo ""
    printf "${GREEN}%-70s %-15s %-12s %-20s${NC}\n" "NAME" "SIZE (GB)" "STATE" "ATTACHED TO"
    printf "%s\n" "$(printf '%.0s-' {1..120})"

    az disk list --resource-group "$RESOURCE_GROUP" \
        --query "[].{Name:name, Size:diskSizeGb, State:diskState, ManagedBy:managedBy}" -o tsv 2>/dev/null | \
    while IFS=$'\t' read -r name size state managed_by; do
        # Extract VM name from managedBy path
        if [ -z "$managed_by" ] || [ "$managed_by" = "None" ]; then
            attached_to="-"
        else
            attached_to=$(basename "$managed_by")
        fi

        printf "%-70s %-15s %-12s %-20s\n" "$name" "$size" "$state" "$attached_to"
    done
fi

# ============================================================================
# Network Interfaces
# ============================================================================
log_section "NETWORK INTERFACES"

NIC_COUNT=$(az network nic list --resource-group "$RESOURCE_GROUP" --query "length(@)" -o tsv 2>/dev/null || echo "0")

if [ "$NIC_COUNT" -eq 0 ]; then
    log_warning "No network interfaces found"
else
    log_success "Found $NIC_COUNT network interface(s)"
    echo ""
    printf "${GREEN}%-40s %-18s %-20s${NC}\n" "NAME" "PRIVATE IP" "ATTACHED TO"
    printf "%s\n" "$(printf '%.0s-' {1..80})"

    az network nic list --resource-group "$RESOURCE_GROUP" \
        --query "[].{Name:name, PrivateIP:ipConfigurations[0].privateIPAddress, VM:virtualMachine.id}" -o tsv 2>/dev/null | \
    while IFS=$'\t' read -r name private_ip vm_id; do
        if [ -z "$vm_id" ] || [ "$vm_id" = "None" ]; then
            attached_to="-"
        else
            attached_to=$(basename "$vm_id")
        fi

        printf "%-40s %-18s %-20s\n" "$name" "$private_ip" "$attached_to"
    done
fi

# ============================================================================
# Public IPs
# ============================================================================
log_section "PUBLIC IPS"

PIP_COUNT=$(az network public-ip list --resource-group "$RESOURCE_GROUP" --query "length(@)" -o tsv 2>/dev/null || echo "0")

if [ "$PIP_COUNT" -eq 0 ]; then
    log_warning "No public IPs found"
else
    log_success "Found $PIP_COUNT public IP(s)"
    echo ""
    printf "${GREEN}%-40s %-18s %-15s${NC}\n" "NAME" "IP ADDRESS" "ALLOCATION"
    printf "%s\n" "$(printf '%.0s-' {1..75})"

    az network public-ip list --resource-group "$RESOURCE_GROUP" \
        --query "[].{Name:name, IP:ipAddress, Allocation:publicIPAllocationMethod}" -o tsv 2>/dev/null | \
    while IFS=$'\t' read -r name ip allocation; do
        if [ -z "$ip" ] || [ "$ip" = "None" ]; then
            ip="-"
        fi

        printf "%-40s %-18s %-15s\n" "$name" "$ip" "$allocation"
    done
fi

# ============================================================================
# Network Security Groups
# ============================================================================
log_section "NETWORK SECURITY GROUPS"

NSG_COUNT=$(az network nsg list --resource-group "$RESOURCE_GROUP" --query "length(@)" -o tsv 2>/dev/null || echo "0")

if [ "$NSG_COUNT" -eq 0 ]; then
    log_warning "No network security groups found"
else
    log_success "Found $NSG_COUNT NSG(s)"
    echo ""
    printf "${GREEN}%-40s %-15s${NC}\n" "NAME" "RULES COUNT"
    printf "%s\n" "$(printf '%.0s-' {1..55})"

    az network nsg list --resource-group "$RESOURCE_GROUP" \
        --query "[].{Name:name, Rules:length(securityRules)}" -o tsv 2>/dev/null | \
    while IFS=$'\t' read -r name rules; do
        printf "%-40s %-15s\n" "$name" "$rules"
    done
fi

# ============================================================================
# Storage Account and VHD Blobs
# ============================================================================
log_section "STORAGE ACCOUNT & VHD BLOBS"

STORAGE_ACCOUNT_FILE=".storageaccount"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORAGE_FILE_PATH="$SCRIPT_DIR/../$STORAGE_ACCOUNT_FILE"

# Check multiple locations for .storageaccount file
if [ ! -f "$STORAGE_FILE_PATH" ]; then
    STORAGE_FILE_PATH="$SCRIPT_DIR/$STORAGE_ACCOUNT_FILE"
fi
if [ ! -f "$STORAGE_FILE_PATH" ]; then
    STORAGE_FILE_PATH=".storageaccount"
fi

if [ ! -f "$STORAGE_FILE_PATH" ]; then
    log_warning "No .storageaccount file found (created by deploy_azure.sh)"
else
    STORAGE_ACCT=$(cat "$STORAGE_FILE_PATH")
    log_info "Storage Account: $STORAGE_ACCT"

    if ! az storage account show --name "$STORAGE_ACCT" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
        log_warning "Storage account '$STORAGE_ACCT' does not exist"
    else
        log_success "Storage account exists"

        # List VHD blobs
        if az storage container show --account-name "$STORAGE_ACCT" --name "$CONTAINER_NAME" &>/dev/null; then
            BLOBS=$(az storage blob list \
                --account-name "$STORAGE_ACCT" \
                --container-name "$CONTAINER_NAME" \
                --auth-mode login \
                --query "[?ends_with(name, '.vhd')].{Name:name, Size:properties.contentLength}" -o tsv 2>/dev/null || echo "")

            if [ -z "$BLOBS" ]; then
                log_info "No VHD blobs in container '$CONTAINER_NAME'"
            else
                BLOB_COUNT=$(echo "$BLOBS" | wc -l)
                log_success "Found $BLOB_COUNT VHD blob(s) in container '$CONTAINER_NAME'"
                echo ""
                printf "${GREEN}%-60s %-15s${NC}\n" "BLOB NAME" "SIZE"
                printf "%s\n" "$(printf '%.0s-' {1..75})"

                echo "$BLOBS" | while IFS=$'\t' read -r name size; do
                    # Convert size to human readable
                    if [ -n "$size" ] && [ "$size" != "None" ]; then
                        size_hr=$(numfmt --to=iec-i --suffix=B "$size" 2>/dev/null || echo "$size")
                    else
                        size_hr="-"
                    fi
                    printf "%-60s %-15s\n" "$name" "$size_hr"
                done
            fi
        else
            log_info "Container '$CONTAINER_NAME' does not exist"
        fi
    fi
fi

# ============================================================================
# Azure Compute Gallery
# ============================================================================
log_section "AZURE COMPUTE GALLERY"

if ! az sig show --resource-group "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" &>/dev/null; then
    log_warning "Gallery '$GALLERY_NAME' does not exist"
else
    log_success "Gallery '$GALLERY_NAME' exists"

    # List image definitions
    IMAGE_DEFS=$(az sig image-definition list \
        --resource-group "$RESOURCE_GROUP" \
        --gallery-name "$GALLERY_NAME" \
        --query "[].name" -o tsv 2>/dev/null || echo "")

    if [ -z "$IMAGE_DEFS" ]; then
        log_info "No image definitions found"
    else
        DEF_COUNT=$(echo "$IMAGE_DEFS" | wc -l)
        log_success "Found $DEF_COUNT image definition(s)"
        echo ""

        for IMAGE_DEF in $IMAGE_DEFS; do
            echo -e "${BLUE}Image Definition: ${NC}$IMAGE_DEF"

            # List versions for this definition
            VERSIONS=$(az sig image-version list \
                --resource-group "$RESOURCE_GROUP" \
                --gallery-name "$GALLERY_NAME" \
                --gallery-image-definition "$IMAGE_DEF" \
                --query "[].{Name:name, State:provisioningState, Published:publishingProfile.publishedDate}" -o tsv 2>/dev/null || echo "")

            if [ -z "$VERSIONS" ]; then
                echo "  No image versions"
            else
                VERSION_COUNT=$(echo "$VERSIONS" | wc -l)
                echo "  Versions: $VERSION_COUNT"
                printf "  ${GREEN}%-15s %-15s %-25s${NC}\n" "VERSION" "STATE" "PUBLISHED DATE"
                printf "  %s\n" "$(printf '%.0s-' {1..55})"

                echo "$VERSIONS" | while IFS=$'\t' read -r version state published; do
                    # Truncate published date if needed
                    if [ -n "$published" ] && [ "$published" != "None" ]; then
                        published="${published:0:19}"
                    else
                        published="-"
                    fi
                    printf "  %-15s %-15s %-25s\n" "$version" "$state" "$published"
                done
            fi
            echo ""
        done
    fi
fi

# ============================================================================
# Summary
# ============================================================================
log_section "USEFUL COMMANDS"

echo ""
echo "VM Operations:"
echo "  az serial-console connect --name <VM_NAME> --resource-group $RESOURCE_GROUP"
echo "  az vm boot-diagnostics get-boot-log --name <VM_NAME> --resource-group $RESOURCE_GROUP"
echo "  az vm start --name <VM_NAME> --resource-group $RESOURCE_GROUP"
echo "  az vm stop --name <VM_NAME> --resource-group $RESOURCE_GROUP"
echo "  az vm delete --name <VM_NAME> --resource-group $RESOURCE_GROUP --yes"
echo "  ssh root@<PUBLIC_IP>"
echo ""
echo "Cleanup all resources:"
echo "  ./cleanup_azure.sh --dry-run  # Preview what will be deleted"
echo "  ./cleanup_azure.sh            # Actually delete resources"
echo ""
