#!/bin/bash
set -euo pipefail

# Firewall configuration for kettle-vm (production profile)
# Supports up to KETTLE_COUNT kettles (default: 10)
#
# Port allocation:
#   80        - HTTP (ACME challenges + redirect to HTTPS)
#   443-452   - HTTPS (nginx proxying to kettles, one port per hostname)
#   3001-3010 - Kettle instances (localhost only, accessed via nginx proxy)
#   22        - SSH (blocked in production, allowed in devtools)
#
# Note: We use iptables-legacy instead of iptables because the default
# iptables on Debian uses the nft backend which requires nftables kernel
# support. The VM kernel may not have nftables enabled.

LOG_PREFIX="[firewall]"

KETTLE_COUNT="${KETTLE_COUNT:-10}"
MAX_HTTPS_PORT=$((443 + KETTLE_COUNT - 1))
MAX_KETTLE_PORT=$((3001 + KETTLE_COUNT - 1))

# Check if this is devtools profile (SSH service enabled)
IS_DEVTOOLS=false
if systemctl is-enabled ssh.service &>/dev/null 2>&1; then
    IS_DEVTOOLS=true
fi

echo "Configuring firewall (kettles: $KETTLE_COUNT, devtools: $IS_DEVTOOLS)..."

# Flush existing rules
iptables-legacy -F
iptables-legacy -X
ip6tables-legacy -F 2>/dev/null || true
ip6tables-legacy -X 2>/dev/null || true

# Default policies: drop incoming, allow outgoing
iptables-legacy -P INPUT DROP
iptables-legacy -P FORWARD DROP
iptables-legacy -P OUTPUT ACCEPT

ip6tables-legacy -P INPUT DROP 2>/dev/null || true
ip6tables-legacy -P FORWARD DROP 2>/dev/null || true
ip6tables-legacy -P OUTPUT ACCEPT 2>/dev/null || true

# Allow loopback (required for nginx -> kettle proxy)
iptables-legacy -A INPUT -i lo -j ACCEPT
ip6tables-legacy -A INPUT -i lo -j ACCEPT 2>/dev/null || true

# Allow established connections
iptables-legacy -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables-legacy -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true

# Allow ICMP (ping) - useful for health checks
iptables-legacy -A INPUT -p icmp --icmp-type echo-request -j ACCEPT
ip6tables-legacy -A INPUT -p ipv6-icmp -j ACCEPT 2>/dev/null || true

# HTTP (80) - ACME challenges and redirect to HTTPS
iptables-legacy -A INPUT -p tcp --dport 80 -j ACCEPT
ip6tables-legacy -A INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
echo "  Allowed: TCP/80 (HTTP)"

# HTTPS (443-$MAX_HTTPS_PORT) - nginx proxy to kettles
iptables-legacy -A INPUT -p tcp --dport 443:$MAX_HTTPS_PORT -j ACCEPT
ip6tables-legacy -A INPUT -p tcp --dport 443:$MAX_HTTPS_PORT -j ACCEPT 2>/dev/null || true
echo "  Allowed: TCP/443-$MAX_HTTPS_PORT (HTTPS)"

# Kettle ports (3001-3010) - allowed (nginx also accesses via localhost)
iptables-legacy -A INPUT -p tcp --dport 3001:$MAX_KETTLE_PORT -j ACCEPT
ip6tables-legacy -A INPUT -p tcp --dport 3001:$MAX_KETTLE_PORT -j ACCEPT 2>/dev/null || true
echo "  Allowed: TCP/3001-$MAX_KETTLE_PORT (HTTP)"

# SSH (22) - only in devtools profile
if [ "$IS_DEVTOOLS" = true ]; then
    iptables-legacy -A INPUT -p tcp --dport 22 -j ACCEPT
    ip6tables-legacy -A INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null || true
    echo "  Allowed: TCP/22 (SSH - devtools mode)"
else
    iptables-legacy -A INPUT -p tcp --dport 22 -j DROP
    ip6tables-legacy -A INPUT -p tcp --dport 22 -j DROP 2>/dev/null || true
    echo "  Blocked: TCP/22 (SSH - production mode)"
fi

# Log dropped packets (rate limited to prevent log flooding)
iptables-legacy -A INPUT -m limit --limit 5/min -j LOG --log-prefix "iptables-dropped: " --log-level 4

# Final drop (explicit, matches default policy)
iptables-legacy -A INPUT -j DROP
ip6tables-legacy -A INPUT -j DROP 2>/dev/null || true

echo "Firewall configured successfully"
echo "Rules summary:"
iptables-legacy -L INPUT -n --line-numbers | head -20
