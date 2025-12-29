#!/bin/bash
#
# Lists currently active GCP resources for TDX deployments.
# Usage: ./ls_gcp.sh
#
# Lists the following resources:
# - Compute Instances (VMs with status, IP, machine type)
# - Disks
# - Images (TDX images)
# - Storage Bucket and tar.gz blobs
# - Firewall Rules
#
# Prerequisites:
# - Google Cloud CLI installed and logged in (gcloud auth login)
# - A GCP project selected (gcloud config set project <project>)
#

set -euo pipefail

# Configuration
ZONE="us-central1-a"
REGION="us-central1"

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
# Verify GCP CLI login
# ============================================================================
log_info "Verifying GCP CLI login..."

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
log_success "Logged in to GCP (Project: $PROJECT_ID)"
echo ""
log_info "Default Zone: $ZONE"
log_info "Storage Bucket: $BUCKET_NAME"

# ============================================================================
# Compute Instances (VMs)
# ============================================================================
log_section "COMPUTE INSTANCES (VMs)"

VM_LIST=$(gcloud compute instances list --format="csv[no-heading](name,zone,status,networkInterfaces[0].accessConfigs[0].natIP,machineType)" 2>/dev/null || echo "")

if [ -z "$VM_LIST" ]; then
    log_warning "No VMs found"
else
    VM_COUNT=$(echo "$VM_LIST" | wc -l)
    log_success "Found $VM_COUNT VM(s)"
    echo ""
    printf "${GREEN}%-25s %-18s %-12s %-18s %-25s${NC}\n" "NAME" "ZONE" "STATUS" "EXTERNAL IP" "MACHINE TYPE"
    printf "%s\n" "$(printf '%.0s-' {1..90})"

    echo "$VM_LIST" | while IFS=',' read -r name zone status external_ip machine_type; do
        # Handle empty external IP
        if [ -z "$external_ip" ]; then
            external_ip="-"
        fi

        # Extract just the machine type name from the full URL
        machine_type=$(basename "$machine_type" 2>/dev/null || echo "$machine_type")

        # Extract just the zone name from the full URL
        zone=$(basename "$zone" 2>/dev/null || echo "$zone")

        # Color status
        if [[ "$status" == "RUNNING" ]]; then
            status_display="${GREEN}${status}${NC}"
        elif [[ "$status" == "TERMINATED" ]] || [[ "$status" == "STOPPED" ]]; then
            status_display="${YELLOW}${status}${NC}"
        else
            status_display="${RED}${status}${NC}"
        fi

        printf "%-25s %-18s %-23b %-18s %-18s\n" "$name" "$zone" "$status_display" "$external_ip" "$machine_type"

        # Show service URLs for running VMs with external IPs
        if [[ "$status" == "RUNNING" ]] && [ "$external_ip" != "-" ]; then
            printf "%-25s %-18s %-12s ${CYAN}http://%s:3001${NC}\n" "" "" "" "$external_ip"
        fi
    done
fi

# ============================================================================
# Disks
# ============================================================================
log_section "DISKS"

DISK_LIST=$(gcloud compute disks list --format="csv[no-heading](name,zone,sizeGb,status,users)" 2>/dev/null || echo "")

if [ -z "$DISK_LIST" ]; then
    log_warning "No disks found"
else
    DISK_COUNT=$(echo "$DISK_LIST" | wc -l)
    log_success "Found $DISK_COUNT disk(s)"
    echo ""
    printf "${GREEN}%-25s %-20s %-12s %-10s %-20s${NC}\n" "NAME" "ZONE" "SIZE (GB)" "STATUS" "ATTACHED TO"
    printf "%s\n" "$(printf '%.0s-' {1..90})"

    echo "$DISK_LIST" | while IFS=',' read -r name zone size status users; do
        # Extract just the zone name
        zone=$(basename "$zone" 2>/dev/null || echo "$zone")

        # Extract VM name from users path
        if [ -z "$users" ]; then
            attached_to="-"
        else
            attached_to=$(basename "$users" 2>/dev/null || echo "$users")
        fi

        printf "%-25s %-20s %-12s %-10s %-20s\n" "$name" "$zone" "$size" "$status" "$attached_to"
    done
fi

# ============================================================================
# Images
# ============================================================================
log_section "IMAGES (Filtered to Kettles)"

# List images that match our naming convention (kettle-* or tdx-*)
IMAGE_LIST=$(gcloud compute images list --filter="name~'^(kettle-|tdx-)'" --format="csv[no-heading](name,status,diskSizeGb,creationTimestamp)" 2>/dev/null || echo "")

if [ -z "$IMAGE_LIST" ]; then
    log_warning "No images found"
else
    IMAGE_COUNT=$(echo "$IMAGE_LIST" | wc -l)
    log_success "Found $IMAGE_COUNT image(s)"
    echo ""
    printf "${GREEN}%-40s %-10s %-12s %-25s${NC}\n" "NAME" "STATUS" "SIZE (GB)" "CREATED"
    printf "%s\n" "$(printf '%.0s-' {1..90})"

    echo "$IMAGE_LIST" | while IFS=',' read -r name status size created; do
        # Truncate timestamp
        created="${created:0:19}"

        printf "%-40s %-10s %-12s %-25s\n" "$name" "$status" "$size" "$created"
    done
fi

# ============================================================================
# Storage Bucket and Blobs
# ============================================================================
log_section "STORAGE BUCKET & TAR.GZ BLOBS"

if ! gcloud storage buckets describe "gs://${BUCKET_NAME}" &>/dev/null; then
    log_warning "Storage bucket '$BUCKET_NAME' does not exist"
else
    log_success "Storage bucket exists: $BUCKET_NAME"

    # List tar.gz blobs
    BLOB_LIST=$(gcloud storage ls -l "gs://${BUCKET_NAME}/*.tar.gz" 2>/dev/null | grep -v "TOTAL:" || echo "")

    if [ -z "$BLOB_LIST" ]; then
        log_info "No tar.gz blobs in bucket"
    else
        BLOB_COUNT=$(echo "$BLOB_LIST" | wc -l)
        log_success "Found $BLOB_COUNT tar.gz blob(s)"
        echo ""
        printf "${GREEN}%-50s %-15s %-25s${NC}\n" "BLOB NAME" "SIZE" "CREATED"
        printf "%s\n" "$(printf '%.0s-' {1..90})"

        echo "$BLOB_LIST" | while read -r size created blob_path; do
            # Extract just the blob name
            blob_name=$(basename "$blob_path" 2>/dev/null || echo "$blob_path")

            # Format size
            if [ -n "$size" ] && [ "$size" != "0" ]; then
                size_hr=$(numfmt --to=iec-i --suffix=B "$size" 2>/dev/null || echo "$size")
            else
                size_hr="-"
            fi

            # Truncate timestamp
            created="${created:0:19}"

            printf "%-50s %-15s %-25s\n" "$blob_name" "$size_hr" "$created"
        done
    fi
fi

# ============================================================================
# Firewall Rules
# ============================================================================
log_section "FIREWALL RULES (TDX)"

# List firewall rules related to TDX
FIREWALL_LIST=$(gcloud compute firewall-rules list --filter="name~'tdx' OR targetTags~'tdx'" --format="csv[no-heading](name,direction,targetTags,allowed)" 2>/dev/null || echo "")

if [ -z "$FIREWALL_LIST" ]; then
    log_warning "No TDX-related firewall rules found"
else
    FIREWALL_COUNT=$(echo "$FIREWALL_LIST" | wc -l)
    log_success "Found $FIREWALL_COUNT firewall rule(s)"
    echo ""
    printf "${GREEN}%-20s %-10s %-12s %-10s %-10s${NC}\n" "NAME" "DIRECTION" "TARGET" "PROTOCOL" "PORTS"
    printf "%s\n" "$(printf '%.0s-' {1..90})"

    echo "$FIREWALL_LIST" | while IFS=',' read -r name direction tags allowed; do
        # The allowed field may contain multiple rules separated by semicolons
        # Each rule is like: {'IPProtocol': 'tcp', 'ports': ['80']}
        # Convert to JSON array and parse

        # Remove quotes around each object, replace semicolon separators with commas, convert single to double quotes
        allowed_clean=$(echo "$allowed" | sed 's/";"/,/g; s/^"//; s/"$//' | tr "'" '"')

        # Build a JSON array
        allowed_array="[$allowed_clean]"

        # Extract protocols and ports
        protocol=$(echo "$allowed_array" | jq -r '[.[].IPProtocol] | unique | join(",")' 2>/dev/null || echo "-")
        ports=$(echo "$allowed_array" | jq -r '[.[].ports[]?] | unique | join(",")' 2>/dev/null || echo "-")

        # Handle empty values
        [ -z "$protocol" ] && protocol="-"
        [ -z "$ports" ] && ports="-"
        [ -z "$tags" ] && tags="-"

        printf "%-20s %-10s %-12s %-10s %-10s\n" "$name" "$direction" "$tags" "$protocol" "$ports"
    done
fi

# ============================================================================
# Summary
# ============================================================================
log_section "USEFUL COMMANDS"

echo ""
echo "VM Operations:"
echo "  gcloud compute instances tail-serial-port-output <VM_NAME>"
echo "  gcloud compute ssh <VM_NAME>"
echo "  gcloud compute instances start <VM_NAME>"
echo "  gcloud compute instances stop <VM_NAME>"
echo "  gcloud compute instances delete <VM_NAME> --quiet"
echo "  gcloud compute instances reset <VM_NAME>"
echo ""
echo "Image Operations:"
echo "  gcloud compute images delete <IMAGE_NAME> --quiet"
echo ""
echo "Storage Operations:"
echo "  gcloud storage rm gs://${BUCKET_NAME}/<BLOB_NAME>"
echo ""
echo "Update VM metadata:"
echo "  gcloud compute instances add-metadata <VM_NAME> --metadata=manifest=\$(base64 -w0 manifest.json)"
echo "  gcloud compute instances reset <VM_NAME> --zone=$ZONE"
echo ""
