#!/bin/bash
#
# Cleans up Azure resources created by deploy_azure.sh
# Usage: ./cleanup_azure.sh [--dry-run]
#
# This script will:
# 1. Delete all VMs matching "kettle-*" pattern
# 2. Delete associated disks, network interfaces, NSGs, and public IPs
# 3. Delete all image versions in tdxGallery
# 4. Delete all image definitions in tdxGallery
# 5. Delete all VHD blobs from the cached storage account
#
# Prerequisites:
# - Azure CLI installed and logged in (az login)
# - Resource group 'tdx-group' exists
#
# NOTE: The following resources are NOT cleaned up by this script:
# - The resource group itself (tdx-group)
# - The storage account (cached in .storageaccount) - reusable across deployments
# - The blob container "vhds" - reusable across deployments
# - The Azure Compute Gallery (tdxGallery) itself - reusable across deployments
# - Virtual networks and subnets - may be shared infrastructure
# - Role assignments created for storage access
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
VM_PATTERN="kettle-"

# Parse arguments
DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
    DRY_RUN=true
fi

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

log_dry_run() {
    echo -e "${CYAN}[DRY-RUN]${NC} Would: $1"
}

log_step() {
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}STEP: $1${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
}

# ============================================================================
# Header
# ============================================================================
echo ""
log_info "Azure TDX Resource Cleanup"
log_info "=========================="
log_info "Resource Group: $RESOURCE_GROUP"
log_info "Gallery Name: $GALLERY_NAME"
log_info "VM Pattern: ${VM_PATTERN}*"
if [ "$DRY_RUN" = true ]; then
    log_warning "DRY-RUN MODE: No resources will be deleted"
else
    echo ""
    log_warning "This will delete all deployment-specific Azure resources including VMs,"
    log_warning "disks, images, NICs, and blobs. Use --dry-run to see what would be deleted."
    echo ""
    read -p "Are you sure you want to proceed? [y/N]: " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        log_info "Aborted by user."
        exit 0
    fi
fi
echo ""

# ============================================================================
# STEP 1: Verify Azure CLI login
# ============================================================================
log_step "Verifying Azure CLI login"

if ! az account show &>/dev/null; then
    log_error "Not logged into Azure CLI. Please run 'az login' first."
    exit 1
fi

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
log_success "Logged in to Azure (Subscription: $SUBSCRIPTION_ID)"

# ============================================================================
# STEP 2: Find and delete VMs matching pattern
# ============================================================================
log_step "Finding VMs matching pattern '${VM_PATTERN}*'"

VM_LIST=$(az vm list --resource-group "$RESOURCE_GROUP" --query "[?starts_with(name, '${VM_PATTERN}')].name" -o tsv 2>/dev/null || echo "")

if [ -z "$VM_LIST" ]; then
    log_info "No VMs found matching pattern '${VM_PATTERN}*'"
else
    VM_COUNT=$(echo "$VM_LIST" | wc -l)
    log_info "Found $VM_COUNT VM(s) to delete:"
    echo "$VM_LIST" | while read -r vm; do
        # Get the VM's public IP address
        VM_IP=$(az vm list-ip-addresses --name "$vm" --resource-group "$RESOURCE_GROUP" \
            --query "[0].virtualMachine.network.publicIpAddresses[0].ipAddress" -o tsv 2>/dev/null || echo "")
        if [ -n "$VM_IP" ]; then
            echo "  - $vm (IP: $VM_IP)"
        else
            echo "  - $vm (IP: <none>)"
        fi
    done
    echo ""

    # Get associated resources for each VM before deletion
    declare -A NIC_LIST
    declare -A DISK_LIST
    declare -A NSG_LIST
    declare -A PIP_LIST

    for VM_NAME in $VM_LIST; do
        log_info "Collecting associated resources for VM: $VM_NAME"

        # Get network interface
        NIC_ID=$(az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" \
            --query "networkProfile.networkInterfaces[0].id" -o tsv 2>/dev/null || echo "")
        if [ -n "$NIC_ID" ]; then
            NIC_NAME=$(basename "$NIC_ID")
            NIC_LIST["$NIC_NAME"]=1

            # Get NSG associated with NIC
            NSG_ID=$(az network nic show --ids "$NIC_ID" \
                --query "networkSecurityGroup.id" -o tsv 2>/dev/null || echo "")
            if [ -n "$NSG_ID" ] && [ "$NSG_ID" != "None" ]; then
                NSG_NAME=$(basename "$NSG_ID")
                NSG_LIST["$NSG_NAME"]=1
            fi

            # Get public IP associated with NIC
            PIP_ID=$(az network nic show --ids "$NIC_ID" \
                --query "ipConfigurations[0].publicIPAddress.id" -o tsv 2>/dev/null || echo "")
            if [ -n "$PIP_ID" ] && [ "$PIP_ID" != "None" ]; then
                PIP_NAME=$(basename "$PIP_ID")
                PIP_LIST["$PIP_NAME"]=1
            fi
        fi

        # Get OS disk
        OS_DISK=$(az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" \
            --query "storageProfile.osDisk.name" -o tsv 2>/dev/null || echo "")
        if [ -n "$OS_DISK" ]; then
            DISK_LIST["$OS_DISK"]=1
        fi

        # Get data disks
        DATA_DISKS=$(az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" \
            --query "storageProfile.dataDisks[].name" -o tsv 2>/dev/null || echo "")
        for disk in $DATA_DISKS; do
            DISK_LIST["$disk"]=1
        done
    done

    # Delete VMs
    for VM_NAME in $VM_LIST; do
        if [ "$DRY_RUN" = true ]; then
            log_dry_run "Delete VM: $VM_NAME"
        else
            log_info "Deleting VM: $VM_NAME"
            if az vm delete --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" --yes --no-wait 2>/dev/null; then
                log_success "Deletion initiated for VM: $VM_NAME"
            else
                log_warning "Failed to delete VM: $VM_NAME (may not exist)"
            fi
        fi
    done

    # Wait for VM deletions to complete before cleaning up associated resources
    if [ "$DRY_RUN" = false ]; then
        log_info "Waiting for VM deletions to complete..."
        sleep 30
    fi

    # Delete network interfaces
    if [ ${#NIC_LIST[@]} -gt 0 ]; then
        log_info "Cleaning up ${#NIC_LIST[@]} network interface(s)..."
        for NIC_NAME in "${!NIC_LIST[@]}"; do
            if [ "$DRY_RUN" = true ]; then
                log_dry_run "Delete NIC: $NIC_NAME"
            else
                log_info "Deleting NIC: $NIC_NAME"
                if az network nic delete --name "$NIC_NAME" --resource-group "$RESOURCE_GROUP" 2>/dev/null; then
                    log_success "Deleted NIC: $NIC_NAME"
                else
                    log_warning "Failed to delete NIC: $NIC_NAME (may already be deleted or still in use)"
                fi
            fi
        done
    fi

    # Delete disks
    if [ ${#DISK_LIST[@]} -gt 0 ]; then
        log_info "Cleaning up ${#DISK_LIST[@]} disk(s)..."
        for DISK_NAME in "${!DISK_LIST[@]}"; do
            if [ "$DRY_RUN" = true ]; then
                log_dry_run "Delete disk: $DISK_NAME"
            else
                log_info "Deleting disk: $DISK_NAME"
                if az disk delete --name "$DISK_NAME" --resource-group "$RESOURCE_GROUP" --yes 2>/dev/null; then
                    log_success "Deleted disk: $DISK_NAME"
                else
                    log_warning "Failed to delete disk: $DISK_NAME (may already be deleted)"
                fi
            fi
        done
    fi

    # Delete public IPs
    if [ ${#PIP_LIST[@]} -gt 0 ]; then
        log_info "Cleaning up ${#PIP_LIST[@]} public IP(s)..."
        for PIP_NAME in "${!PIP_LIST[@]}"; do
            if [ "$DRY_RUN" = true ]; then
                log_dry_run "Delete public IP: $PIP_NAME"
            else
                log_info "Deleting public IP: $PIP_NAME"
                if az network public-ip delete --name "$PIP_NAME" --resource-group "$RESOURCE_GROUP" 2>/dev/null; then
                    log_success "Deleted public IP: $PIP_NAME"
                else
                    log_warning "Failed to delete public IP: $PIP_NAME (may already be deleted)"
                fi
            fi
        done
    fi

    # Delete NSGs
    if [ ${#NSG_LIST[@]} -gt 0 ]; then
        log_info "Cleaning up ${#NSG_LIST[@]} network security group(s)..."
        for NSG_NAME in "${!NSG_LIST[@]}"; do
            if [ "$DRY_RUN" = true ]; then
                log_dry_run "Delete NSG: $NSG_NAME"
            else
                log_info "Deleting NSG: $NSG_NAME"
                if az network nsg delete --name "$NSG_NAME" --resource-group "$RESOURCE_GROUP" 2>/dev/null; then
                    log_success "Deleted NSG: $NSG_NAME"
                else
                    log_warning "Failed to delete NSG: $NSG_NAME (may already be deleted or in use)"
                fi
            fi
        done
    fi
fi

# ============================================================================
# STEP 3: Delete image versions from gallery
# ============================================================================
log_step "Finding image versions in gallery '$GALLERY_NAME'"

# Check if gallery exists
if ! az sig show --resource-group "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" &>/dev/null; then
    log_info "Gallery '$GALLERY_NAME' does not exist, skipping image cleanup"
else
    # Get all image definitions in the gallery
    IMAGE_DEFS=$(az sig image-definition list \
        --resource-group "$RESOURCE_GROUP" \
        --gallery-name "$GALLERY_NAME" \
        --query "[].name" -o tsv 2>/dev/null || echo "")

    if [ -z "$IMAGE_DEFS" ]; then
        log_info "No image definitions found in gallery"
    else
        for IMAGE_DEF in $IMAGE_DEFS; do
            log_info "Processing image definition: $IMAGE_DEF"

            # Get all versions for this definition
            IMAGE_VERSIONS=$(az sig image-version list \
                --resource-group "$RESOURCE_GROUP" \
                --gallery-name "$GALLERY_NAME" \
                --gallery-image-definition "$IMAGE_DEF" \
                --query "[].name" -o tsv 2>/dev/null || echo "")

            if [ -z "$IMAGE_VERSIONS" ]; then
                log_info "  No image versions found for $IMAGE_DEF"
            else
                VERSION_COUNT=$(echo "$IMAGE_VERSIONS" | wc -l)
                log_info "  Found $VERSION_COUNT image version(s) to delete"

                for VERSION in $IMAGE_VERSIONS; do
                    if [ "$DRY_RUN" = true ]; then
                        log_dry_run "Delete image version: $IMAGE_DEF/$VERSION"
                    else
                        log_info "  Deleting image version: $VERSION"
                        if az sig image-version delete \
                            --resource-group "$RESOURCE_GROUP" \
                            --gallery-name "$GALLERY_NAME" \
                            --gallery-image-definition "$IMAGE_DEF" \
                            --gallery-image-version "$VERSION" 2>/dev/null; then
                            log_success "  Deleted image version: $VERSION"
                        else
                            log_warning "  Failed to delete image version: $VERSION"
                        fi
                    fi
                done
            fi

            # Delete the image definition itself after all versions are deleted
            if [ "$DRY_RUN" = true ]; then
                log_dry_run "Delete image definition: $IMAGE_DEF"
            else
                log_info "  Deleting image definition: $IMAGE_DEF"
                # Wait a bit for version deletions to propagate
                sleep 5
                if az sig image-definition delete \
                    --resource-group "$RESOURCE_GROUP" \
                    --gallery-name "$GALLERY_NAME" \
                    --gallery-image-definition "$IMAGE_DEF" 2>/dev/null; then
                    log_success "  Deleted image definition: $IMAGE_DEF"
                else
                    log_warning "  Failed to delete image definition: $IMAGE_DEF (may have remaining versions)"
                fi
            fi
        done
    fi
fi

# ============================================================================
# STEP 4: Delete VHD blobs from storage account
# ============================================================================
log_step "Cleaning up VHD blobs from storage account"

STORAGE_ACCOUNT_FILE=".storageaccount"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORAGE_FILE_PATH="$SCRIPT_DIR/../$STORAGE_ACCOUNT_FILE"

# Also check the images directory
if [ ! -f "$STORAGE_FILE_PATH" ]; then
    STORAGE_FILE_PATH="$SCRIPT_DIR/$STORAGE_ACCOUNT_FILE"
fi

# Also check current directory
if [ ! -f "$STORAGE_FILE_PATH" ]; then
    STORAGE_FILE_PATH=".storageaccount"
fi

if [ ! -f "$STORAGE_FILE_PATH" ]; then
    log_warning "No .storageaccount file found, skipping blob cleanup"
    log_info "Storage account file is created by deploy_azure.sh on first deployment"
else
    STORAGE_ACCT=$(cat "$STORAGE_FILE_PATH")
    log_info "Found storage account: $STORAGE_ACCT"

    # Verify storage account exists
    if ! az storage account show --name "$STORAGE_ACCT" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
        log_warning "Storage account '$STORAGE_ACCT' does not exist, skipping blob cleanup"
    else
        # Check if container exists
        if ! az storage container show --account-name "$STORAGE_ACCT" --name "$CONTAINER_NAME" &>/dev/null; then
            log_info "Container '$CONTAINER_NAME' does not exist, no blobs to clean up"
        else
            # List all VHD blobs
            BLOBS=$(az storage blob list \
                --account-name "$STORAGE_ACCT" \
                --container-name "$CONTAINER_NAME" \
                --auth-mode login \
                --query "[?ends_with(name, '.vhd')].name" -o tsv 2>/dev/null || echo "")

            if [ -z "$BLOBS" ]; then
                log_info "No VHD blobs found in container '$CONTAINER_NAME'"
            else
                BLOB_COUNT=$(echo "$BLOBS" | wc -l)
                log_info "Found $BLOB_COUNT VHD blob(s) to delete:"
                echo "$BLOBS" | while read -r blob; do
                    echo "  - $blob"
                done
                echo ""

                for BLOB_NAME in $BLOBS; do
                    if [ "$DRY_RUN" = true ]; then
                        log_dry_run "Delete blob: $BLOB_NAME"
                    else
                        log_info "Deleting blob: $BLOB_NAME"
                        if az storage blob delete \
                            --account-name "$STORAGE_ACCT" \
                            --container-name "$CONTAINER_NAME" \
                            --name "$BLOB_NAME" \
                            --auth-mode login 2>/dev/null; then
                            log_success "Deleted blob: $BLOB_NAME"
                        else
                            log_warning "Failed to delete blob: $BLOB_NAME"
                        fi
                    fi
                done
            fi
        fi
    fi
fi

# ============================================================================
# Cleanup Complete
# ============================================================================
echo ""
if [ "$DRY_RUN" = true ]; then
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║             DRY-RUN COMPLETE                                   ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "No resources were deleted. Run without --dry-run to perform actual cleanup."
else
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║             CLEANUP COMPLETE                                   ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
fi
echo ""
echo "Resources NOT cleaned up (by design):"
echo "  - Resource group: $RESOURCE_GROUP"
echo "  - Azure Compute Gallery: $GALLERY_NAME"
echo "  - Storage account: ${STORAGE_ACCT:-<not found>}"
echo "  - Virtual networks and subnets"
echo "  - Role assignments for storage access"
echo ""
