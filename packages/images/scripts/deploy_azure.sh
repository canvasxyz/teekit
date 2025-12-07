#!/bin/bash
#
# Deploys a VHD image to Azure as a Confidential VM.
# Usage: ./deploy-azure.sh <vhd-file>
#
# The script will:
# 1. Create or reuse a storage account (cached in .storageaccount)
# 2. Upload the VHD to blob storage
# 3. Create Azure Compute Gallery and image definition (if they don't exist)
# 4. Create an image version in Azure Compute Gallery
# 5. Create a Confidential VM from the image
#
# Prerequisites:
# - Azure CLI installed and logged in (az login)
# - Resource group 'tdx-group' exists
#
# The script automatically creates the following resources if they don't exist:
# - Azure Compute Gallery 'tdxGallery'
# - Image definition 'kettle-vm-azure' with Confidential VM support
#

set -euo pipefail

# Configuration
RESOURCE_GROUP="tdx-group"
GALLERY_NAME="tdxGallery"
IMAGE_DEFINITION="kettle-vm-azure"
CONTAINER_NAME="vhds"
VM_SIZE="Standard_DC2es_v5"

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

cleanup_on_failure() {
    log_error "Deployment failed. Resources created with hash '$DEPLOY_HASH' may need manual cleanup."
    echo ""
    echo "To clean up, you can run:"
    echo "  az vm delete --name kettle-${DEPLOY_HASH} --resource-group ${RESOURCE_GROUP} --yes 2>/dev/null"
    echo "  az sig image-version delete -g ${RESOURCE_GROUP} -r ${GALLERY_NAME} -i ${IMAGE_DEFINITION} -e ${IMAGE_VERSION:-unknown} 2>/dev/null"
    echo "  az storage blob delete -n ${BLOB_NAME:-unknown} -c ${CONTAINER_NAME} --account-name \${STORAGE_ACCT} --auth-mode login 2>/dev/null"
    exit 1
}

# Validate arguments
if [ $# -lt 1 ]; then
    echo "Usage: $0 <vhd-file> [name]"
    echo ""
    echo "Arguments:"
    echo "  vhd-file  Path to the VHD file to deploy"
    echo "  name      Optional name for the VM (default: random hash)"
    echo ""
    echo "Example:"
    echo "  $0 build/kettle-vm-azure.vhd"
    echo "  $0 build/kettle-vm-azure.vhd demo"
    echo "  $0 build/kettle-vm-devtools.vhd devtools"
    exit 1
fi

VHD_FILE="$1"

# Use provided name or generate random hash with prefix
if [ $# -ge 2 ]; then
    DEPLOY_HASH="$2"
else
    DEPLOY_HASH=$(openssl rand -hex 4)
fi
VM_NAME="kettle-${DEPLOY_HASH}"

# Convert hex hash to decimal for patch version (modulo to keep it reasonable)
IMAGE_PATCH_VERSION=$((1 + (0x${DEPLOY_HASH} % 10000000)))  # 1 to 10,000,000

# Validate VHD file exists
if [ ! -f "$VHD_FILE" ]; then
    log_error "VHD file not found: $VHD_FILE"
    echo ""
    echo "Make sure you have built the image first:"
    echo "  npm run build:az          # For kettle-vm-azure.vhd"
    echo "  npm run build:az:devtools # For devtools VHD"
    exit 1
fi

VHD_BASENAME=$(basename "$VHD_FILE")
BLOB_NAME="${VHD_BASENAME%.vhd}-${DEPLOY_HASH}.vhd"
IMAGE_VERSION="1.0.${IMAGE_PATCH_VERSION}"

echo ""
log_info "Azure TDX Image Deployment"
log_info "=========================="
log_info "VHD File: $VHD_FILE"
log_info "Blob Name: $BLOB_NAME"
log_info "Image Version: $IMAGE_VERSION"
log_info "VM Name: $VM_NAME"
log_info "Deploy Hash: $DEPLOY_HASH"
echo ""

# Set up error handler
trap cleanup_on_failure ERR

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
# STEP 2: Get or create storage account
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

# ============================================================================
# STEP 3: Create container if it doesn't exist
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
# STEP 4: Assign storage permissions
# ============================================================================
log_step "Setting up storage permissions"

MY_ID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)
SA_ID=$(az storage account show -n "$STORAGE_ACCT" -g "$RESOURCE_GROUP" --query id -o tsv)

if [ -n "$MY_ID" ]; then
    log_info "Assigning Storage Blob Data Owner role..."

    # Check if role assignment already exists
    EXISTING_ROLE=$(az role assignment list --assignee "$MY_ID" --scope "$SA_ID" --role "Storage Blob Data Owner" --query "[].id" -o tsv 2>/dev/null || true)

    if [ -n "$EXISTING_ROLE" ]; then
        log_success "Role assignment already exists"
    else
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
# STEP 5: Upload VHD to blob storage
# ============================================================================
log_step "Uploading VHD to blob storage"

VHD_SIZE=$(stat -c%s "$VHD_FILE")
log_info "VHD file size: $VHD_SIZE bytes ($(numfmt --to=iec-i --suffix=B $VHD_SIZE))"
log_info "Uploading as: $BLOB_NAME"
log_info "This may take several minutes..."

# Check if the blob already exists
if az storage blob exists \
    --account-name "$STORAGE_ACCT" \
    --container-name "$CONTAINER_NAME" \
    --name "$BLOB_NAME" \
    --auth-mode login \
    --query exists -o tsv | grep -q "true"; then
    log_success "Blob already exists: $BLOB_NAME (skipping upload)"
else
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
        echo "then retry the upload manually:"
        echo "  az storage blob upload \\"
        echo "    --account-name $STORAGE_ACCT \\"
        echo "    --container-name $CONTAINER_NAME \\"
        echo "    --name $BLOB_NAME \\"
        echo "    --file $VHD_FILE \\"
        echo "    --type page \\"
        echo "    --auth-mode login"
        exit 1
    fi
fi

BLOB_URL="https://${STORAGE_ACCT}.blob.core.windows.net/${CONTAINER_NAME}/${BLOB_NAME}"
log_success "Uploaded VHD to: $BLOB_URL"

# ============================================================================
# STEP 6: Verify Azure Compute Gallery exists
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
# STEP 7: Verify image definition exists
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
        echo ""
        echo "You can create it manually:"
        echo "  az sig image-definition create \\"
        echo "    --resource-group ${RESOURCE_GROUP} \\"
        echo "    --gallery-name ${GALLERY_NAME} \\"
        echo "    --gallery-image-definition ${IMAGE_DEFINITION} \\"
        echo "    --publisher TeeKit \\"
        echo "    --offer kettle-vm-azure \\"
        echo "    --sku 1.0 \\"
        echo "    --os-type Linux \\"
        echo "    --os-state Generalized \\"
        echo "    --hyper-v-generation V2 \\"
        echo "    --features SecurityType=ConfidentialVMSupported"
        exit 1
    fi

    log_success "Created image definition: $IMAGE_DEFINITION"
else
    log_success "Image definition exists: $IMAGE_DEFINITION"
fi

# ============================================================================
# STEP 8: Create image version from VHD blob
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
    echo ""
    echo "You can retry manually:"
    echo "  az sig image-version create \\"
    echo "    --resource-group ${RESOURCE_GROUP} \\"
    echo "    --gallery-name ${GALLERY_NAME} \\"
    echo "    --gallery-image-definition ${IMAGE_DEFINITION} \\"
    echo "    --gallery-image-version ${IMAGE_VERSION} \\"
    echo "    --os-vhd-uri ${BLOB_URL} \\"
    echo "    --os-vhd-storage-account ${STORAGE_ACCT}"
    exit 1
fi

IMAGE_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Compute/galleries/${GALLERY_NAME}/images/${IMAGE_DEFINITION}/versions/${IMAGE_VERSION}"
log_success "Created image version: $IMAGE_VERSION"

# ============================================================================
# STEP 9: Create Confidential VM
# ============================================================================
log_step "Creating Confidential VM"

log_info "Creating VM: $VM_NAME"
log_info "Size: $VM_SIZE"
log_info "This may take 5-10 minutes..."

# Check if VM already exists
if az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
    log_success "VM already exists: $VM_NAME (skipping creation)"
else
    if ! az vm create \
        --name "$VM_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --security-type ConfidentialVM \
        --os-disk-security-encryption-type VMGuestStateOnly \
        --image "$IMAGE_ID" \
        --size "$VM_SIZE" \
        --enable-vtpm true \
        --enable-secure-boot false \
        --boot-diagnostics-storage "$STORAGE_ACCT" \
        --generate-ssh-keys \
        --output none; then
        log_error "Failed to create VM"
        echo ""
        echo "Common issues:"
        echo "  - DiskServiceInternalError: VHD format issue or region availability"
        echo "  - QuotaExceeded: Request quota increase for DCesv5 VMs"
        echo ""
        echo "You can retry manually:"
        echo "  az vm create \\"
        echo "    --name ${VM_NAME} \\"
        echo "    --resource-group ${RESOURCE_GROUP} \\"
        echo "    --security-type ConfidentialVM \\"
        echo "    --os-disk-security-encryption-type VMGuestStateOnly \\"
        echo "    --image ${IMAGE_ID} \\"
        echo "    --size ${VM_SIZE} \\"
        echo "    --enable-vtpm true \\"
        echo "    --enable-secure-boot false \\"
        echo "    --boot-diagnostics-storage ${STORAGE_ACCT}"
        exit 1
    fi
fi


log_success "Created VM: $VM_NAME"

# ============================================================================
# STEP 10: Configure Network Security Group
# ============================================================================
log_step "Configuring Network Security Group"

log_info "Getting network interface..."
NIC_NAME=$(az vm show \
    --name "$VM_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query "networkProfile.networkInterfaces[0].id" -o tsv | xargs basename)

log_info "Network interface: $NIC_NAME"

NSG_NAME=$(az network nic show \
    --name "$NIC_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query "networkSecurityGroup.id" -o tsv 2>/dev/null | xargs basename 2>/dev/null || echo "")

if [ -z "$NSG_NAME" ] || [ "$NSG_NAME" = "None" ]; then
    NSG_NAME="${VM_NAME}-nsg"
    log_info "Creating NSG: $NSG_NAME"

    if az network nsg show --name "$NSG_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
        log_info "NSG already exists: $NSG_NAME"
    else
        if ! az network nsg create \
            --name "$NSG_NAME" \
            --resource-group "$RESOURCE_GROUP" \
            --output none; then
            log_error "Failed to create NSG"
            exit 1
        fi
        log_success "Created NSG: $NSG_NAME"
    fi


    log_info "Associating NSG with network interface..."
    if ! az network nic update \
        --name "$NIC_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --network-security-group "$NSG_NAME" \
        --output none; then
        log_warning "Failed to associate NSG with NIC"
    fi
fi

log_info "Adding inbound rules for required ports..."
# Use priority 1010 to avoid conflict with default-allow-ssh at priority 1000
# Check if NSG rule already exists before creating
if az network nsg rule show \
    --resource-group "$RESOURCE_GROUP" \
    --nsg-name "$NSG_NAME" \
    --name allow-required-ports &>/dev/null; then
    log_info "NSG rule 'allow-required-ports' already exists in $NSG_NAME"
else
    if ! az network nsg rule create \
        --resource-group "$RESOURCE_GROUP" \
        --nsg-name "$NSG_NAME" \
        --name allow-required-ports \
        --priority 1010 \
        --direction Inbound \
        --access Allow \
        --protocol Tcp \
        --destination-port-ranges 80 443 3000 3001 8090 \
        --source-address-prefixes "*" \
        --output none; then
        log_warning "Could not create NSG rule 'allow-required-ports'"
    fi
fi

log_success "Configured NSG: $NSG_NAME"

# ============================================================================
# STEP 11: Get VM public IP
# ============================================================================
log_step "Getting VM public IP"

PUBLIC_IP=$(az vm show \
    --name "$VM_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --show-details \
    --query publicIps -o tsv)

log_success "VM public IP: $PUBLIC_IP"

# ============================================================================
# Deployment Complete
# ============================================================================
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║             DEPLOYMENT COMPLETE                                ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "VM Name:        $VM_NAME"
echo "Public IP:      $PUBLIC_IP"
echo "Deploy Hash:    $DEPLOY_HASH"
echo ""
echo "Resources created:"
echo "- Storage Account: $STORAGE_ACCT (cached in .storageaccount)"
echo "- Blob: $BLOB_NAME"
echo "- Image Version: $IMAGE_VERSION"
echo "- VM: $VM_NAME"
echo ""
echo "Test the VM:"
echo "curl http://${PUBLIC_IP}:3001/uptime"
echo "curl http://${PUBLIC_IP}:3001/healthz"
echo ""
echo "Connect via serial console or ssh (devtools only):"
echo "az serial-console connect --name $VM_NAME --resource-group $RESOURCE_GROUP"
echo "ssh root@<PUBLIC_IP>"
echo ""
echo "View boot logs:"
echo "az vm boot-diagnostics get-boot-log --name $VM_NAME --resource-group $RESOURCE_GROUP"
echo ""
echo "Cleanup commands (if needed):"
echo "az vm delete --name $VM_NAME --resource-group $RESOURCE_GROUP --yes"
echo "az sig image-version delete -g $RESOURCE_GROUP -r $GALLERY_NAME -i $IMAGE_DEFINITION -e $IMAGE_VERSION"
echo "az storage blob delete -n $BLOB_NAME -c $CONTAINER_NAME --account-name $STORAGE_ACCT --auth-mode login"
