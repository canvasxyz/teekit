#!/bin/bash
#
# Configures a dynv6 dynamic DNS zone for a GCP VM.
# Usage: ./config_gcp.sh
#
# The script will:
# 1. Prompt for a dynv6 API key (saved to .dynv6_api_key)
# 2. Prompt for a GCP VM name or IP address
# 3. Create a dynv6 zone with a hostname based on the IP
# 4. Wait for DNS propagation
# 5. Optionally set the hostname metadata on the VM
#
# Prerequisites:
# - Google Cloud CLI installed and logged in (if using VM name)
# - curl installed
#

set -euo pipefail

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

DYNV6_API_KEY_FILE=".dynv6_api_key"
DYNV6_GCP_NAME_FILE=".dynv6_gcp_name"
DYNV6_GCP_ZONE_FILE=".dynv6_gcp_zone"

# ============================================================================
# STEP 1: Get dynv6 API key
# ============================================================================
log_step "Configuring dynv6 API key"

if [ -f "$DYNV6_API_KEY_FILE" ]; then
    DYNV6_API_KEY=$(cat "$DYNV6_API_KEY_FILE")
    log_success "Using existing API key from $DYNV6_API_KEY_FILE"
else
    echo ""
    log_info "You can find your dynv6 API key under 'HTTP Tokens' at: https://dynv6.com/keys"
    read -p "Enter your dynv6 API key: " DYNV6_API_KEY

    if [ -z "$DYNV6_API_KEY" ]; then
        log_error "API key is required"
        exit 1
    fi

    echo "$DYNV6_API_KEY" > "$DYNV6_API_KEY_FILE"
    chmod 600 "$DYNV6_API_KEY_FILE"
    log_success "Saved API key to $DYNV6_API_KEY_FILE"
fi

# ============================================================================
# STEP 2: Get VM IP address
# ============================================================================
log_step "Getting VM IP address"

# Check for cached VM name/IP
CACHED_VM_INPUT=""
if [ -f "$DYNV6_GCP_NAME_FILE" ]; then
    CACHED_VM_INPUT=$(cat "$DYNV6_GCP_NAME_FILE")
fi

# Check for cached zone
CACHED_ZONE=""
if [ -f "$DYNV6_GCP_ZONE_FILE" ]; then
    CACHED_ZONE=$(cat "$DYNV6_GCP_ZONE_FILE")
fi

echo ""
if [ -n "$CACHED_VM_INPUT" ]; then
    log_info "Enter a GCP VM name or an IP address directly."
    read -p "GCP VM name or IP address [$CACHED_VM_INPUT]: " VM_INPUT
    if [ -z "$VM_INPUT" ]; then
        VM_INPUT="$CACHED_VM_INPUT"
    fi
else
    log_info "Enter a GCP VM name or an IP address directly."
    read -p "GCP VM name or IP address: " VM_INPUT
fi

if [ -z "$VM_INPUT" ]; then
    log_error "VM name or IP address is required"
    exit 1
fi

# Save for next time
echo "$VM_INPUT" > "$DYNV6_GCP_NAME_FILE"

# Check if input looks like an IP address
if [[ "$VM_INPUT" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    PUBLIC_IP="$VM_INPUT"
    log_success "Using IP address: $PUBLIC_IP"
    VM_NAME=""
else
    # Treat as GCP VM name
    VM_NAME="$VM_INPUT"
    log_info "Looking up public IP for GCP VM: $VM_NAME"

    # Check if gcloud is authenticated
    if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1 | grep -q .; then
        log_error "Not logged into gcloud CLI. Please run 'gcloud auth login' first."
        exit 1
    fi

    # Get zone - either cached or prompt
    if [ -n "$CACHED_ZONE" ]; then
        read -p "GCP zone [$CACHED_ZONE]: " GCP_ZONE
        if [ -z "$GCP_ZONE" ]; then
            GCP_ZONE="$CACHED_ZONE"
        fi
    else
        log_info "Enter the GCP zone where the VM is located (e.g., us-central1-a)"
        read -p "GCP zone: " GCP_ZONE
    fi

    if [ -z "$GCP_ZONE" ]; then
        log_error "GCP zone is required when using VM name"
        exit 1
    fi

    # Save zone for next time
    echo "$GCP_ZONE" > "$DYNV6_GCP_ZONE_FILE"

    # Get the external IP of the VM
    PUBLIC_IP=$(gcloud compute instances describe "$VM_NAME" \
        --zone="$GCP_ZONE" \
        --format="get(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null) || {
        log_error "Failed to get public IP for VM '$VM_NAME' in zone '$GCP_ZONE'"
        echo ""
        echo "Make sure the VM exists and you have access to it:"
        echo "  gcloud compute instances list"
        exit 1
    }

    if [ -z "$PUBLIC_IP" ] || [ "$PUBLIC_IP" == "None" ]; then
        log_error "VM '$VM_NAME' does not have a public IP address"
        exit 1
    fi

    log_success "Found public IP: $PUBLIC_IP"
fi

# ============================================================================
# STEP 3: Generate hostname and create dynv6 zone
# ============================================================================
log_step "Creating dynv6 zone"

# Convert IP to hostname format (dots to dashes)
IP_HOSTNAME=$(echo "$PUBLIC_IP" | tr '.' '-')
DEFAULT_HOSTNAME="${IP_HOSTNAME}.dynv6.net"

echo ""
log_info "Default hostname: $DEFAULT_HOSTNAME"
read -p "Enter hostname (or press Enter for default): " USER_HOSTNAME

if [ -z "$USER_HOSTNAME" ]; then
    HOSTNAME="$DEFAULT_HOSTNAME"
else
    # Ensure it ends with .dynv6.net
    if [[ ! "$USER_HOSTNAME" =~ \.dynv6\.net$ ]]; then
        HOSTNAME="${USER_HOSTNAME}.dynv6.net"
    else
        HOSTNAME="$USER_HOSTNAME"
    fi
fi

# Extract zone name (without .dynv6.net)
ZONE_NAME="${HOSTNAME%.dynv6.net}"

log_info "Creating zone: $HOSTNAME"

# Function to create zone (expects fully qualified name like "foo.dynv6.net")
create_zone() {
    local fqdn="$1"
    local response

    response=$(curl -s -X POST "https://dynv6.com/api/v2/zones" \
        -H "Authorization: Bearer $DYNV6_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"$fqdn\", \"ipv4address\": \"$PUBLIC_IP\"}")

    echo "$response"
}

# Function to check if zone creation succeeded
check_zone_response() {
    local response="$1"

    # Check for success (response contains zone ID)
    if echo "$response" | grep -q '"id"'; then
        return 0
    fi

    # Check for "already taken" error
    if echo "$response" | grep -qi "already taken\|already exists\|already in use"; then
        return 1
    fi

    # Other error
    return 2
}

# Try to create the zone
RESPONSE=$(create_zone "$HOSTNAME")
check_zone_response "$RESPONSE" && RESULT=0 || RESULT=$?

if [ $RESULT -eq 0 ]; then
    log_success "Created zone: $HOSTNAME"
elif [ $RESULT -eq 1 ]; then
    # Check if the existing hostname already points to our IP
    EXISTING_IP=$(dig +short "$HOSTNAME" A 2>/dev/null | head -1 || true)
    if [ "$EXISTING_IP" == "$PUBLIC_IP" ]; then
        log_success "Hostname '$HOSTNAME' already exists and points to $PUBLIC_IP"
    else
        log_warning "Hostname '$HOSTNAME' is already taken (points to ${EXISTING_IP:-unknown}), trying with hash suffix..."

        # Generate a short hash and try again
        HASH=$(openssl rand -hex 2)
        HOSTNAME="${IP_HOSTNAME}-${HASH}.dynv6.net"

        log_info "Trying: $HOSTNAME"

        RESPONSE=$(create_zone "$HOSTNAME")
        check_zone_response "$RESPONSE" && RESULT=0 || RESULT=$?

        if [ $RESULT -eq 0 ]; then
            log_success "Created zone: $HOSTNAME"
        elif [ $RESULT -eq 1 ]; then
            # Try one more time with a longer hash
            HASH=$(openssl rand -hex 4)
            HOSTNAME="${IP_HOSTNAME}-${HASH}.dynv6.net"

            log_info "Trying: $HOSTNAME"

            RESPONSE=$(create_zone "$HOSTNAME")
            check_zone_response "$RESPONSE" && RESULT=0 || RESULT=$?

            if [ $RESULT -eq 0 ]; then
                log_success "Created zone: $HOSTNAME"
            else
                log_error "Failed to create zone after multiple attempts"
                echo "API Response: $RESPONSE"
                exit 1
            fi
        else
            log_error "Failed to create zone: $HOSTNAME"
            echo "API Response: $RESPONSE"
            exit 1
        fi
    fi
else
    log_error "Failed to create zone: $HOSTNAME"
    echo "API Response: $RESPONSE"
    exit 1
fi

# ============================================================================
# STEP 4: Wait for DNS propagation
# ============================================================================
log_step "Waiting for DNS propagation"

echo ""
log_info "Checking DNS resolution for: $HOSTNAME"
log_info "Expected IP: $PUBLIC_IP"
log_info "You can press Ctrl+C to exit at any time once we're waiting."
echo ""

MAX_ATTEMPTS=60
ATTEMPT=0
SLEEP_SECONDS=10

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    ATTEMPT=$((ATTEMPT + 1))

    # Try to resolve the hostname
    RESOLVED_IP=$(dig +short "$HOSTNAME" A 2>/dev/null | head -1 || true)

    if [ "$RESOLVED_IP" == "$PUBLIC_IP" ]; then
        echo ""
        log_success "DNS propagation complete!"
        log_success "$HOSTNAME -> $PUBLIC_IP"
        break
    fi

    if [ -n "$RESOLVED_IP" ]; then
        echo -ne "\r${YELLOW}[WAITING]${NC} Attempt $ATTEMPT/$MAX_ATTEMPTS: Resolved to '$RESOLVED_IP' (expected: $PUBLIC_IP)    "
    else
        echo -ne "\r${YELLOW}[WAITING]${NC} Attempt $ATTEMPT/$MAX_ATTEMPTS: No DNS response yet...                              "
    fi

    sleep $SLEEP_SECONDS
done

if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
    echo ""
    log_warning "DNS propagation check timed out after $((MAX_ATTEMPTS * SLEEP_SECONDS)) seconds"
    log_info "The zone was created successfully. DNS may still propagate later."
    log_info "You can check manually with: dig $HOSTNAME"
fi

# ============================================================================
# STEP 5: Update GCP VM metadata (if VM name was provided)
# ============================================================================
log_step "Updating GCP VM metadata"

# If we only have an IP, prompt for VM name and zone
if [ -z "${VM_NAME:-}" ]; then
    echo ""
    log_info "To set the hostname metadata on a GCP VM, enter the VM name."
    log_info "Leave blank to skip this step."
    read -p "GCP VM name (or Enter to skip): " VM_NAME_INPUT

    if [ -n "$VM_NAME_INPUT" ]; then
        VM_NAME="$VM_NAME_INPUT"

        # Get zone if not already set
        if [ -z "${GCP_ZONE:-}" ]; then
            if [ -n "$CACHED_ZONE" ]; then
                read -p "GCP zone [$CACHED_ZONE]: " GCP_ZONE
                if [ -z "$GCP_ZONE" ]; then
                    GCP_ZONE="$CACHED_ZONE"
                fi
            else
                read -p "GCP zone: " GCP_ZONE
            fi

            if [ -n "$GCP_ZONE" ]; then
                echo "$GCP_ZONE" > "$DYNV6_GCP_ZONE_FILE"
            fi
        fi
    fi
fi

HOSTNAME_METADATA_SET=false

if [ -n "${VM_NAME:-}" ] && [ -n "${GCP_ZONE:-}" ]; then
    echo ""
    log_info "This will set the 'hostname' metadata on VM '$VM_NAME' to '$HOSTNAME'"
    log_info "The VM will use this hostname for TLS certificates."
    read -p "Set hostname metadata on VM? [Y/n]: " SET_HOSTNAME

    if [[ "$SET_HOSTNAME" == "n" || "$SET_HOSTNAME" == "N" ]]; then
        log_info "Skipping hostname metadata update"
        echo ""
        echo "You can set it manually later with:"
        echo "  gcloud compute instances add-metadata $VM_NAME --zone=$GCP_ZONE --metadata=hostname=$HOSTNAME"
    else
        log_info "Setting hostname metadata on VM '$VM_NAME'..."

        if gcloud compute instances add-metadata "$VM_NAME" \
            --zone="$GCP_ZONE" \
            --metadata="hostname=$HOSTNAME" 2>/dev/null; then
            log_success "Set hostname metadata: $HOSTNAME"
            HOSTNAME_METADATA_SET=true
        else
            log_warning "Failed to set hostname metadata on VM"
            echo ""
            echo "You can set it manually with:"
            echo "  gcloud compute instances add-metadata $VM_NAME --zone=$GCP_ZONE --metadata=hostname=$HOSTNAME"
        fi
    fi
else
    log_info "Skipping GCP VM metadata update (no VM name or zone provided)"
fi

# ============================================================================
# STEP 6: Restart VM (if hostname was set)
# ============================================================================
if [ "$HOSTNAME_METADATA_SET" = true ]; then
    echo ""
    log_info "The VM needs to restart to pick up the new hostname configuration."
    log_info "This will enable TLS certificate acquisition on next boot."
    read -p "Restart VM now? [Y/n]: " RESTART_VM

    if [[ "$RESTART_VM" == "n" || "$RESTART_VM" == "N" ]]; then
        log_info "Skipping restart"
        echo ""
        echo "You can restart the VM manually with:"
        echo "  gcloud compute instances reset $VM_NAME --zone=$GCP_ZONE"
    else
        log_info "Restarting VM '$VM_NAME'..."

        if gcloud compute instances reset "$VM_NAME" \
            --zone="$GCP_ZONE" 2>/dev/null; then
            log_success "VM restart initiated"
            log_info "The VM will acquire a TLS certificate for $HOSTNAME after restart."

            # Wait for HTTPS to come up
            echo ""
            log_info "Waiting for HTTPS to become available at https://$HOSTNAME ..."
            log_info "You can press Ctrl+C to exit at any time."
            echo ""

            HTTPS_URL="https://$HOSTNAME"
            HTTPS_MAX_ATTEMPTS=120  # 30 minutes max (120 * 15s)
            HTTPS_ATTEMPT=0
            HTTPS_SLEEP=15

            while [ $HTTPS_ATTEMPT -lt $HTTPS_MAX_ATTEMPTS ]; do
                HTTPS_ATTEMPT=$((HTTPS_ATTEMPT + 1))

                # Try to connect via HTTPS (allow self-signed certs during initial setup)
                if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$HTTPS_URL" 2>/dev/null | grep -qE "^[23]"; then
                    echo ""
                    log_success "HTTPS is up!"
                    log_success "$HTTPS_URL is now accessible"
                    break
                fi

                echo -ne "\r${YELLOW}[WAITING]${NC} Attempt $HTTPS_ATTEMPT: Waiting for HTTPS... (${HTTPS_SLEEP}s intervals)    "
                sleep $HTTPS_SLEEP
            done

            if [ $HTTPS_ATTEMPT -ge $HTTPS_MAX_ATTEMPTS ]; then
                echo ""
                log_warning "HTTPS check timed out after $((HTTPS_MAX_ATTEMPTS * HTTPS_SLEEP / 60)) minutes"
                log_info "The VM may still be starting up. Check manually:"
                log_info "  curl -v $HTTPS_URL"
            fi
        else
            log_warning "Failed to restart VM"
            echo ""
            echo "You can restart the VM manually with:"
            echo "  gcloud compute instances reset $VM_NAME --zone=$GCP_ZONE"
        fi
    fi
fi

# ============================================================================
# Configuration Complete
# ============================================================================
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║             CONFIGURATION COMPLETE                             ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Hostname:       $HOSTNAME"
echo "IP Address:     $PUBLIC_IP"
echo ""
echo "Test the hostname:"
echo "  dig $HOSTNAME"
echo "  curl http://$HOSTNAME:3001/healthz"
echo ""
echo "Manage your zone at:"
echo "  https://dynv6.com/zones"
echo ""
