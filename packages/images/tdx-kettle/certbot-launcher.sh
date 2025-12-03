#!/bin/bash
set -euo pipefail

# certbot-launcher.sh
# Handles Let's Encrypt certificate acquisition and nginx configuration
# for routing hostnames to kettle instances

# Log file path is configured in the systemd service file (StandardOutput/StandardError)
NGINX_CONF_DIR="/etc/nginx"
NGINX_SITES_AVAILABLE="${NGINX_CONF_DIR}/sites-available"
NGINX_SITES_ENABLED="${NGINX_CONF_DIR}/sites-enabled"
CERT_DIR="/etc/letsencrypt/live"
ACME_WEBROOT="/var/www/letsencrypt"
MAX_RETRIES_EXTERNAL=5
MAX_RETRIES_ACME=1

# Logging function - output goes to stdout, systemd handles file redirection
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

# Error logging function - output goes to stderr, systemd handles file redirection
error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
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
        if [[ ! " ${seen_map[@]:-} " =~ " ${hostname} " ]]; then
            unique_hostnames+=("$hostname")
            seen_map+=("$hostname")
        fi
    done

    # Return space-separated list
    echo "${unique_hostnames[@]:-}"
}

# Create initial nginx config for ACME challenge
create_acme_nginx_config() {
    local hostnames=("$@")

    log "Creating ACME challenge nginx configuration"

    # Create webroot directory
    mkdir -p "$ACME_WEBROOT"

    # Create nginx config for HTTP only (for ACME challenge)
    cat > "${NGINX_SITES_AVAILABLE}/acme-challenge" <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name ${hostnames[@]};

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

# Start nginx
start_nginx() {
    log "Starting nginx"

    # Check if nginx is already running
    if systemctl is-active --quiet nginx; then
        log "Nginx is already running, reloading"
        if ! systemctl reload nginx 2>&1; then
            error "Failed to reload nginx"
            return 1
        fi
    else
        if ! systemctl start nginx 2>&1; then
            error "Failed to start nginx"
            return 1
        fi
    fi

    return 0
}

# Retry wrapper for external service calls
retry_external() {
    local max_retries=$1
    shift
    local cmd=("$@")
    local attempt=1

    while [ $attempt -le $max_retries ]; do
        log "Attempt $attempt/$max_retries: ${cmd[*]}"

        if "${cmd[@]}" 2>&1; then
            log "Command succeeded on attempt $attempt"
            return 0
        fi

        if [ $attempt -lt $max_retries ]; then
            local wait_time=$((2 ** attempt))
            log "Command failed, waiting ${wait_time}s before retry..."
            sleep "$wait_time"
        fi

        attempt=$((attempt + 1))
    done

    error "Command failed after $max_retries attempts: ${cmd[*]}"
    return 1
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

    # Try to obtain certificate with retry (up to 1 retry for ACME challenge)
    if ! retry_external $((MAX_RETRIES_ACME + 1)) "${certbot_cmd[@]}"; then
        error "Failed to obtain Let's Encrypt certificate"
        return 1
    fi

    log "Certificate obtained successfully"
    return 0
}

# Create production nginx configuration with HTTPS
create_production_nginx_config() {
    local hostnames=("$@")
    local first_hostname="${hostnames[0]}"

    log "Creating production nginx configuration"

    # Remove ACME challenge config
    rm -f "${NGINX_SITES_ENABLED}/acme-challenge"

    # Map hostnames to ports
    # Format: hostname -> port mapping
    declare -A hostname_port_map
    declare -A hostname_count

    local current_port=443
    for hostname in "${hostnames[@]}"; do
        if [ -z "${hostname_count[$hostname]:-}" ]; then
            hostname_count[$hostname]=0
            hostname_port_map["$hostname:${hostname_count[$hostname]}"]=$current_port
        else
            hostname_count[$hostname]=$((hostname_count[$hostname] + 1))
            current_port=$((current_port + 1))
            hostname_port_map["$hostname:${hostname_count[$hostname]}"]=$current_port
        fi
    done

    # Determine kettle port for each hostname
    declare -A hostname_kettle_map
    local kettle_index=0
    for hostname in "${hostnames[@]}"; do
        local kettle_port=$((3001 + kettle_index))
        hostname_kettle_map["$hostname:$kettle_index"]=$kettle_port
        kettle_index=$((kettle_index + 1))
    done

    # Create main nginx configuration
    cat > "${NGINX_SITES_AVAILABLE}/kettles" <<'EOF_START'
# Kettle SSL Configuration
EOF_START

    # HTTP server - redirect to HTTPS
    cat >> "${NGINX_SITES_AVAILABLE}/kettles" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${hostnames[@]};

    location /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

EOF

    # HTTPS servers - one per unique hostname:port combination
    local processed=()
    local kettle_index=0
    for hostname in "${hostnames[@]}"; do
        local kettle_port=$((3001 + kettle_index))
        local https_port=443

        # Check if this hostname was already processed
        local instance=0
        for prev_hostname in "${processed[@]:-}"; do
            if [ "$prev_hostname" = "$hostname" ]; then
                instance=$((instance + 1))
                https_port=$((443 + instance))
            fi
        done

        processed+=("$hostname")

        # Determine SSL certificate path (use first hostname for SAN cert)
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
    local kettle_index=0
    local processed=()
    for hostname in "${hostnames[@]}"; do
        local kettle_port=$((3001 + kettle_index))
        local https_port=443

        # Check if this hostname was already processed
        local instance=0
        for prev_hostname in "${processed[@]:-}"; do
            if [ "$prev_hostname" = "$hostname" ]; then
                instance=$((instance + 1))
                https_port=$((443 + instance))
            fi
        done

        processed+=("$hostname")

        log "  ${hostname}:${https_port} -> kettle on 127.0.0.1:${kettle_port}"
        kettle_index=$((kettle_index + 1))
    done
    log "================================"

    return 0
}

# Reload nginx with new configuration
reload_nginx() {
    log "Reloading nginx with production configuration"

    if ! systemctl reload nginx 2>&1; then
        error "Failed to reload nginx with production configuration"
        # Try to restart if reload fails
        log "Attempting to restart nginx"
        if ! systemctl restart nginx 2>&1; then
            error "Failed to restart nginx"
            return 1
        fi
    fi

    # Check if nginx is running
    if ! systemctl is-active --quiet nginx; then
        error "Nginx is not running after reload"
        return 1
    fi

    log "Nginx is running successfully"
    return 0
}

# Main function
main() {
    log "=== Starting certbot-launcher ==="
    log "=== Reading hostnames, configuring nginx, and running certbot ==="

    # Read hostname from environment
    local hostname_input="${HOSTNAME_CONFIG:-}"

    if [ -z "$hostname_input" ]; then
        log "No HOSTNAME_CONFIG provided, skipping certificate and nginx setup"
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

    log "Processing ${#hostnames[@]} unique hostname(s): ${hostnames[*]}"

    # Create nginx directories
    mkdir -p "$NGINX_SITES_AVAILABLE" "$NGINX_SITES_ENABLED"

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

    # Wait a bit for nginx to be ready
    sleep 2

    # Obtain Let's Encrypt certificate
    if ! obtain_certificate "${hostnames[@]}"; then
        error "Failed to obtain certificate, skipping HTTPS configuration"
        # Don't exit with error - allow kettles to run without HTTPS
        log "Kettles will run on ports 3001+ without HTTPS proxy"
        exit 0
    fi

    # Create production nginx configuration
    if ! create_production_nginx_config "${hostnames[@]}"; then
        error "Failed to create production nginx configuration"
        # Don't exit with error - allow kettles to run without HTTPS
        log "Kettles will run on ports 3001+ without HTTPS proxy"
        exit 0
    fi

    # Reload nginx with production config
    if ! reload_nginx; then
        error "Failed to reload nginx with production configuration"
        # Don't exit with error - allow kettles to run without HTTPS
        log "Kettles will run on ports 3001+ without HTTPS proxy"
        exit 0
    fi

    log "=== certbot-launcher completed successfully ==="
    exit 0
}

# Run main function
main
