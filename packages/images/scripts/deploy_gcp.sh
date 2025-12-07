#!/bin/bash
#
# Deploys a tar.gz image to GCP as a Confidential VM with Intel TDX or AMD SEV-SNP.
# Usage: ./deploy_gcp.sh --tdx|--sev-snp <tar.gz-file> [name]
#
# The script will:
# 1. Upload the tar.gz image to GCP Cloud Storage
# 2. Create a GCE image from the uploaded file
# 3. Create firewall rules (if they don't exist)
# 4. Create a Confidential VM from the image
#
# Prerequisites:
# - Google Cloud CLI installed and logged in (gcloud auth login)
# - A GCP project selected (gcloud config set project <project>)
#
# The script automatically:
# - Creates a storage bucket for images (if it doesn't exist)
# - Creates firewall rules for required ports
# - Prompts for manifest and Trust Authority configuration
#
# Examples:
#   ./deploy_gcp.sh --tdx build/tdx-debian.tar.gz
#   ./deploy_gcp.sh --tdx build/tdx-debian.tar.gz demo
#   ./deploy_gcp.sh --sev-snp build/tdx-debian.tar.gz
#   ./deploy_gcp.sh --sev-snp build/tdx-debian.tar.gz myvm
#

set -euo pipefail

# Configuration
BUCKET_NAME=""  # Will be set based on project ID
ZONE="us-central1-a"
REGION="us-central1"
BOOT_DISK_SIZE="200GB"

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
    log_error "Deployment failed. Resources created with name '$VM_NAME' may need manual cleanup."
    echo ""
    echo "To clean up, you can run:"
    echo "  gcloud compute instances delete $VM_NAME --zone=$ZONE --quiet 2>/dev/null"
    echo "  gcloud compute images delete $IMAGE_NAME --quiet 2>/dev/null"
    echo "  gcloud storage rm gs://${BUCKET_NAME}/${BLOB_NAME} 2>/dev/null"
    exit 1
}

# Validate arguments
if [ $# -lt 2 ]; then
    echo "Usage: $0 --tdx|--sev-snp <tar.gz-file> [name]"
    echo ""
    echo "Required first argument (TEE type):"
    echo "  --tdx        Deploy to Intel TDX machine (c3-standard-4)"
    echo "  --sev-snp    Deploy to AMD SEV-SNP machine (n2d-standard-2)"
    echo ""
    echo "Arguments:"
    echo "  tar.gz-file  Path to the tar.gz file to deploy (e.g., build/tdx-debian.tar.gz)"
    echo "  name         Optional name for the VM and image (default: random hash)"
    echo ""
    echo "Examples:"
    echo "  $0 --tdx build/tdx-debian.tar.gz"
    echo "  $0 --tdx build/tdx-debian.tar.gz demo"
    echo "  $0 --sev-snp build/tdx-debian.tar.gz"
    echo "  $0 --sev-snp build/tdx-debian.tar.gz myvm"
    exit 1
fi

# Parse required TEE type argument
TEE_TYPE=""
case "$1" in
    --tdx)
        TEE_TYPE="tdx"
        CONFIDENTIAL_TYPE="TDX"
        MACHINE_TYPE="c3-standard-4"
        IMAGE_OS_FEATURES="UEFI_COMPATIBLE,VIRTIO_SCSI_MULTIQUEUE,GVNIC,TDX_CAPABLE"
        VM_TAG="tdx-vm"
        FIREWALL_RULE_NAME="allow-tdx-ports"
        ;;
    --sev-snp)
        TEE_TYPE="sev-snp"
        CONFIDENTIAL_TYPE="SEV_SNP"
        MACHINE_TYPE="n2d-standard-2"
        IMAGE_OS_FEATURES="UEFI_COMPATIBLE,VIRTIO_SCSI_MULTIQUEUE,GVNIC,SEV_SNP_CAPABLE"
        VM_TAG="sev-snp-vm"
        FIREWALL_RULE_NAME="allow-sev-snp-ports"
        ;;
    *)
        echo "Error: First argument must be --tdx or --sev-snp"
        echo ""
        echo "Usage: $0 --tdx|--sev-snp <tar.gz-file> [name]"
        exit 1
        ;;
esac
shift

TAR_FILE="$1"

# Use provided name or generate random hash
if [ $# -ge 2 ]; then
    DEPLOY_HASH="$2"
else
    DEPLOY_HASH=$(openssl rand -hex 4)
fi
VM_NAME="gcp-${TEE_TYPE}-${DEPLOY_HASH}"
IMAGE_NAME="${TEE_TYPE}-debian-${DEPLOY_HASH}"

# Validate tar.gz file exists
if [ ! -f "$TAR_FILE" ]; then
    log_error "tar.gz file not found: $TAR_FILE"
    echo ""
    echo "Make sure you have built the image first:"
    echo "  npm run build:gcp          # For tdx-debian.tar.gz"
    echo "  npm run build:gcp:devtools # For devtools tar.gz"
    exit 1
fi

TAR_BASENAME=$(basename "$TAR_FILE")
BLOB_NAME="${TAR_BASENAME%.tar.gz}-${DEPLOY_HASH}.tar.gz"

echo ""
log_info "GCP Confidential VM Deployment"
log_info "==============================="
log_info "TEE Type: $TEE_TYPE ($CONFIDENTIAL_TYPE)"
log_info "Machine Type: $MACHINE_TYPE"
log_info "tar.gz File: $TAR_FILE"
log_info "Blob Name: $BLOB_NAME"
log_info "Image Name: $IMAGE_NAME"
log_info "VM Name: $VM_NAME"
log_info "Deploy Hash: $DEPLOY_HASH"
echo ""

# Set up error handler
trap cleanup_on_failure ERR

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

BUCKET_NAME="${PROJECT_ID}-tdx-images"
log_success "Logged in to GCP (Project: $PROJECT_ID)"

# ============================================================================
# STEP 2: Get or create storage bucket
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
# STEP 3: Upload tar.gz to Cloud Storage
# ============================================================================
log_step "Uploading tar.gz to Cloud Storage"

TAR_SIZE=$(stat -c%s "$TAR_FILE")
log_info "tar.gz file size: $TAR_SIZE bytes ($(numfmt --to=iec-i --suffix=B $TAR_SIZE))"
log_info "Uploading as: $BLOB_NAME"
log_info "This may take several minutes..."

if gcloud storage ls "gs://${BUCKET_NAME}/${BLOB_NAME}" &>/dev/null; then
    log_success "Blob already exists: $BLOB_NAME (skipping upload)"
else
    if ! gcloud storage cp "$TAR_FILE" "gs://${BUCKET_NAME}/${BLOB_NAME}"; then
        log_error "Failed to upload tar.gz to Cloud Storage"
        exit 1
    fi
fi

BLOB_URI="gs://${BUCKET_NAME}/${BLOB_NAME}"
log_success "Uploaded tar.gz to: $BLOB_URI"

# ============================================================================
# STEP 4: Create GCE image from tar.gz
# ============================================================================
log_step "Creating GCE image from tar.gz"

log_info "Creating image: $IMAGE_NAME"
log_info "This may take 5-10 minutes..."

# Check if image already exists
if gcloud compute images describe "$IMAGE_NAME" &>/dev/null; then
    log_success "Image already exists: $IMAGE_NAME (skipping creation)"
else
    if ! gcloud compute images create "$IMAGE_NAME" \
        --source-uri "$BLOB_URI" \
        --storage-location="$REGION" \
        --guest-os-features="$IMAGE_OS_FEATURES"; then
        log_error "Failed to create GCE image"
        echo ""
        echo "You can retry manually:"
        echo "  gcloud compute images create $IMAGE_NAME \\"
        echo "    --source-uri $BLOB_URI \\"
        echo "    --storage-location=$REGION \\"
        echo "    --guest-os-features=$IMAGE_OS_FEATURES"
        exit 1
    fi
fi

log_success "Created GCE image: $IMAGE_NAME"

# ============================================================================
# STEP 5: Create firewall rules (if they don't exist)
# ============================================================================
log_step "Configuring firewall rules"

if gcloud compute firewall-rules describe "$FIREWALL_RULE_NAME" &>/dev/null; then
    log_success "Firewall rule already exists: $FIREWALL_RULE_NAME"
else
    log_info "Creating firewall rule: $FIREWALL_RULE_NAME"

    if ! gcloud compute firewall-rules create "$FIREWALL_RULE_NAME" \
        --direction=INGRESS \
        --priority=1000 \
        --network=default \
        --action=ALLOW \
        --rules=tcp:80,tcp:443,tcp:3000,tcp:3001,tcp:8080,tcp:8090 \
        --source-ranges=0.0.0.0/0 \
        --target-tags="$VM_TAG"; then
        log_warning "Could not create firewall rule (may already exist or insufficient permissions)"
    else
        log_success "Created firewall rule: $FIREWALL_RULE_NAME"
    fi
fi

# ============================================================================
# STEP 6: Collect metadata configuration
# ============================================================================
log_step "Configuring VM metadata"

# Manifest configuration
MANIFEST=""
MANIFEST_FILE="kettle-artifacts/manifest.json"

echo ""
echo "Manifest Configuration:"
echo "  The manifest tells the VM which application to run."
echo ""

if [ -f "$MANIFEST_FILE" ]; then
    echo "  Found default manifest at: $MANIFEST_FILE"
    read -p "  Use default manifest? [Y/n]: " USE_DEFAULT_MANIFEST
    USE_DEFAULT_MANIFEST=${USE_DEFAULT_MANIFEST:-Y}

    if [[ "$USE_DEFAULT_MANIFEST" =~ ^[Yy] ]]; then
        MANIFEST=$(base64 -w0 "$MANIFEST_FILE")
        log_info "Using default manifest from $MANIFEST_FILE"
    fi
fi

if [ -z "$MANIFEST" ]; then
    echo "  Enter path to manifest.json (or press Enter to skip):"
    read -p "  Manifest path: " MANIFEST_PATH

    if [ -n "$MANIFEST_PATH" ] && [ -f "$MANIFEST_PATH" ]; then
        MANIFEST=$(base64 -w0 "$MANIFEST_PATH")
        log_info "Using manifest from $MANIFEST_PATH"
    elif [ -n "$MANIFEST_PATH" ]; then
        log_warning "File not found: $MANIFEST_PATH"
    fi
fi

if [ -z "$MANIFEST" ]; then
    log_warning "No manifest configured. VM will use default manifest if available."
    log_info "You can add a manifest later with:"
    log_info "  gcloud compute instances add-metadata $VM_NAME --metadata=manifest=\$(base64 -w0 manifest.json)"
fi

# Hostname configuration
echo ""
echo "Hostname Configuration (optional):"
echo "  Configure a custom hostname for the VM's services."
read -p "  Hostname (press Enter to skip): " HOSTNAME_CONFIG

if [ -n "$HOSTNAME_CONFIG" ]; then
    log_info "Hostname configured: $HOSTNAME_CONFIG"
fi

# Trust Authority configuration
echo ""
echo "Intel Trust Authority Configuration (optional, required for TDX only):"
echo "  Configure Trust Authority for attestation services."
read -p "  Trust Authority API Key (press Enter to skip): " TRUSTAUTHORITY_API_KEY

TRUSTAUTHORITY_API_URL=""
if [ -n "$TRUSTAUTHORITY_API_KEY" ]; then
    echo "  Trust Authority API URL (press Enter for default: https://api.trustauthority.intel.com):"
    read -p "  API URL: " TRUSTAUTHORITY_API_URL
    TRUSTAUTHORITY_API_URL=${TRUSTAUTHORITY_API_URL:-"https://api.trustauthority.intel.com"}
    log_info "Trust Authority configured with API URL: $TRUSTAUTHORITY_API_URL"
fi

# Build metadata string
METADATA_ARGS=""
if [ -n "$MANIFEST" ]; then
    METADATA_ARGS="manifest=${MANIFEST}"
fi
if [ -n "$HOSTNAME_CONFIG" ]; then
    if [ -n "$METADATA_ARGS" ]; then
        METADATA_ARGS="${METADATA_ARGS},hostname=${HOSTNAME_CONFIG}"
    else
        METADATA_ARGS="hostname=${HOSTNAME_CONFIG}"
    fi
fi
if [ -n "$TRUSTAUTHORITY_API_KEY" ]; then
    if [ -n "$METADATA_ARGS" ]; then
        METADATA_ARGS="${METADATA_ARGS},trustauthority_api_key=${TRUSTAUTHORITY_API_KEY}"
    else
        METADATA_ARGS="trustauthority_api_key=${TRUSTAUTHORITY_API_KEY}"
    fi
    if [ -n "$TRUSTAUTHORITY_API_URL" ]; then
        METADATA_ARGS="${METADATA_ARGS},trustauthority_api_url=${TRUSTAUTHORITY_API_URL}"
    fi
fi

# ============================================================================
# STEP 7: Create Confidential VM
# ============================================================================
log_step "Creating Confidential VM with $CONFIDENTIAL_TYPE"

log_info "Creating VM: $VM_NAME"
log_info "Machine Type: $MACHINE_TYPE"
log_info "Zone: $ZONE"
log_info "This may take 5-10 minutes..."

# Check if VM already exists
if gcloud compute instances describe "$VM_NAME" --zone="$ZONE" &>/dev/null; then
    log_success "VM already exists: $VM_NAME (skipping creation)"
else
    CREATE_CMD="gcloud compute instances create $VM_NAME \
        --image=$IMAGE_NAME \
        --machine-type=$MACHINE_TYPE \
        --zone=$ZONE \
        --confidential-compute-type=$CONFIDENTIAL_TYPE \
        --maintenance-policy=TERMINATE \
        --boot-disk-size=$BOOT_DISK_SIZE \
        --tags=$VM_TAG"

    # Add min-cpu-platform for SEV-SNP
    if [ "$TEE_TYPE" = "sev-snp" ]; then
        CREATE_CMD="$CREATE_CMD --min-cpu-platform='AMD Milan'"
    fi

    if [ -n "$METADATA_ARGS" ]; then
        CREATE_CMD="$CREATE_CMD --metadata=$METADATA_ARGS"
    fi

    if ! eval "$CREATE_CMD"; then
        log_error "Failed to create VM"
        echo ""
        echo "Common issues:"
        if [ "$TEE_TYPE" = "tdx" ]; then
            echo "  - Quota exceeded: Request quota increase for C3 confidential VMs"
            echo "  - Region availability: TDX may not be available in all zones"
        else
            echo "  - Quota exceeded: Request quota increase for N2D confidential VMs"
            echo "  - Region availability: SEV-SNP may not be available in all zones"
        fi
        echo ""
        echo "You can retry manually:"
        echo "  gcloud compute instances create $VM_NAME \\"
        echo "    --image=$IMAGE_NAME \\"
        echo "    --machine-type=$MACHINE_TYPE \\"
        echo "    --zone=$ZONE \\"
        echo "    --confidential-compute-type=$CONFIDENTIAL_TYPE \\"
        echo "    --maintenance-policy=TERMINATE \\"
        echo "    --boot-disk-size=$BOOT_DISK_SIZE \\"
        echo "    --tags=$VM_TAG"
        if [ "$TEE_TYPE" = "sev-snp" ]; then
            echo "    --min-cpu-platform=\"AMD Milan\""
        fi
        if [ -n "$METADATA_ARGS" ]; then
            echo "    --metadata=\"...\""
        fi
        exit 1
    fi
fi

log_success "Created VM: $VM_NAME"

# ============================================================================
# STEP 8: Get VM public IP
# ============================================================================
log_step "Getting VM public IP"

EXTERNAL_IP=$(gcloud compute instances describe "$VM_NAME" \
    --zone="$ZONE" \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

log_success "VM external IP: $EXTERNAL_IP"

# ============================================================================
# Deployment Complete
# ============================================================================
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║             DEPLOYMENT COMPLETE                                ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "TEE Type:       $TEE_TYPE ($CONFIDENTIAL_TYPE)"
echo "VM Name:        $VM_NAME"
echo "External IP:    $EXTERNAL_IP"
echo "Image Name:     $IMAGE_NAME"
echo "Machine Type:   $MACHINE_TYPE"
echo "Deploy Hash:    $DEPLOY_HASH"
echo ""
echo "Resources created:"
echo "- Storage Bucket: $BUCKET_NAME"
echo "- Blob: $BLOB_NAME"
echo "- Image: $IMAGE_NAME"
echo "- VM: $VM_NAME"
echo ""
echo "Test the VM:"
echo "curl http://${EXTERNAL_IP}:8080/uptime"
echo "curl http://${EXTERNAL_IP}:3001/healthz"
echo ""
echo "View serial console output:"
echo "gcloud compute instances tail-serial-port-output $VM_NAME --zone=$ZONE"
echo ""
echo "Connect via SSH (devtools only):"
echo "gcloud compute ssh $VM_NAME --zone=$ZONE"
echo ""
echo "Update metadata (e.g., manifest):"
echo "gcloud compute instances add-metadata $VM_NAME --zone=$ZONE --metadata=manifest=\$(base64 -w0 manifest.json)"
echo "gcloud compute instances reset $VM_NAME --zone=$ZONE"
echo ""
echo "Cleanup commands (if needed):"
echo "gcloud compute instances delete $VM_NAME --zone=$ZONE --quiet"
echo "gcloud compute images delete $IMAGE_NAME --quiet"
echo "gcloud storage rm gs://${BUCKET_NAME}/${BLOB_NAME}"
