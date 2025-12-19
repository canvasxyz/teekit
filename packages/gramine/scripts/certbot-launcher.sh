#!/bin/bash
set -euo pipefail

# certbot-launcher.sh
# Handles Let's Encrypt certificate acquisition and nginx configuration
# for routing hostnames to kettle instances.
#
# This script runs OUTSIDE the SGX enclave on the host system.
# Certificates are stored in plain text (not encrypted with sealing key).
#
# Usage:
#   HOSTNAME_CONFIG="example.com,app.example.com" ./certbot-launcher.sh
#
# Environment variables:
#   HOSTNAME_CONFIG - Comma-separated list of hostnames for TLS certificates
#   KETTLE_COUNT - Number of kettles (default: auto-detect from hostnames)

LOG_PREFIX="[certbot-launcher]"
NGINX_CONF_DIR="/etc/nginx"
NGINX_SITES_AVAILABLE="${NGINX_CONF_DIR}/sites-available"
NGINX_SITES_ENABLED="${NGINX_CONF_DIR}/sites-enabled"
CERT_DIR="/etc/letsencrypt/live"
ACME_WEBROOT="/var/www/letsencrypt"
ENV_FILE="/etc/kettle/cloud-launcher.env"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "${GREEN}$LOG_PREFIX${NC} [$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

error() {
    echo -e "${RED}$LOG_PREFIX${NC} [$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
}

warn() {
    echo -e "${YELLOW}$LOG_PREFIX${NC} [$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $*"
}

# Parse and validate hostnames
parse_hostnames() {
    local hostname_input="$1"

    # Handle empty/null input
    if [ -z "$hostname_input" ] || [ "$hostname_input" = "null" ]; then
        echo ""
        return 0
    fi

    # Split by comma and process
    IFS=',' read -ra hostname_array <<< "$hostname_input"

    local valid_hostnames=()
    for hostname in "${hostname_array[@]}"; do
        # Trim whitespace
        hostname=$(echo "$hostname" | xargs)

        # Skip empty/null values
        if [ -z "$hostname" ] || [ "$hostname" = "null" ]; then
            continue
        fi

        # Validate hostname format (basic check)
        if [[ "$hostname" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$ ]]; then
            valid_hostnames+=("$hostname")
        else
            error "Invalid hostname format: $hostname"
        fi
    done

    # Deduplicate hostnames while preserving order
    local unique_hostnames=()
    local seen_map=()
    for hostname in "${valid_hostnames[@]}"; do
        if [[ ! " ${seen_map[*]:-} " =~ " ${hostname} " ]]; then
            unique_hostnames+=("$hostname")
            seen_map+=("$hostname")
        fi
    done

    # Return space-separated list
    echo "${unique_hostnames[*]:-}"
}

# Create initial nginx config for ACME challenge
create_acme_nginx_config() {
    local hostnames=("$@")

    log "Creating ACME challenge nginx configuration"

    # Remove default nginx site to avoid conflicts
    rm -f "${NGINX_SITES_ENABLED}/default"

    # Create webroot directory
    mkdir -p "$ACME_WEBROOT"

    # Create nginx config for HTTP only (for ACME challenge)
    cat > "${NGINX_SITES_AVAILABLE}/acme-challenge" <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name ${hostnames[*]};

    location /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
    }

    location / {
        return 200 'ACME challenge server ready\n';
        add_header Content-Type text/plain;
    }
}
EOF

    # Enable the configuration
    ln -sf "${NGINX_SITES_AVAILABLE}/acme-challenge" "${NGINX_SITES_ENABLED}/acme-challenge"

    # Test nginx configuration
    if ! nginx -t 2>&1; then
        error "Invalid nginx configuration for ACME challenge"
        return 1
    fi

    return 0
}

# Start or reload nginx
start_nginx() {
    log "Starting nginx"

    # Check if nginx is already running
    if systemctl is-active --quiet nginx 2>/dev/null; then
        log "Nginx is already running, reloading"
        if ! systemctl reload nginx 2>&1; then
            error "Failed to reload nginx"
            return 1
        fi
    else
        # Try systemctl first, fall back to direct nginx command
        if command -v systemctl &> /dev/null && systemctl start nginx 2>&1; then
            log "Started nginx via systemctl"
        elif nginx 2>&1; then
            log "Started nginx directly"
        else
            error "Failed to start nginx"
            return 1
        fi
    fi

    return 0
}

# Obtain Let's Encrypt certificate
obtain_certificate() {
    local hostnames=("$@")

    log "Obtaining Let's Encrypt certificate for: ${hostnames[*]}"

    # Build certbot command
    local certbot_cmd=(
        certbot certonly
        --webroot
        -w "$ACME_WEBROOT"
        --non-interactive
        --agree-tos
        --email "admin@${hostnames[0]}"
        --keep-until-expiring
    )

    # Add all hostnames
    for hostname in "${hostnames[@]}"; do
        certbot_cmd+=(-d "$hostname")
    done

    # Try to obtain certificate with retry (up to 5 attempts with exponential backoff)
    local max_attempts=5
    local attempt=1
    local wait_time=30

    while [ $attempt -le $max_attempts ]; do
        log "Certificate attempt $attempt/$max_attempts"

        if "${certbot_cmd[@]}" 2>&1; then
            log "Certificate obtained successfully on attempt $attempt"
            return 0
        fi

        if [ $attempt -lt $max_attempts ]; then
            log "Certificate request failed, waiting ${wait_time}s before retry..."
            sleep "$wait_time"
            wait_time=$((wait_time * 2))
        fi

        attempt=$((attempt + 1))
    done

    error "Failed to obtain Let's Encrypt certificate after $max_attempts attempts"
    return 1
}

# Create production nginx configuration with HTTPS
create_production_nginx_config() {
    local hostnames=("$@")
    local first_hostname="${hostnames[0]}"

    log "Creating production nginx configuration"

    # Remove ACME challenge config
    rm -f "${NGINX_SITES_ENABLED}/acme-challenge"

    # Start building the config
    cat > "${NGINX_SITES_AVAILABLE}/kettles" <<'EOF_START'
# Kettle SSL Configuration - Generated by certbot-launcher.sh
EOF_START

    # HTTP server - redirect to HTTPS
    cat >> "${NGINX_SITES_AVAILABLE}/kettles" <<EOF

server {
    listen 80;
    listen [::]:80;
    server_name ${hostnames[*]};

    location /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF

    # HTTPS servers - one per hostname
    local kettle_index=0
    local processed=()
    for hostname in "${hostnames[@]}"; do
        local kettle_port=$((3001 + kettle_index * 2))  # 3001, 3003, 3005...
        local https_port=443

        # Check if this hostname was already processed (handle duplicates)
        local instance=0
        for prev_hostname in "${processed[@]:-}"; do
            if [ "$prev_hostname" = "$hostname" ]; then
                instance=$((instance + 1))
                https_port=$((443 + instance))
            fi
        done

        processed+=("$hostname")

        # SSL certificate path (use first hostname for SAN cert)
        local cert_path="${CERT_DIR}/${first_hostname}"

        log "Mapping ${hostname}:${https_port} -> kettle on port ${kettle_port}"

        # Create HTTPS server block
        cat >> "${NGINX_SITES_AVAILABLE}/kettles" <<EOF

server {
    listen ${https_port} ssl http2;
    listen [::]:${https_port} ssl http2;
    server_name ${hostname};

    ssl_certificate ${cert_path}/fullchain.pem;
    ssl_certificate_key ${cert_path}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # WebSocket support
    location / {
        proxy_pass http://127.0.0.1:${kettle_port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
EOF

        kettle_index=$((kettle_index + 1))
    done

    # Enable the configuration
    ln -sf "${NGINX_SITES_AVAILABLE}/kettles" "${NGINX_SITES_ENABLED}/kettles"

    # Test nginx configuration
    if ! nginx -t 2>&1; then
        error "Invalid production nginx configuration"
        return 1
    fi

    # Print hostname to port mapping
    log "=== Hostname to Port Mapping ==="
    kettle_index=0
    processed=()
    for hostname in "${hostnames[@]}"; do
        local kettle_port=$((3001 + kettle_index * 2))
        local https_port=443

        local instance=0
        for prev_hostname in "${processed[@]:-}"; do
            if [ "$prev_hostname" = "$hostname" ]; then
                instance=$((instance + 1))
                https_port=$((443 + instance))
            fi
        done
        processed+=("$hostname")

        log "  https://${hostname}:${https_port} -> 127.0.0.1:${kettle_port}"
        kettle_index=$((kettle_index + 1))
    done
    log "================================"

    return 0
}

# Reload nginx with new configuration
reload_nginx() {
    log "Reloading nginx with production configuration"

    # Try systemctl first
    if command -v systemctl &> /dev/null; then
        if ! systemctl reload nginx 2>&1; then
            warn "Failed to reload nginx, attempting restart"
            if ! systemctl restart nginx 2>&1; then
                error "Failed to restart nginx"
                return 1
            fi
        fi
    else
        # Fall back to nginx -s reload
        if ! nginx -s reload 2>&1; then
            error "Failed to reload nginx"
            return 1
        fi
    fi

    log "Nginx reloaded successfully"
    return 0
}

# Check prerequisites
check_prerequisites() {
    local missing=()

    if ! command -v nginx &> /dev/null; then
        missing+=("nginx")
    fi

    if ! command -v certbot &> /dev/null; then
        missing+=("certbot")
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        error "Missing required tools: ${missing[*]}"
        error "Install with: apt install ${missing[*]}"
        return 1
    fi

    # Create nginx directories
    mkdir -p "$NGINX_SITES_AVAILABLE" "$NGINX_SITES_ENABLED"

    return 0
}

# Main function
main() {
    log "=== Starting certbot-launcher ==="

    # Check prerequisites
    if ! check_prerequisites; then
        exit 1
    fi

    # Load environment from cloud-launcher if available
    if [ -f "$ENV_FILE" ]; then
        log "Loading configuration from $ENV_FILE"
        # shellcheck source=/dev/null
        source "$ENV_FILE"
    fi

    # Read hostname from environment
    local hostname_input="${HOSTNAME_CONFIG:-}"

    if [ -z "$hostname_input" ]; then
        log "No HOSTNAME_CONFIG provided, skipping certificate and nginx setup"
        log "Set HOSTNAME_CONFIG=your-domain.com to enable HTTPS"
        exit 0
    fi

    # Parse and validate hostnames
    local hostnames_str
    hostnames_str=$(parse_hostnames "$hostname_input")

    if [ -z "$hostnames_str" ]; then
        log "No valid hostnames found, skipping certificate and nginx setup"
        exit 0
    fi

    # Convert to array
    read -ra hostnames <<< "$hostnames_str"

    log "Processing ${#hostnames[@]} hostname(s): ${hostnames[*]}"

    # Check if certificates already exist
    local first_hostname="${hostnames[0]}"
    if [ -f "${CERT_DIR}/${first_hostname}/fullchain.pem" ]; then
        log "Certificates already exist for ${first_hostname}"

        # Create production nginx config and reload
        if create_production_nginx_config "${hostnames[@]}"; then
            if reload_nginx; then
                log "=== certbot-launcher completed (using existing certs) ==="
                exit 0
            fi
        fi

        warn "Failed to configure nginx with existing certs, will try to renew"
    fi

    # Create ACME challenge nginx config
    if ! create_acme_nginx_config "${hostnames[@]}"; then
        error "Failed to create ACME challenge configuration"
        exit 1
    fi

    # Start nginx for ACME challenge
    if ! start_nginx; then
        error "Failed to start nginx for ACME challenge"
        exit 1
    fi

    # Wait for nginx to be ready
    sleep 2

    # Obtain Let's Encrypt certificate
    if ! obtain_certificate "${hostnames[@]}"; then
        error "Failed to obtain certificate"
        log "Kettles will run on ports 3001+ without HTTPS proxy"
        exit 0
    fi

    # Create production nginx configuration
    if ! create_production_nginx_config "${hostnames[@]}"; then
        error "Failed to create production nginx configuration"
        log "Kettles will run on ports 3001+ without HTTPS proxy"
        exit 0
    fi

    # Reload nginx with production config
    if ! reload_nginx; then
        error "Failed to reload nginx with production configuration"
        log "Kettles will run on ports 3001+ without HTTPS proxy"
        exit 0
    fi

    log "=== certbot-launcher completed successfully ==="
    exit 0
}

# Run main function
main "$@"
