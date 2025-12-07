#!/bin/bash
#
# Redeploys an existing Azure VM with a new image while preserving its IP address and metadata.
# Usage: ./redeploy_azure.sh <vm-name> <vhd-file>
#
# The script will:
# 1. Capture the existing VM's configuration (IP, NIC, NSG, tags, size, etc.)
# 2. Upload the VHD to blob storage and create an image version
# 3. Delete the existing VM (but preserve NIC and public IP)
# 4. Create a new VM from the new image attached to the existing NIC
#
# Prerequisites:
# - Azure CLI installed and logged in (az login)
# - Resource group 'tdx-group' exists
# - The VM to redeploy exists
#
# Examples:
#   ./redeploy_azure.sh my-vm build/kettle-vm-azure.vhd
#   ./redeploy_azure.sh my-vm build/kettle-vm-azure.vhd.tar.gz
#   ./redeploy_azure.sh my-vm build/kettle-vm-azure.vhd --dry-run
#   ./redeploy_azure.sh my-vm build/kettle-vm-azure.vhd --yes
#

set -euo pipefail

# Configuration
RESOURCE_GROUP="tdx-group"
GALLERY_NAME="tdxGallery"
IMAGE_DEFINITION="kettle-vm-azure"
CONTAINER_NAME="vhds"
VM_SIZE="Standard_DC2es_v5"

# Generate a random integer for image version patch number (1 to 2,000,000,000)
IMAGE_PATCH_VERSION=$((1 + RANDOM * RANDOM % 2000000000))

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

log_step() {
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}STEP: $1${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
}

cleanup_on_failure() {
    log_error "Redeployment failed. The original VM may have been deleted."
    echo ""
    echo "To manually recreate the VM with the existing NIC, run:"
    echo "  az vm create \\"
    echo "    --name ${VM_NAME} \\"
    echo "    --resource-group ${RESOURCE_GROUP} \\"
    echo "    --nics ${NIC_NAME:-<nic-name>} \\"
    echo "    --security-type ConfidentialVM \\"
    echo "    --os-disk-security-encryption-type VMGuestStateOnly \\"
    echo "    --image ${IMAGE_ID:-<image-id>} \\"
    echo "    --size ${PRESERVED_VM_SIZE:-$VM_SIZE} \\"
    echo "    --enable-vtpm true \\"
    echo "    --enable-secure-boot false"
    echo ""
    echo "Resources that may need cleanup:"
    echo "  az sig image-version delete -g ${RESOURCE_GROUP} -r ${GALLERY_NAME} -i ${IMAGE_DEFINITION} -e ${IMAGE_VERSION:-unknown} 2>/dev/null"
    echo "  az storage blob delete -n ${BLOB_NAME:-unknown} -c ${CONTAINER_NAME} --account-name \${STORAGE_ACCT} --auth-mode login 2>/dev/null"
    exit 1
}

# Validate arguments
if [ $# -lt 2 ]; then
    echo "Usage: $0 <vm-name> <vhd-file>"
    echo ""
    echo "Arguments:"
    echo "  vm-name    Name of the existing VM to redeploy"
    echo "  vhd-file   Path to the VHD file (or .vhd.tar.gz) to deploy"
    echo ""
    echo "Options:"
    echo "  --dry-run  Show what would be done without making changes"
    echo ""
    echo "Examples:"
    echo "  $0 my-vm build/kettle-vm-azure.vhd"
    echo "  $0 my-vm build/kettle-vm-azure.vhd.tar.gz"
    echo "  $0 my-vm build/kettle-vm-azure.vhd --dry-run"
    exit 1
fi

VM_NAME="$1"
VHD_INPUT="$2"

# Parse optional arguments
DRY_RUN=false
shift 2
for arg in "$@"; do
    case "$arg" in
        --dry-run)
            DRY_RUN=true
            ;;
    esac
done

# Handle .vhd.tar.gz files
if [[ "$VHD_INPUT" == *.vhd.tar.gz ]]; then
    log_info "Extracting VHD from tar.gz archive..."
    VHD_DIR=$(dirname "$VHD_INPUT")
    VHD_BASENAME=$(basename "$VHD_INPUT" .tar.gz)
    VHD_FILE="${VHD_DIR}/${VHD_BASENAME}"

    if [ ! -f "$VHD_FILE" ]; then
        if ! tar -xzf "$VHD_INPUT" -C "$VHD_DIR"; then
            log_error "Failed to extract VHD from archive"
            exit 1
        fi
        log_success "Extracted: $VHD_FILE"
    else
        log_info "VHD already extracted: $VHD_FILE"
    fi
else
    VHD_FILE="$VHD_INPUT"
fi

# Validate VHD file exists
if [ ! -f "$VHD_FILE" ]; then
    log_error "VHD file not found: $VHD_FILE"
    echo ""
    echo "Make sure you have built the image first:"
    echo "  npm run build:az          # For kettle-vm-azure.vhd"
    echo "  npm run build:az:devtools # For devtools VHD"
    exit 1
fi

# Generate unique identifiers for this deployment
DEPLOY_HASH=$(openssl rand -hex 4)
VHD_BASENAME=$(basename "$VHD_FILE")
BLOB_NAME="${VHD_BASENAME%.vhd}-redeploy-${DEPLOY_HASH}.vhd"
IMAGE_VERSION="1.0.${IMAGE_PATCH_VERSION}"

echo ""
log_info "Azure VM Redeployment"
log_info "====================="
log_info "VM Name: $VM_NAME"
log_info "VHD File: $VHD_FILE"
log_info "Blob Name: $BLOB_NAME"
log_info "Image Version: $IMAGE_VERSION"
log_info "Deploy Hash: $DEPLOY_HASH"
if [ "$DRY_RUN" = true ]; then
    log_warning "DRY-RUN MODE: No changes will be made"
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
# STEP 2: Verify VM exists and capture its configuration
# ============================================================================
log_step "Capturing existing VM configuration"

log_info "Checking if VM '$VM_NAME' exists..."
if ! az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
    log_error "VM '$VM_NAME' not found in resource group '$RESOURCE_GROUP'"
    echo ""
    echo "Available VMs in $RESOURCE_GROUP:"
    az vm list --resource-group "$RESOURCE_GROUP" --query "[].name" -o tsv 2>/dev/null || echo "  (none)"
    exit 1
fi

log_success "Found VM: $VM_NAME"

# Get VM size
PRESERVED_VM_SIZE=$(az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" \
    --query "hardwareProfile.vmSize" -o tsv)
log_info "VM Size: $PRESERVED_VM_SIZE"

# Get VM tags
VM_TAGS_JSON=$(az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" \
    --query "tags" -o json 2>/dev/null || echo "{}")
log_info "VM Tags: $VM_TAGS_JSON"

# Get network interface
NIC_ID=$(az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" \
    --query "networkProfile.networkInterfaces[0].id" -o tsv)
NIC_NAME=$(basename "$NIC_ID")
log_info "Network Interface: $NIC_NAME"

# Get public IP
PUBLIC_IP_ID=$(az network nic show --ids "$NIC_ID" \
    --query "ipConfigurations[0].publicIPAddress.id" -o tsv 2>/dev/null || echo "")
if [ -n "$PUBLIC_IP_ID" ] && [ "$PUBLIC_IP_ID" != "None" ]; then
    PUBLIC_IP_NAME=$(basename "$PUBLIC_IP_ID")
    CURRENT_PUBLIC_IP=$(az network public-ip show --ids "$PUBLIC_IP_ID" \
        --query "ipAddress" -o tsv 2>/dev/null || echo "")
    log_info "Public IP: $CURRENT_PUBLIC_IP (resource: $PUBLIC_IP_NAME)"
else
    PUBLIC_IP_NAME=""
    CURRENT_PUBLIC_IP=""
    log_info "Public IP: <none>"
fi

# Get NSG
NSG_ID=$(az network nic show --ids "$NIC_ID" \
    --query "networkSecurityGroup.id" -o tsv 2>/dev/null || echo "")
if [ -n "$NSG_ID" ] && [ "$NSG_ID" != "None" ]; then
    NSG_NAME=$(basename "$NSG_ID")
    log_info "Network Security Group: $NSG_NAME"
else
    NSG_NAME=""
    log_info "Network Security Group: <none>"
fi

# Get OS disk name (we'll delete this since a new one will be created)
OS_DISK_NAME=$(az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" \
    --query "storageProfile.osDisk.name" -o tsv)
log_info "OS Disk (will be deleted): $OS_DISK_NAME"

# Get boot diagnostics storage account
BOOT_DIAG_STORAGE=$(az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" \
    --query "diagnosticsProfile.bootDiagnostics.storageUri" -o tsv 2>/dev/null || echo "")
if [ -n "$BOOT_DIAG_STORAGE" ]; then
    # Extract storage account name from URI
    BOOT_DIAG_STORAGE_NAME=$(echo "$BOOT_DIAG_STORAGE" | sed -E 's|https://([^.]+)\..*|\1|')
    log_info "Boot Diagnostics Storage: $BOOT_DIAG_STORAGE_NAME"
else
    BOOT_DIAG_STORAGE_NAME=""
    log_info "Boot Diagnostics Storage: <not configured>"
fi

# ============================================================================
# STEP 3: Confirm redeployment
# ============================================================================
log_step "Confirmation"

echo ""
echo "The following changes will be made:"
echo ""
echo "  UPLOAD:"
echo "    - VHD: $VHD_FILE -> $BLOB_NAME"
echo "    - Create image version: $IMAGE_VERSION"
echo ""
echo "  DELETE:"
echo "    - VM: $VM_NAME"
echo "    - OS Disk: $OS_DISK_NAME"
echo ""
echo "  PRESERVE:"
echo "    - Network Interface: $NIC_NAME"
if [ -n "$PUBLIC_IP_NAME" ]; then
    echo "    - Public IP: $CURRENT_PUBLIC_IP ($PUBLIC_IP_NAME)"
fi
if [ -n "$NSG_NAME" ]; then
    echo "    - NSG: $NSG_NAME"
fi
if [ "$VM_TAGS_JSON" != "{}" ] && [ "$VM_TAGS_JSON" != "null" ]; then
    echo "    - Tags: $VM_TAGS_JSON"
fi
echo ""
echo "  CREATE:"
echo "    - New VM: $VM_NAME (from image version $IMAGE_VERSION)"
echo "    - New OS Disk: (auto-generated)"
echo ""

if [ "$DRY_RUN" = true ]; then
    log_warning "DRY-RUN: No changes will be made"
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║             DRY-RUN COMPLETE                                   ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "Run without --dry-run to perform the actual redeployment."
    exit 0
fi

# Set up error handler
trap cleanup_on_failure ERR

# ============================================================================
# STEP 4: Get or create storage account
# ============================================================================
log_step "Setting up storage account"

STORAGE_ACCOUNT_FILE=".storageaccount"

if [ -f "$STORAGE_ACCOUNT_FILE" ]; then
    STORAGE_ACCT=$(cat "$STORAGE_ACCOUNT_FILE")
    log_info "Found cached storage account: $STORAGE_ACCT"

    # Verify it still exists
    if ! az storage account show --name "$STORAGE_ACCT" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
        log_warning "Cached storage account '$STORAGE_ACCT' no longer exists. Creating new one..."
        rm -f "$STORAGE_ACCOUNT_FILE"
        STORAGE_ACCT=""
    fi
fi

if [ -z "${STORAGE_ACCT:-}" ]; then
    STORAGE_ACCT="tdx$(openssl rand -hex 6)"
    log_info "Creating new storage account: $STORAGE_ACCT"

    if ! az storage account create \
        --name "$STORAGE_ACCT" \
        --resource-group "$RESOURCE_GROUP" \
        --sku Standard_LRS \
        --output none; then
        log_error "Failed to create storage account"
        echo ""
        echo "Make sure the resource group exists:"
        echo "  az group create --name ${RESOURCE_GROUP} --location eastus"
        exit 1
    fi

    echo "$STORAGE_ACCT" > "$STORAGE_ACCOUNT_FILE"
    log_success "Created and cached storage account: $STORAGE_ACCT"
else
    log_success "Using existing storage account: $STORAGE_ACCT"
fi

# Use storage account for boot diagnostics if not already set
if [ -z "$BOOT_DIAG_STORAGE_NAME" ]; then
    BOOT_DIAG_STORAGE_NAME="$STORAGE_ACCT"
fi

# ============================================================================
# STEP 5: Create container if it doesn't exist
# ============================================================================
log_step "Setting up blob container"

if ! az storage container show --account-name "$STORAGE_ACCT" --name "$CONTAINER_NAME" &>/dev/null; then
    log_info "Creating container: $CONTAINER_NAME"

    if ! az storage container create \
        --account-name "$STORAGE_ACCT" \
        --name "$CONTAINER_NAME" \
        --output none; then
        log_error "Failed to create container"
        exit 1
    fi

    log_success "Created container: $CONTAINER_NAME"
else
    log_success "Container already exists: $CONTAINER_NAME"
fi

# ============================================================================
# STEP 6: Assign storage permissions
# ============================================================================
log_step "Setting up storage permissions"

MY_ID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)
SA_ID=$(az storage account show -n "$STORAGE_ACCT" -g "$RESOURCE_GROUP" --query id -o tsv)

if [ -n "$MY_ID" ]; then
    log_info "Checking Storage Blob Data Owner role..."

    # Check if role assignment already exists
    EXISTING_ROLE=$(az role assignment list --assignee "$MY_ID" --scope "$SA_ID" --role "Storage Blob Data Owner" --query "[].id" -o tsv 2>/dev/null || true)

    if [ -n "$EXISTING_ROLE" ]; then
        log_success "Role assignment already exists"
    else
        log_info "Assigning Storage Blob Data Owner role..."
        if az role assignment create \
            --assignee "$MY_ID" \
            --role "Storage Blob Data Owner" \
            --scope "$SA_ID" \
            --output none 2>/dev/null; then
            log_success "Role assignment created"
            log_info "Waiting for role assignment to propagate (30 seconds)..."
            sleep 30
        else
            log_warning "Could not create role assignment (may already exist or insufficient permissions)"
        fi
    fi
else
    log_warning "Could not determine signed-in user ID, skipping role assignment"
fi

# ============================================================================
# STEP 7: Upload VHD to blob storage
# ============================================================================
log_step "Uploading VHD to blob storage"

VHD_SIZE=$(stat -c%s "$VHD_FILE")
log_info "VHD file size: $VHD_SIZE bytes ($(numfmt --to=iec-i --suffix=B $VHD_SIZE))"
log_info "Uploading as: $BLOB_NAME"
log_info "This may take several minutes..."

if ! az storage blob upload \
    --account-name "$STORAGE_ACCT" \
    --container-name "$CONTAINER_NAME" \
    --name "$BLOB_NAME" \
    --file "$VHD_FILE" \
    --type page \
    --auth-mode login \
    --overwrite; then
    log_error "Failed to upload VHD blob"
    echo ""
    echo "If you see authentication errors, wait a few minutes for the role assignment to propagate,"
    echo "then retry the script."
    exit 1
fi

BLOB_URL="https://${STORAGE_ACCT}.blob.core.windows.net/${CONTAINER_NAME}/${BLOB_NAME}"
log_success "Uploaded VHD to: $BLOB_URL"

# ============================================================================
# STEP 8: Verify Azure Compute Gallery exists
# ============================================================================
log_step "Verifying Azure Compute Gallery"

if ! az sig show --resource-group "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" &>/dev/null; then
    log_info "Creating Azure Compute Gallery: $GALLERY_NAME"

    if ! az sig create \
        --resource-group "$RESOURCE_GROUP" \
        --gallery-name "$GALLERY_NAME" \
        --output none; then
        log_error "Failed to create Azure Compute Gallery"
        echo ""
        echo "You can create it manually:"
        echo "  az sig create --resource-group ${RESOURCE_GROUP} --gallery-name ${GALLERY_NAME}"
        exit 1
    fi

    log_success "Created Azure Compute Gallery: $GALLERY_NAME"
else
    log_success "Azure Compute Gallery exists: $GALLERY_NAME"
fi

# ============================================================================
# STEP 9: Verify image definition exists
# ============================================================================
log_step "Verifying image definition"

if ! az sig image-definition show \
    --resource-group "$RESOURCE_GROUP" \
    --gallery-name "$GALLERY_NAME" \
    --gallery-image-definition "$IMAGE_DEFINITION" &>/dev/null; then
    log_info "Creating image definition: $IMAGE_DEFINITION"

    if ! az sig image-definition create \
        --resource-group "$RESOURCE_GROUP" \
        --gallery-name "$GALLERY_NAME" \
        --gallery-image-definition "$IMAGE_DEFINITION" \
        --publisher TeeKit \
        --offer kettle-vm-azure \
        --sku 1.0 \
        --os-type Linux \
        --os-state Generalized \
        --hyper-v-generation V2 \
        --features SecurityType=ConfidentialVMSupported \
        --output none; then
        log_error "Failed to create image definition"
        exit 1
    fi

    log_success "Created image definition: $IMAGE_DEFINITION"
else
    log_success "Image definition exists: $IMAGE_DEFINITION"
fi

# ============================================================================
# STEP 10: Create image version from VHD blob
# ============================================================================
log_step "Creating image version from VHD"

log_info "Creating image version: $IMAGE_VERSION"
log_info "This may take 10-20 minutes..."

if ! az sig image-version create \
    --resource-group "$RESOURCE_GROUP" \
    --gallery-name "$GALLERY_NAME" \
    --gallery-image-definition "$IMAGE_DEFINITION" \
    --gallery-image-version "$IMAGE_VERSION" \
    --os-vhd-uri "$BLOB_URL" \
    --os-vhd-storage-account "$STORAGE_ACCT" \
    --output none; then
    log_error "Failed to create image version"
    exit 1
fi

IMAGE_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Compute/galleries/${GALLERY_NAME}/images/${IMAGE_DEFINITION}/versions/${IMAGE_VERSION}"
log_success "Created image version: $IMAGE_VERSION"

# ============================================================================
# STEP 11: Delete existing VM (preserve NIC and public IP)
# ============================================================================
log_step "Deleting existing VM"

log_info "Deleting VM: $VM_NAME (preserving network resources)..."

# Delete VM without deleting associated resources
if ! az vm delete \
    --name "$VM_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --yes; then
    log_error "Failed to delete VM"
    exit 1
fi

log_success "Deleted VM: $VM_NAME"

# Delete the old OS disk
log_info "Deleting old OS disk: $OS_DISK_NAME"
if az disk delete \
    --name "$OS_DISK_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --yes 2>/dev/null; then
    log_success "Deleted OS disk: $OS_DISK_NAME"
else
    log_warning "Could not delete OS disk (may already be deleted or still detaching)"
fi

# Wait a moment for resources to be fully released
log_info "Waiting for resources to be released..."
sleep 10

# ============================================================================
# STEP 12: Create new VM with existing NIC
# ============================================================================
log_step "Creating new VM with existing network resources"

log_info "Creating VM: $VM_NAME"
log_info "Image Version: $IMAGE_VERSION"
log_info "Size: $PRESERVED_VM_SIZE"
log_info "NIC: $NIC_NAME"
log_info "This may take 5-10 minutes..."

# Build the VM create command
VM_CREATE_CMD=(
    az vm create
    --name "$VM_NAME"
    --resource-group "$RESOURCE_GROUP"
    --nics "$NIC_NAME"
    --security-type ConfidentialVM
    --os-disk-security-encryption-type VMGuestStateOnly
    --image "$IMAGE_ID"
    --size "$PRESERVED_VM_SIZE"
    --enable-vtpm true
    --enable-secure-boot false
    --output none
)

# Add boot diagnostics if available
if [ -n "$BOOT_DIAG_STORAGE_NAME" ]; then
    VM_CREATE_CMD+=(--boot-diagnostics-storage "$BOOT_DIAG_STORAGE_NAME")
fi

# Add tags if present
if [ "$VM_TAGS_JSON" != "{}" ] && [ "$VM_TAGS_JSON" != "null" ]; then
    # Convert JSON tags to array of key=value pairs, each as a separate argument
    # This prevents Azure CLI from misinterpreting spaces in tag values
    readarray -t TAG_ARGS < <(echo "$VM_TAGS_JSON" | jq -r 'to_entries[] | "\(.key)=\(.value)"' 2>/dev/null || true)
    if [ ${#TAG_ARGS[@]} -gt 0 ]; then
        VM_CREATE_CMD+=(--tags "${TAG_ARGS[@]}")
    fi
fi

if ! "${VM_CREATE_CMD[@]}"; then
    log_error "Failed to create VM"
    echo ""
    echo "The NIC and public IP have been preserved. You can manually recreate the VM:"
    echo "  az vm create \\"
    echo "    --name ${VM_NAME} \\"
    echo "    --resource-group ${RESOURCE_GROUP} \\"
    echo "    --nics ${NIC_NAME} \\"
    echo "    --security-type ConfidentialVM \\"
    echo "    --os-disk-security-encryption-type VMGuestStateOnly \\"
    echo "    --image ${IMAGE_ID} \\"
    echo "    --size ${PRESERVED_VM_SIZE} \\"
    echo "    --enable-vtpm true \\"
    echo "    --enable-secure-boot false"
    exit 1
fi

log_success "Created VM: $VM_NAME"

# ============================================================================
# STEP 13: Verify deployment
# ============================================================================
log_step "Verifying deployment"

# Get the new public IP (should be the same)
NEW_PUBLIC_IP=$(az vm show \
    --name "$VM_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --show-details \
    --query publicIps -o tsv)

log_info "Verifying IP address preservation..."
if [ -n "$CURRENT_PUBLIC_IP" ]; then
    if [ "$NEW_PUBLIC_IP" = "$CURRENT_PUBLIC_IP" ]; then
        log_success "IP address preserved: $NEW_PUBLIC_IP"
    else
        log_warning "IP address changed: $CURRENT_PUBLIC_IP -> $NEW_PUBLIC_IP"
    fi
else
    log_info "New public IP: $NEW_PUBLIC_IP"
fi

# Verify VM is running
VM_STATE=$(az vm show \
    --name "$VM_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --show-details \
    --query "powerState" -o tsv)
log_info "VM Power State: $VM_STATE"

# ============================================================================
# Redeployment Complete
# ============================================================================
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║             REDEPLOYMENT COMPLETE                              ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "VM Name:        $VM_NAME"
echo "Public IP:      $NEW_PUBLIC_IP"
echo "Image Version:  $IMAGE_VERSION"
echo "VM Size:        $PRESERVED_VM_SIZE"
echo "Deploy Hash:    $DEPLOY_HASH"
echo ""
echo "Resources created:"
echo "  - Blob: $BLOB_NAME"
echo "  - Image Version: $IMAGE_VERSION"
echo ""
echo "Resources preserved:"
echo "  - Network Interface: $NIC_NAME"
if [ -n "$PUBLIC_IP_NAME" ]; then
    echo "  - Public IP: $PUBLIC_IP_NAME"
fi
if [ -n "$NSG_NAME" ]; then
    echo "  - NSG: $NSG_NAME"
fi
if [ "$VM_TAGS_JSON" != "{}" ] && [ "$VM_TAGS_JSON" != "null" ]; then
    echo "  - Tags: $VM_TAGS_JSON"
fi
echo ""
echo "Test the VM:"
echo "  curl http://${NEW_PUBLIC_IP}:3001/uptime"
echo "  curl http://${NEW_PUBLIC_IP}:3001/healthz"
echo ""
echo "Connect via serial console or ssh (devtools only):"
echo "  az serial-console connect --name $VM_NAME --resource-group $RESOURCE_GROUP"
echo "  ssh root@${NEW_PUBLIC_IP}"
echo ""
echo "View boot logs:"
echo "  az vm boot-diagnostics get-boot-log --name $VM_NAME --resource-group $RESOURCE_GROUP"
echo ""
echo "Cleanup commands (for the new image resources, if needed):"
echo "  az sig image-version delete -g $RESOURCE_GROUP -r $GALLERY_NAME -i $IMAGE_DEFINITION -e $IMAGE_VERSION"
echo "  az storage blob delete -n $BLOB_NAME -c $CONTAINER_NAME --account-name $STORAGE_ACCT --auth-mode login"
echo ""
