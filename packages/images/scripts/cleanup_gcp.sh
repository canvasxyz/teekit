#!/bin/bash
#
# Cleans up GCP resources created by deploy_gcp.sh
# Usage: ./cleanup_gcp.sh [--dry-run]
#
# This script will:
# 1. Delete all VMs matching "kettle-*" or "tdx-*" patterns (with associated disks)
# 2. Delete all images matching "kettle-*" or "tdx-*" patterns
# 3. Delete all tar.gz blobs from the storage bucket
#
# Prerequisites:
# - Google Cloud CLI installed and logged in (gcloud auth login)
# - A GCP project selected (gcloud config set project <project>)
#
# NOTE: The following resources are NOT cleaned up by this script:
# - The storage bucket itself - reusable across deployments
# - Firewall rules - may be shared infrastructure
# - VPCs and subnets - may be shared infrastructure
#

set -euo pipefail

# Configuration
ZONE="us-central1-a"
VM_PATTERNS=("kettle-" "tdx-")

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
    echo -e "${GREEN}===============================================================${NC}"
    echo -e "${GREEN}STEP: $1${NC}"
    echo -e "${GREEN}===============================================================${NC}"
}

# ============================================================================
# Header
# ============================================================================
echo ""
log_info "GCP TDX Resource Cleanup"
log_info "========================"

# Verify GCP CLI login
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1 | grep -q "."; then
    log_error "Not logged into GCP CLI. Please run 'gcloud auth login' first."
    exit 1
fi

PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
    log_error "No GCP project selected. Please run 'gcloud config set project <project>' first."
    exit 1
fi

BUCKET_NAME="${PROJECT_ID}-images"

log_info "Project: $PROJECT_ID"
log_info "Storage Bucket: $BUCKET_NAME"
log_info "VM Patterns: ${VM_PATTERNS[*]}"

if [ "$DRY_RUN" = true ]; then
    log_warning "DRY-RUN MODE: No resources will be deleted"
else
    echo ""
    log_warning "This will delete all deployment-specific GCP resources including VMs,"
    log_warning "disks, images, and storage blobs. Use --dry-run to see what would be deleted."
    echo ""
    read -p "Are you sure you want to proceed? [y/N]: " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        log_info "Aborted by user."
        exit 0
    fi
fi
echo ""

# ============================================================================
# STEP 1: Find and delete VMs matching patterns
# ============================================================================
log_step "Finding VMs matching patterns"

# Get all VMs
ALL_VMS=$(gcloud compute instances list --format="csv[no-heading](name,zone)" 2>/dev/null || echo "")

if [ -z "$ALL_VMS" ]; then
    log_info "No VMs found in project"
else
    TOTAL_VM_COUNT=$(echo "$ALL_VMS" | wc -l | tr -d ' ')
    log_info "Found $TOTAL_VM_COUNT total VM(s) in project"
    echo ""

    # Separate VMs into those matching patterns and those not matching
    VM_LIST=""
    NON_MATCHING_VMS=""

    while IFS=',' read -r vm zone; do
        MATCHES=false
        for pattern in "${VM_PATTERNS[@]}"; do
            if [[ "$vm" == ${pattern}* ]]; then
                MATCHES=true
                break
            fi
        done

        # Extract just the zone name
        zone=$(basename "$zone" 2>/dev/null || echo "$zone")

        if [ "$MATCHES" = true ]; then
            VM_LIST="${VM_LIST}${vm},${zone}"$'\n'
        else
            NON_MATCHING_VMS="${NON_MATCHING_VMS}${vm},${zone}"$'\n'
        fi
    done <<< "$ALL_VMS"

    # Trim trailing newlines
    VM_LIST=$(echo "$VM_LIST" | sed '/^$/d')
    NON_MATCHING_VMS=$(echo "$NON_MATCHING_VMS" | sed '/^$/d')

    # Show VMs that will be deleted
    if [ -z "$VM_LIST" ]; then
        log_info "No VMs match deletion patterns"
    else
        VM_COUNT=$(echo "$VM_LIST" | wc -l | tr -d ' ')
        echo -e "${GREEN}VMs matching patterns (WILL BE DELETED):${NC}"
        echo "$VM_LIST" | while IFS=',' read -r vm zone; do
            # Get the VM's external IP
            VM_IP=$(gcloud compute instances describe "$vm" --zone="$zone" \
                --format="value(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || echo "")
            if [ -n "$VM_IP" ]; then
                echo -e "  ${RED}x${NC} $vm (zone: $zone, IP: $VM_IP)"
            else
                echo -e "  ${RED}x${NC} $vm (zone: $zone, IP: <none>)"
            fi
        done
    fi

    # Show VMs that will NOT be deleted
    if [ -n "$NON_MATCHING_VMS" ]; then
        echo ""
        echo -e "${YELLOW}VMs NOT matching patterns (will be preserved):${NC}"
        echo "$NON_MATCHING_VMS" | while IFS=',' read -r vm zone; do
            # Get the VM's external IP
            VM_IP=$(gcloud compute instances describe "$vm" --zone="$zone" \
                --format="value(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || echo "")
            if [ -n "$VM_IP" ]; then
                echo -e "  ${GREEN}o${NC} $vm (zone: $zone, IP: $VM_IP)"
            else
                echo -e "  ${GREEN}o${NC} $vm (zone: $zone, IP: <none>)"
            fi
        done
    fi
    echo ""
fi

# Only proceed with deletion if we have VMs matching the patterns
if [ -z "$VM_LIST" ]; then
    log_info "No VMs to delete, skipping VM cleanup"
else
    # Delete VMs (with --delete-disks=all to clean up attached disks)
    echo "$VM_LIST" | while IFS=',' read -r VM_NAME VM_ZONE; do
        if [ "$DRY_RUN" = true ]; then
            log_dry_run "Delete VM: $VM_NAME (zone: $VM_ZONE) with attached disks"
        else
            log_info "Deleting VM: $VM_NAME (zone: $VM_ZONE)"
            if gcloud compute instances delete "$VM_NAME" --zone="$VM_ZONE" --delete-disks=all --quiet 2>/dev/null; then
                log_success "Deleted VM: $VM_NAME"
            else
                log_warning "Failed to delete VM: $VM_NAME (may not exist)"
            fi
        fi
    done
fi

# ============================================================================
# STEP 2: Delete images matching patterns
# ============================================================================
log_step "Finding images matching patterns"

# List images that match our naming convention (kettle-* or tdx-*)
IMAGE_LIST=$(gcloud compute images list --filter="name~'^(kettle-|tdx-)'" --format="csv[no-heading](name)" 2>/dev/null || echo "")

if [ -z "$IMAGE_LIST" ]; then
    log_info "No images found matching patterns"
else
    IMAGE_COUNT=$(echo "$IMAGE_LIST" | wc -l | tr -d ' ')
    log_info "Found $IMAGE_COUNT image(s) to delete:"
    echo "$IMAGE_LIST" | while read -r img; do
        echo "  - $img"
    done
    echo ""

    for IMAGE_NAME in $IMAGE_LIST; do
        if [ "$DRY_RUN" = true ]; then
            log_dry_run "Delete image: $IMAGE_NAME"
        else
            log_info "Deleting image: $IMAGE_NAME"
            if gcloud compute images delete "$IMAGE_NAME" --quiet 2>/dev/null; then
                log_success "Deleted image: $IMAGE_NAME"
            else
                log_warning "Failed to delete image: $IMAGE_NAME"
            fi
        fi
    done
fi

# ============================================================================
# STEP 3: Delete tar.gz blobs from storage bucket
# ============================================================================
log_step "Cleaning up tar.gz blobs from storage bucket"

if ! gcloud storage buckets describe "gs://${BUCKET_NAME}" &>/dev/null; then
    log_warning "Storage bucket '$BUCKET_NAME' does not exist, skipping blob cleanup"
else
    log_info "Found storage bucket: $BUCKET_NAME"

    # List tar.gz blobs (just the names)
    BLOB_LIST=$(gcloud storage ls "gs://${BUCKET_NAME}/*.tar.gz" 2>/dev/null || echo "")

    if [ -z "$BLOB_LIST" ]; then
        log_info "No tar.gz blobs found in bucket"
    else
        BLOB_COUNT=$(echo "$BLOB_LIST" | wc -l | tr -d ' ')
        log_info "Found $BLOB_COUNT tar.gz blob(s) to delete:"
        echo "$BLOB_LIST" | while read -r blob_path; do
            blob_name=$(basename "$blob_path" 2>/dev/null || echo "$blob_path")
            echo "  - $blob_name"
        done
        echo ""

        for BLOB_PATH in $BLOB_LIST; do
            BLOB_NAME=$(basename "$BLOB_PATH" 2>/dev/null || echo "$BLOB_PATH")
            if [ "$DRY_RUN" = true ]; then
                log_dry_run "Delete blob: $BLOB_NAME"
            else
                log_info "Deleting blob: $BLOB_NAME"
                if gcloud storage rm "$BLOB_PATH" 2>/dev/null; then
                    log_success "Deleted blob: $BLOB_NAME"
                else
                    log_warning "Failed to delete blob: $BLOB_NAME"
                fi
            fi
        done
    fi
fi

# ============================================================================
# Cleanup Complete
# ============================================================================
echo ""
if [ "$DRY_RUN" = true ]; then
    echo -e "${CYAN}+---------------------------------------------------------------+${NC}"
    echo -e "${CYAN}|             DRY-RUN COMPLETE                                  |${NC}"
    echo -e "${CYAN}+---------------------------------------------------------------+${NC}"
    echo ""
    echo "No resources were deleted. Run without --dry-run to perform actual cleanup."
else
    echo -e "${GREEN}+---------------------------------------------------------------+${NC}"
    echo -e "${GREEN}|             CLEANUP COMPLETE                                  |${NC}"
    echo -e "${GREEN}+---------------------------------------------------------------+${NC}"
fi
echo ""
echo "Resources NOT cleaned up (by design):"
echo "  - Storage bucket: $BUCKET_NAME"
echo "  - Firewall rules"
echo "  - VPCs and subnets"
echo ""
