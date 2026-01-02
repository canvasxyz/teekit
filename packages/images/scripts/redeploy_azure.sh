#!/bin/bash
#
# Redeploys an existing Azure VM with a new image while preserving its IP address and metadata.
#
# Usage: ./redeploy_azure.sh <vhd-file> [vm-name] [--dry-run]
#
# The script will:
# 1. Capture the existing VM's configuration (IP, NIC, NSG, tags, size, etc.)
# 2. Upload the VHD to blob storage and create an image version
# 3. Delete the existing VM (but preserve NIC and public IP)
# 4. Create a new VM from the new image attached to the existing NIC
#
# Prerequisites:
# - Azure CLI installed and logged in (az login)
# - Resource group 'az-group' exists, or another group is provided in .resourcegroup
# - The VM to redeploy exists
#
# Arguments:
#   vhd-file   Path to the VHD file (or .vhd.tar.gz) to deploy (required)
#   vm-name    Name of the existing VM to redeploy (optional, uses cache or prompts)
#   --dry-run  Show what would be done without making changes
#
# Examples:
#   ./redeploy_azure.sh build/kettle-vm-azure.vhd              # Prompts for VM name
#   ./redeploy_azure.sh build/kettle-vm-azure.vhd my-vm
#   ./redeploy_azure.sh build/kettle-vm-azure.vhd.tar.gz my-vm
#   ./redeploy_azure.sh build/kettle-vm-azure.vhd --dry-run    # Uses cached VM name
#

set -euo pipefail

# Configuration
RESOURCE_GROUP_FILE=".resourcegroup"
if [ -f "$RESOURCE_GROUP_FILE" ]; then
    RESOURCE_GROUP=$(cat "$RESOURCE_GROUP_FILE")
else
    RESOURCE_GROUP="az-group"
fi
GALLERY_NAME_FILE=".galleryname"
if [ -f "$GALLERY_NAME_FILE" ]; then
    GALLERY_NAME=$(cat "$GALLERY_NAME_FILE")
else
    GALLERY_NAME="tdxGallery"
fi
CONTAINER_NAME="vhds"
VM_NAME_CACHE_FILE=".vm_name_azure"

# These will be set based on the image type (azsgx vs azure/TDX)
IMAGE_DEFINITION=""
VM_SIZE=""
SECURITY_TYPE=""  # "tdx" or "sgx"

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
    if [ "${SECURITY_TYPE:-tdx}" = "sgx" ]; then
        echo "  az vm create \\"
        echo "    --name ${VM_NAME} \\"
        echo "    --resource-group ${RESOURCE_GROUP} \\"
        echo "    --nics ${NIC_NAME:-<nic-name>} \\"
        echo "    --security-type TrustedLaunch \\"
        echo "    --image ${IMAGE_ID:-<image-id>} \\"
        echo "    --size ${PRESERVED_VM_SIZE:-$VM_SIZE} \\"
        echo "    --enable-vtpm true \\"
        echo "    --enable-secure-boot true"
    else
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
    fi
    echo ""
    echo "Resources that may need cleanup:"
    echo "  az sig image-version delete -g ${RESOURCE_GROUP} -r ${GALLERY_NAME} -i ${IMAGE_DEFINITION:-kettle-vm-azure} -e ${IMAGE_VERSION:-unknown} 2>/dev/null"
    echo "  az storage blob delete -n ${BLOB_NAME:-unknown} -c ${CONTAINER_NAME} --account-name \${STORAGE_ACCT} --auth-mode login 2>/dev/null"
    exit 1
}

# Validate arguments - need at least the VHD file
if [ $# -lt 1 ]; then
    echo "Usage: $0 <vhd-file> [vm-name] [--dry-run]"
    echo ""
    echo "Arguments:"
    echo "  vhd-file   Path to the VHD file (or .vhd.tar.gz) to deploy (required)"
    echo "  vm-name    Name of the existing VM to redeploy (optional, uses cache or prompts)"
    echo ""
    echo "Options:"
    echo "  --dry-run  Show what would be done without making changes"
    echo ""
    echo "Examples:"
    echo "  $0 build/kettle-vm-azure.vhd              # Prompts for VM name"
    echo "  $0 build/kettle-vm-azure.vhd my-vm"
    echo "  $0 build/kettle-vm-azure.vhd.tar.gz my-vm"
    echo "  $0 build/kettle-vm-azure.vhd --dry-run    # Uses cached VM name"
    exit 1
fi

# First argument must be the VHD file
VHD_INPUT="$1"
shift

# Initialize defaults
VM_NAME=""
DRY_RUN=false

# Parse remaining arguments
for arg in "$@"; do
    case "$arg" in
        --dry-run)
            DRY_RUN=true
            ;;
        *)
            # Assume it's the VM name if not recognized as an option
            if [ -z "$VM_NAME" ]; then
                VM_NAME="$arg"
            else
                log_error "Unknown argument: $arg"
                exit 1
            fi
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
    echo "  npm run build:az:devtools # For kettle-vm-azure-devtools.vhd"
    exit 1
fi

# Handle VM name: use provided, cached, or prompt
if [ -z "$VM_NAME" ]; then
    # Try to read from cache
    if [ -f "$VM_NAME_CACHE_FILE" ]; then
        VM_NAME=$(cat "$VM_NAME_CACHE_FILE")
        log_info "Using cached VM name: $VM_NAME"
    else
        # No cache, prompt for VM name
        echo -n "Enter the VM name to redeploy: "
        read -r VM_NAME
        if [ -z "$VM_NAME" ]; then
            log_error "VM name is required"
            exit 1
        fi
    fi
fi

# Generate unique identifiers for this deployment
DEPLOY_HASH=$(openssl rand -hex 4)
VHD_BASENAME=$(basename "$VHD_FILE")
BLOB_NAME="${VHD_BASENAME%.vhd}-redeploy-${DEPLOY_HASH}.vhd"
IMAGE_VERSION="1.0.${IMAGE_PATCH_VERSION}"

# Detect image type based on filename
if [[ "$VHD_BASENAME" == *"azsgx"* ]]; then
    SECURITY_TYPE="sgx"
    IMAGE_DEFINITION="kettle-vm-azsgx"
    VM_SIZE="Standard_DC2ds_v3"
    log_info "Detected SGX image - will deploy as Trusted Launch VM with Secure Boot"
else
    SECURITY_TYPE="tdx"
    IMAGE_DEFINITION="kettle-vm-azure"
    VM_SIZE="Standard_DC2es_v5"
    log_info "Detected TDX image - will deploy as Confidential VM"
fi

# For SGX images, validate Secure Boot certificate exists
if [ "$SECURITY_TYPE" = "sgx" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    CERT_FILE="$SCRIPT_DIR/../mkosi.secureboot.crt"

    if [ ! -f "$CERT_FILE" ]; then
        log_error "Secure Boot certificate not found: $CERT_FILE"
        echo ""
        echo "SGX images require Secure Boot signing. Please generate keys first:"
        echo "  npm run update:genkeys_secureboot"
        echo ""
        echo "Then rebuild the SGX image:"
        echo "  npm run build:azsgx"
        exit 1
    fi

    log_success "Found Secure Boot certificate: $CERT_FILE"
fi

echo ""
log_info "Azure VM Redeployment"
log_info "====================="
log_info "VM Name: $VM_NAME"
log_info "VHD File: $VHD_FILE"
log_info "Security Type: $SECURITY_TYPE ($([ "$SECURITY_TYPE" = "sgx" ] && echo "Trusted Launch" || echo "Confidential VM"))"
log_info "Default VM Size: $VM_SIZE"
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

    # Set security feature based on image type
    if [ "$SECURITY_TYPE" = "sgx" ]; then
        SECURITY_FEATURE="SecurityType=TrustedLaunchSupported"
        OFFER_NAME="kettle-vm-azsgx"
    else
        SECURITY_FEATURE="SecurityType=ConfidentialVMSupported"
        OFFER_NAME="kettle-vm-azure"
    fi

    if ! az sig image-definition create \
        --resource-group "$RESOURCE_GROUP" \
        --gallery-name "$GALLERY_NAME" \
        --gallery-image-definition "$IMAGE_DEFINITION" \
        --publisher TeeKit \
        --offer "$OFFER_NAME" \
        --sku 1.0 \
        --os-type Linux \
        --os-state Generalized \
        --hyper-v-generation V2 \
        --features "$SECURITY_FEATURE" \
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

# Get Azure region from resource group
REGION=$(az group show --name "$RESOURCE_GROUP" --query location -o tsv)

if [ "$SECURITY_TYPE" = "sgx" ]; then
    # SGX: Use REST API with Secure Boot UEFI keys
    log_info "Enrolling Secure Boot keys in image version..."

    # Convert certificate to DER format, then base64 encode (Azure expects DER-encoded X.509)
    CERT_DER=$(mktemp)
    if ! openssl x509 -in "$CERT_FILE" -inform PEM -outform DER -out "$CERT_DER"; then
        log_error "Failed to convert certificate to DER format"
        rm -f "$CERT_DER"
        exit 1
    fi
    CERT_B64=$(base64 -w 0 < "$CERT_DER" 2>/dev/null || base64 < "$CERT_DER" | tr -d '\n')
    rm -f "$CERT_DER"

    # Create temporary JSON payload for REST API
    PAYLOAD_FILE=$(mktemp)
    cat > "$PAYLOAD_FILE" <<EOF
{
  "location": "$REGION",
  "properties": {
    "publishingProfile": {
      "targetRegions": [
        {
          "name": "$REGION",
          "regionalReplicaCount": 1
        }
      ]
    },
    "storageProfile": {
      "osDiskImage": {
        "source": {
          "storageAccountId": "/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Storage/storageAccounts/${STORAGE_ACCT}",
          "uri": "${BLOB_URL}"
        },
        "hostCaching": "ReadOnly"
      }
    },
    "securityProfile": {
      "uefiSettings": {
        "signatureTemplateNames": [
          "MicrosoftUefiCertificateAuthorityTemplate"
        ],
        "additionalSignatures": {
          "db": [
            {
              "type": "x509",
              "value": ["${CERT_B64}"]
            }
          ]
        }
      }
    }
  }
}
EOF

    # Create image version using REST API
    if ! az rest --method PUT \
        --uri "https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Compute/galleries/${GALLERY_NAME}/images/${IMAGE_DEFINITION}/versions/${IMAGE_VERSION}?api-version=2025-03-03" \
        --body @"$PAYLOAD_FILE"; then
        log_error "Failed to create image version with Secure Boot keys"
        rm -f "$PAYLOAD_FILE"
        echo ""
        echo "You can retry manually using the Azure REST API."
        echo "See: https://learn.microsoft.com/en-us/rest/api/compute/gallery-image-versions/create-or-update"
        exit 1
    fi

    rm -f "$PAYLOAD_FILE"
    log_success "Created image version with Secure Boot keys enrolled"

    # Wait for image version to finish replicating
    log_info "Waiting for image version to finish replicating..."
    if ! az sig image-version wait \
        --resource-group "$RESOURCE_GROUP" \
        --gallery-name "$GALLERY_NAME" \
        --gallery-image-definition "$IMAGE_DEFINITION" \
        --gallery-image-version "$IMAGE_VERSION" \
        --created \
        --timeout 1200; then
        log_error "Timeout waiting for image version replication"
        exit 1
    fi
    log_success "Image version replication complete"
else
    # TDX: Use standard image version creation
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

    log_success "Created image version: $IMAGE_VERSION"
fi

IMAGE_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Compute/galleries/${GALLERY_NAME}/images/${IMAGE_DEFINITION}/versions/${IMAGE_VERSION}"

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

# Build the VM create command based on security type
if [ "$SECURITY_TYPE" = "sgx" ]; then
    # SGX: Trusted Launch VM with Secure Boot
    VM_CREATE_CMD=(
        az vm create
        --name "$VM_NAME"
        --resource-group "$RESOURCE_GROUP"
        --nics "$NIC_NAME"
        --security-type TrustedLaunch
        --image "$IMAGE_ID"
        --size "$PRESERVED_VM_SIZE"
        --enable-vtpm true
        --enable-secure-boot true
        --output none
    )
else
    # TDX: Confidential VM
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
fi

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
    if [ "$SECURITY_TYPE" = "sgx" ]; then
        echo "  az vm create \\"
        echo "    --name ${VM_NAME} \\"
        echo "    --resource-group ${RESOURCE_GROUP} \\"
        echo "    --nics ${NIC_NAME} \\"
        echo "    --security-type TrustedLaunch \\"
        echo "    --image ${IMAGE_ID} \\"
        echo "    --size ${PRESERVED_VM_SIZE} \\"
        echo "    --enable-vtpm true \\"
        echo "    --enable-secure-boot true"
    else
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
    fi
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

# Wait for server to become available on port 3001
echo ""
log_info "Waiting for server to become available at http://${NEW_PUBLIC_IP}:3001 ..."
log_info "You can press Ctrl+C to exit at any time."
echo ""

SERVER_URL="http://${NEW_PUBLIC_IP}:3001/uptime"
MAX_ATTEMPTS=10  # Max 10 retries
ATTEMPT=0
SLEEP_INTERVAL=15

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    ATTEMPT=$((ATTEMPT + 1))

    # Try to connect - any HTTP response means the server is up
    if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$SERVER_URL" 2>/dev/null | grep -qE "^[2345]"; then
        echo ""
        log_success "Server is up!"
        log_success "http://${NEW_PUBLIC_IP}:3001 is now accessible"
        break
    fi

    echo -ne "\r${YELLOW}[WAITING]${NC} Attempt $ATTEMPT: Waiting for server... (${SLEEP_INTERVAL}s intervals)    "
    sleep $SLEEP_INTERVAL
done

if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
    echo ""
    log_warning "Server check timed out after $MAX_ATTEMPTS attempts"
    log_info "The VM may still be starting up. Check manually:"
    log_info "  curl -v http://${NEW_PUBLIC_IP}:3001/uptime"
fi

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
echo "  node scripts/test_tunnel.js ${NEW_PUBLIC_IP}"
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

# Cache the VM name for future redeployments
echo "$VM_NAME" > "$VM_NAME_CACHE_FILE"
log_info "Cached VM name '$VM_NAME' for future redeployments"
