#!/bin/bash
#
# Redeploys an existing GCP VM with a new image while preserving its IP address and metadata.
#
# Usage: ./redeploy_gcp.sh <tar.gz-file> <--tdx|--sev-snp> [vm-name] [--zone=ZONE] [--dry-run]
#
# The script will:
# 1. Capture the existing VM's configuration (IP, metadata, machine type, etc.)
# 2. Upload the tar.gz to Cloud Storage and create a new image
# 3. Delete the existing VM (but preserve static IP if possible)
# 4. Create a new VM from the new image with the same configuration
#
# Prerequisites:
# - Google Cloud CLI installed and logged in (gcloud auth login)
# - A GCP project selected (gcloud config set project <project>)
# - The VM to redeploy exists
#
# Arguments:
#   tar.gz-file    Path to the tar.gz file to deploy (required)
#   --tdx          Deploy to Intel TDX machine (required: must specify --tdx or --sev-snp)
#   --sev-snp      Deploy to AMD SEV-SNP machine (required: must specify --tdx or --sev-snp)
#   vm-name        Name of the VM to redeploy (optional, uses cache or prompts)
#   --zone=ZONE    Zone where the VM is located (default: us-central1-a)
#   --dry-run      Show what would be done without making changes
#
# Examples:
#   ./redeploy_gcp.sh build/kettle-vm-gcp.tar.gz --tdx              # Prompts for VM name
#   ./redeploy_gcp.sh build/kettle-vm-gcp.tar.gz --tdx my-vm
#   ./redeploy_gcp.sh build/kettle-vm-gcp.tar.gz --sev-snp my-vm
#   ./redeploy_gcp.sh build/kettle-vm-gcp.tar.gz --tdx --dry-run    # Uses cached VM name
#

set -euo pipefail

# Configuration
BUCKET_NAME=""  # Will be set based on project ID
REGION="us-central1"
DEFAULT_ZONE="us-central1-a"
VM_NAME_CACHE_FILE=".vm_name_gcp"

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
    echo "To manually recreate the VM, run:"
    echo "  gcloud compute instances create ${VM_NAME} \\"
    echo "    --image=${NEW_IMAGE_NAME:-<image-name>} \\"
    echo "    --machine-type=${NEW_MACHINE_TYPE} \\"
    echo "    --zone=${VM_ZONE:-$DEFAULT_ZONE} \\"
    echo "    --confidential-compute-type=${CONFIDENTIAL_TYPE} \\"
    echo "    --maintenance-policy=TERMINATE \\"
    echo "    --boot-disk-size=${PRESERVED_DISK_SIZE:-200GB} \\"
    echo "    --tags=${VM_TAG}"
    if [ "$TEE_TYPE" = "sev-snp" ]; then
        echo "    --min-cpu-platform=\"AMD Milan\""
    fi
    if [ -n "${STATIC_IP_NAME:-}" ]; then
        echo "    --address=${STATIC_IP_NAME}"
    fi
    echo ""
    echo "Resources that may need cleanup:"
    echo "  gcloud compute images delete ${NEW_IMAGE_NAME:-<image-name>} --quiet 2>/dev/null"
    echo "  gcloud storage rm gs://${BUCKET_NAME}/${BLOB_NAME:-<blob-name>} 2>/dev/null"
    if [ "${PROMOTED_IP:-false}" = true ] && [ -n "${STATIC_IP_NAME:-}" ]; then
        IP_REGION=$(echo "${VM_ZONE:-$DEFAULT_ZONE}" | sed 's/-[a-z]$//')
        echo "  gcloud compute addresses delete ${STATIC_IP_NAME} --region=$IP_REGION --quiet 2>/dev/null"
    fi
    exit 1
}

# Validate arguments - need at least the tar.gz file
if [ $# -lt 1 ]; then
    echo "Usage: $0 <tar.gz-file> <--tdx|--sev-snp> [vm-name] [--zone=ZONE] [--dry-run]"
    echo ""
    echo "Arguments:"
    echo "  tar.gz-file  Path to the tar.gz file to deploy (required)"
    echo ""
    echo "Options:"
    echo "  --tdx        Deploy to Intel TDX machine (required: must specify --tdx or --sev-snp)"
    echo "  --sev-snp    Deploy to AMD SEV-SNP machine (required: must specify --tdx or --sev-snp)"
    echo "  vm-name      Name of the existing VM to redeploy (uses cache or prompts if omitted)"
    echo "  --zone=ZONE  Zone where the VM is located (default: $DEFAULT_ZONE)"
    echo "  --dry-run    Show what would be done without making changes"
    echo ""
    echo "Examples:"
    echo "  $0 build/kettle-vm-gcp.tar.gz --tdx              # Prompts for VM name"
    echo "  $0 build/kettle-vm-gcp.tar.gz --tdx my-vm"
    echo "  $0 build/kettle-vm-gcp.tar.gz --sev-snp my-vm"
    echo "  $0 build/kettle-vm-gcp.tar.gz --tdx --dry-run    # Uses cached VM name"
    exit 1
fi

# First argument must be the tar.gz file
TAR_FILE="$1"
shift

# Initialize defaults
TEE_TYPE=""
CONFIDENTIAL_TYPE=""
NEW_MACHINE_TYPE=""
IMAGE_OS_FEATURES=""
VM_TAG=""
VM_NAME=""
VM_ZONE="$DEFAULT_ZONE"
DRY_RUN=false

# Parse remaining arguments
for arg in "$@"; do
    case "$arg" in
        --tdx)
            TEE_TYPE="tdx"
            CONFIDENTIAL_TYPE="TDX"
            NEW_MACHINE_TYPE="c3-standard-4"
            IMAGE_OS_FEATURES="UEFI_COMPATIBLE,VIRTIO_SCSI_MULTIQUEUE,GVNIC,TDX_CAPABLE"
            VM_TAG="tdx-vm"
            ;;
        --sev-snp)
            TEE_TYPE="sev-snp"
            CONFIDENTIAL_TYPE="SEV_SNP"
            NEW_MACHINE_TYPE="n2d-standard-2"
            IMAGE_OS_FEATURES="UEFI_COMPATIBLE,VIRTIO_SCSI_MULTIQUEUE,GVNIC,SEV_SNP_CAPABLE"
            VM_TAG="sev-snp-vm"
            ;;
        --zone=*)
            VM_ZONE="${arg#*=}"
            ;;
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

# Validate that TEE type was specified
if [ -z "$TEE_TYPE" ]; then
    log_error "Must specify either --tdx or --sev-snp"
    echo ""
    echo "Usage: $0 <tar.gz-file> <--tdx|--sev-snp> [vm-name] [--zone=ZONE] [--dry-run]"
    echo ""
    echo "Examples:"
    echo "  $0 build/kettle-vm.tar.gz --tdx my-vm"
    echo "  $0 build/kettle-vm.tar.gz --sev-snp my-vm"
    exit 1
fi

# Validate tar.gz file exists
if [ ! -f "$TAR_FILE" ]; then
    log_error "tar.gz file not found: $TAR_FILE"
    echo ""
    echo "Make sure you have built the image first:"
    echo "  npm run build:gcp          # For kettle-vm-gcp.tar.gz"
    echo "  npm run build:gcp:devtools # For kettle-vm-gcp-devtools.tar.gz"
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
TAR_BASENAME=$(basename "$TAR_FILE")
BLOB_NAME="${TAR_BASENAME%.tar.gz}-redeploy-${DEPLOY_HASH}.tar.gz"
NEW_IMAGE_NAME="kettle-vm-${TEE_TYPE}-redeploy-${DEPLOY_HASH}"

echo ""
log_info "GCP VM Redeployment"
log_info "==================="
log_info "TEE Type: $TEE_TYPE (${CONFIDENTIAL_TYPE})"
log_info "Default Machine Type: $NEW_MACHINE_TYPE"
log_info "VM Name: $VM_NAME"
log_info "Zone: $VM_ZONE"
log_info "tar.gz File: $TAR_FILE"
log_info "Blob Name: $BLOB_NAME"
log_info "New Image Name: $NEW_IMAGE_NAME"
log_info "Deploy Hash: $DEPLOY_HASH"
if [ "$DRY_RUN" = true ]; then
    log_warning "DRY-RUN MODE: No changes will be made"
fi
echo ""

# ============================================================================
# STEP 1: Verify GCP CLI login and get project
# ============================================================================
log_step "Verifying GCP CLI login"

if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -1 | grep -q "."; then
    log_error "Not logged into GCP CLI. Please run 'gcloud auth login' first."
    exit 1
fi

PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
    log_error "No GCP project selected. Please run 'gcloud config set project <project>' first."
    exit 1
fi

BUCKET_NAME="${PROJECT_ID}-images"
log_success "Logged in to GCP (Project: $PROJECT_ID)"

# ============================================================================
# STEP 2: Verify VM exists and capture its configuration
# ============================================================================
log_step "Capturing existing VM configuration"

log_info "Checking if VM '$VM_NAME' exists in zone '$VM_ZONE'..."
if ! gcloud compute instances describe "$VM_NAME" --zone="$VM_ZONE" &>/dev/null; then
    log_error "VM '$VM_NAME' not found in zone '$VM_ZONE'"
    echo ""
    echo "Available VMs in project $PROJECT_ID:"
    gcloud compute instances list --format="table(name,zone,status)" 2>/dev/null || echo "  (none)"
    exit 1
fi

log_success "Found VM: $VM_NAME"

# Get boot disk size
PRESERVED_DISK_SIZE=$(gcloud compute instances describe "$VM_NAME" --zone="$VM_ZONE" \
    --format='get(disks[0].diskSizeGb)')
PRESERVED_DISK_SIZE="${PRESERVED_DISK_SIZE}GB"
log_info "Boot Disk Size: $PRESERVED_DISK_SIZE"

# Get metadata
VM_METADATA_JSON=$(gcloud compute instances describe "$VM_NAME" --zone="$VM_ZONE" \
    --format='json(metadata.items)' 2>/dev/null || echo '{}')
log_info "VM Metadata: $(echo "$VM_METADATA_JSON" | jq -c '.metadata.items // []')"

# Get tags
VM_TAGS=$(gcloud compute instances describe "$VM_NAME" --zone="$VM_ZONE" \
    --format='get(tags.items)' 2>/dev/null | tr ';' ',' || echo "")
if [ -n "$VM_TAGS" ]; then
    log_info "Network Tags: $VM_TAGS"
else
    VM_TAGS="$VM_TAG"
    log_info "Network Tags: (none, will use default: $VM_TAG)"
fi

# Get network interface info
NETWORK_INTERFACE=$(gcloud compute instances describe "$VM_NAME" --zone="$VM_ZONE" \
    --format='get(networkInterfaces[0].network)' | xargs basename)
SUBNETWORK=$(gcloud compute instances describe "$VM_NAME" --zone="$VM_ZONE" \
    --format='get(networkInterfaces[0].subnetwork)' 2>/dev/null | xargs basename 2>/dev/null || echo "")
log_info "Network: $NETWORK_INTERFACE"
if [ -n "$SUBNETWORK" ]; then
    log_info "Subnetwork: $SUBNETWORK"
fi

# Get current external IP
CURRENT_EXTERNAL_IP=$(gcloud compute instances describe "$VM_NAME" --zone="$VM_ZONE" \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || echo "")
if [ -n "$CURRENT_EXTERNAL_IP" ]; then
    log_info "Current External IP: $CURRENT_EXTERNAL_IP"
else
    log_info "Current External IP: <none>"
fi

# Check if it's a static IP, or if we need to promote it
STATIC_IP_NAME=""
PROMOTED_IP=false
if [ -n "$CURRENT_EXTERNAL_IP" ]; then
    STATIC_IP_NAME=$(gcloud compute addresses list \
        --filter="address=$CURRENT_EXTERNAL_IP AND status=IN_USE" \
        --format='get(name)' 2>/dev/null || echo "")
    if [ -n "$STATIC_IP_NAME" ]; then
        log_info "Static IP Name: $STATIC_IP_NAME (will be preserved)"
    else
        log_info "External IP is ephemeral - will be promoted to static"
        PROMOTED_IP=true
        STATIC_IP_NAME="${VM_NAME}-ip"
    fi
fi

# ============================================================================
# STEP 3: Confirm redeployment
# ============================================================================
log_step "Confirmation"

echo ""
echo "The following changes will be made:"
echo ""
echo "  UPLOAD:"
echo "    - tar.gz: $TAR_FILE -> $BLOB_NAME"
echo "    - Create image: $NEW_IMAGE_NAME"
echo "    - Create Machine Type: $NEW_MACHINE_TYPE"
echo ""
echo "  DELETE:"
echo "    - VM: $VM_NAME"
echo "    - Boot disk (auto-deleted with VM)"
echo ""
echo "  PRESERVE:"
echo "    - Boot Disk Size: $PRESERVED_DISK_SIZE"
echo "    - Network Tags: $VM_TAGS"
echo "    - Metadata: $(echo "$VM_METADATA_JSON" | jq -c '.metadata.items // []')"
if [ -n "$STATIC_IP_NAME" ]; then
    if [ "$PROMOTED_IP" = true ]; then
        echo "    - External IP: $CURRENT_EXTERNAL_IP (will be promoted to static: $STATIC_IP_NAME)"
    else
        echo "    - Static IP: $CURRENT_EXTERNAL_IP ($STATIC_IP_NAME)"
    fi
else
    echo "    - External IP: <none>"
fi
echo ""
echo "  CREATE:"
echo "    - New VM: $VM_NAME (from image $NEW_IMAGE_NAME)"
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
# STEP 4: Get or create storage bucket
# ============================================================================
log_step "Setting up storage bucket"

if gcloud storage buckets describe "gs://${BUCKET_NAME}" &>/dev/null; then
    log_success "Storage bucket already exists: $BUCKET_NAME"
else
    log_info "Creating storage bucket: $BUCKET_NAME"

    if ! gcloud storage buckets create "gs://${BUCKET_NAME}" \
        --location="$REGION" \
        --default-storage-class=STANDARD \
        --uniform-bucket-level-access; then
        log_error "Failed to create storage bucket"
        exit 1
    fi

    log_success "Created storage bucket: $BUCKET_NAME"
fi

# ============================================================================
# STEP 5: Upload tar.gz to Cloud Storage
# ============================================================================
log_step "Uploading tar.gz to Cloud Storage"

TAR_SIZE=$(stat -c%s "$TAR_FILE")
log_info "tar.gz file size: $TAR_SIZE bytes ($(numfmt --to=iec-i --suffix=B $TAR_SIZE))"
log_info "Uploading as: $BLOB_NAME"
log_info "This may take several minutes..."

if ! gcloud storage cp "$TAR_FILE" "gs://${BUCKET_NAME}/${BLOB_NAME}"; then
    log_error "Failed to upload tar.gz to Cloud Storage"
    exit 1
fi

BLOB_URI="gs://${BUCKET_NAME}/${BLOB_NAME}"
log_success "Uploaded tar.gz to: $BLOB_URI"

# ============================================================================
# STEP 6: Create GCE image from tar.gz
# ============================================================================
log_step "Creating GCE image from tar.gz"

log_info "Creating image: $NEW_IMAGE_NAME"
log_info "This may take 5-10 minutes..."

if ! gcloud compute images create "$NEW_IMAGE_NAME" \
    --source-uri "$BLOB_URI" \
    --storage-location="$REGION" \
    --guest-os-features="$IMAGE_OS_FEATURES"; then
    log_error "Failed to create GCE image"
    exit 1
fi

log_success "Created GCE image: $NEW_IMAGE_NAME"

# ============================================================================
# STEP 7: Promote ephemeral IP to static (if needed)
# ============================================================================
if [ "$PROMOTED_IP" = true ] && [ -n "$CURRENT_EXTERNAL_IP" ]; then
    log_step "Promoting ephemeral IP to static"

    log_info "Promoting $CURRENT_EXTERNAL_IP to static address: $STATIC_IP_NAME"

    # Get the region from the zone (e.g., us-central1-a -> us-central1)
    IP_REGION=$(echo "$VM_ZONE" | sed 's/-[a-z]$//')

    if ! gcloud compute addresses create "$STATIC_IP_NAME" \
        --addresses="$CURRENT_EXTERNAL_IP" \
        --region="$IP_REGION"; then
        log_error "Failed to promote ephemeral IP to static"
        echo ""
        echo "The IP address may have already been released or is not eligible for promotion."
        echo "Continuing without IP preservation..."
        STATIC_IP_NAME=""
        PROMOTED_IP=false
    else
        log_success "Promoted IP to static: $STATIC_IP_NAME ($CURRENT_EXTERNAL_IP)"
    fi
fi

# ============================================================================
# STEP 8: Delete existing VM
# ============================================================================
log_step "Deleting existing VM"

log_info "Deleting VM: $VM_NAME..."

if ! gcloud compute instances delete "$VM_NAME" \
    --zone="$VM_ZONE" \
    --quiet; then
    log_error "Failed to delete VM"
    exit 1
fi

log_success "Deleted VM: $VM_NAME"

# Wait a moment for resources to be fully released
log_info "Waiting for resources to be released..."
sleep 5

# ============================================================================
# STEP 9: Create new VM with preserved configuration
# ============================================================================
log_step "Creating new VM with preserved configuration"

log_info "Creating VM: $VM_NAME"
log_info "Image: $NEW_IMAGE_NAME"
log_info "Machine Type: $NEW_MACHINE_TYPE"
log_info "This may take 5-10 minutes..."

# Build the create command
CREATE_CMD="gcloud compute instances create $VM_NAME \
    --image=$NEW_IMAGE_NAME \
    --machine-type=$NEW_MACHINE_TYPE \
    --zone=$VM_ZONE \
    --confidential-compute-type=$CONFIDENTIAL_TYPE \
    --maintenance-policy=TERMINATE \
    --boot-disk-size=$PRESERVED_DISK_SIZE \
    --tags=$VM_TAGS"

# Add min-cpu-platform for SEV-SNP
if [ "$TEE_TYPE" = "sev-snp" ]; then
    CREATE_CMD="$CREATE_CMD --min-cpu-platform='AMD Milan'"
fi

# Add network configuration
if [ -n "$SUBNETWORK" ] && [ "$SUBNETWORK" != "None" ]; then
    CREATE_CMD="$CREATE_CMD --subnet=$SUBNETWORK"
fi

# Add static IP if available
if [ -n "$STATIC_IP_NAME" ]; then
    CREATE_CMD="$CREATE_CMD --address=$STATIC_IP_NAME"
fi

# Add metadata if present
METADATA_ITEMS=$(echo "$VM_METADATA_JSON" | jq -r '.metadata.items // [] | map("\(.key)=\(.value)") | join(",")' 2>/dev/null || echo "")
if [ -n "$METADATA_ITEMS" ]; then
    CREATE_CMD="$CREATE_CMD --metadata=$METADATA_ITEMS"
fi

if ! eval "$CREATE_CMD"; then
    log_error "Failed to create VM"
    echo ""
    echo "You can manually recreate the VM:"
    echo "  $CREATE_CMD"
    exit 1
fi

log_success "Created VM: $VM_NAME"

# ============================================================================
# STEP 10: Verify deployment
# ============================================================================
log_step "Verifying deployment"

# Get the new external IP
NEW_EXTERNAL_IP=$(gcloud compute instances describe "$VM_NAME" \
    --zone="$VM_ZONE" \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

log_info "Verifying IP address..."
if [ -n "$STATIC_IP_NAME" ]; then
    if [ "$NEW_EXTERNAL_IP" = "$CURRENT_EXTERNAL_IP" ]; then
        log_success "Static IP preserved: $NEW_EXTERNAL_IP"
    else
        log_warning "IP address changed: $CURRENT_EXTERNAL_IP -> $NEW_EXTERNAL_IP"
    fi
else
    log_info "New external IP: $NEW_EXTERNAL_IP (ephemeral)"
fi

# Verify VM status
VM_STATUS=$(gcloud compute instances describe "$VM_NAME" \
    --zone="$VM_ZONE" \
    --format='get(status)')
log_info "VM Status: $VM_STATUS"

# Wait for server to become available on port 3001
echo ""
log_info "Waiting for server to become available at http://${NEW_EXTERNAL_IP}:3001 ..."
log_info "You can press Ctrl+C to exit at any time."
echo ""

SERVER_URL="http://${NEW_EXTERNAL_IP}:3001/uptime"
MAX_ATTEMPTS=10  # Max 10 retries
ATTEMPT=0
SLEEP_INTERVAL=15

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    ATTEMPT=$((ATTEMPT + 1))

    # Try to connect - any HTTP response means the server is up
    if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$SERVER_URL" 2>/dev/null | grep -qE "^[2345]"; then
        echo ""
        log_success "Server is up!"
        log_success "http://${NEW_EXTERNAL_IP}:3001 is now accessible"
        break
    fi

    echo -ne "\r${YELLOW}[WAITING]${NC} Attempt $ATTEMPT: Waiting for server... (${SLEEP_INTERVAL}s intervals)    "
    sleep $SLEEP_INTERVAL
done

if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
    echo ""
    log_warning "Server check timed out after $MAX_ATTEMPTS attempts"
    log_info "The VM may still be starting up. Check manually:"
    log_info "  curl -v http://${NEW_EXTERNAL_IP}:3001/uptime"
fi

# ============================================================================
# Redeployment Complete
# ============================================================================
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║             REDEPLOYMENT COMPLETE                              ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "TEE Type:       $TEE_TYPE ($CONFIDENTIAL_TYPE)"
echo "VM Name:        $VM_NAME"
echo "External IP:    $NEW_EXTERNAL_IP"
echo "Image Name:     $NEW_IMAGE_NAME"
echo "Machine Type:   $NEW_MACHINE_TYPE"
echo "Zone:           $VM_ZONE"
echo "Deploy Hash:    $DEPLOY_HASH"
echo ""
echo "Resources created:"
echo "  - Blob: $BLOB_NAME"
echo "  - Image: $NEW_IMAGE_NAME"
echo ""
echo "Configuration preserved:"
echo "  - Boot Disk Size: $PRESERVED_DISK_SIZE"
echo "  - Network Tags: $VM_TAGS"
if [ -n "$STATIC_IP_NAME" ]; then
    echo "  - Static IP: $STATIC_IP_NAME"
fi
echo "  - Metadata: $(echo "$VM_METADATA_JSON" | jq -c '.metadata.items // []')"
echo ""
echo "Test the VM:"
echo "  curl http://${NEW_EXTERNAL_IP}:3001/uptime"
echo ""
echo "View serial console output:"
echo "  gcloud compute instances tail-serial-port-output $VM_NAME --zone=$VM_ZONE"
echo ""
echo "Connect via SSH (devtools only):"
echo "  gcloud compute ssh $VM_NAME --zone=$VM_ZONE"
echo ""
echo "Update metadata (e.g., manifest):"
echo "  gcloud compute instances add-metadata $VM_NAME --zone=$VM_ZONE --metadata=manifest=\$(base64 -w0 manifest.json)"
echo "  gcloud compute instances reset $VM_NAME --zone=$VM_ZONE"
echo ""
echo "Cleanup commands (for the new image resources, if needed):"
echo "  gcloud compute images delete $NEW_IMAGE_NAME --quiet"
echo "  gcloud storage rm gs://${BUCKET_NAME}/${BLOB_NAME}"
if [ "$PROMOTED_IP" = true ] && [ -n "$STATIC_IP_NAME" ]; then
    IP_REGION=$(echo "$VM_ZONE" | sed 's/-[a-z]$//')
    echo ""
    echo "Note: The ephemeral IP was promoted to static. To release it (after deleting the VM):"
    echo "  gcloud compute addresses delete $STATIC_IP_NAME --region=$IP_REGION --quiet"
fi
echo ""

# Cache the VM name for future redeployments
echo "$VM_NAME" > "$VM_NAME_CACHE_FILE"
log_info "Cached VM name '$VM_NAME' for future redeployments"
