#!/bin/bash
set -euo pipefail

# Firewall configuration for Gramine SGX kettle deployments
# Supports up to KETTLE_COUNT kettles (default: 10)
#
# Port allocation:
#   80        - HTTP (ACME challenges + redirect to HTTPS)
#   443-452   - HTTPS (nginx proxying to kettles, one port per hostname)
#   3001-3020 - Kettle instances (workerd + quote services)
#   22        - SSH (blocked in production, allowed in devtools)
#
# Note: We use iptables-legacy for maximum compatibility.

LOG_PREFIX="[firewall]"

KETTLE_COUNT="${KETTLE_COUNT:-10}"
MAX_HTTPS_PORT=$((443 + KETTLE_COUNT - 1))
MAX_KETTLE_PORT=$((3001 + KETTLE_COUNT * 2 - 1))

# Check for devtools mode (SSH enabled)
IS_DEVTOOLS="${DEVTOOLS:-false}"

echo "$LOG_PREFIX Configuring firewall (kettles: $KETTLE_COUNT, devtools: $IS_DEVTOOLS)..."

# Detect iptables command
IPTABLES="iptables"
IP6TABLES="ip6tables"
if command -v iptables-legacy &> /dev/null; then
    IPTABLES="iptables-legacy"
    IP6TABLES="ip6tables-legacy"
fi

# Flush existing rules
$IPTABLES -F
$IPTABLES -X
$IP6TABLES -F 2>/dev/null || true
$IP6TABLES -X 2>/dev/null || true

# Default policies: drop incoming, allow outgoing
$IPTABLES -P INPUT DROP
$IPTABLES -P FORWARD DROP
$IPTABLES -P OUTPUT ACCEPT

$IP6TABLES -P INPUT DROP 2>/dev/null || true
$IP6TABLES -P FORWARD DROP 2>/dev/null || true
$IP6TABLES -P OUTPUT ACCEPT 2>/dev/null || true

# Allow loopback (required for nginx -> kettle proxy and internal services)
$IPTABLES -A INPUT -i lo -j ACCEPT
$IP6TABLES -A INPUT -i lo -j ACCEPT 2>/dev/null || true

# Allow established connections
$IPTABLES -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$IP6TABLES -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true

# Drop invalid packets (malformed, out-of-state)
$IPTABLES -A INPUT -m conntrack --ctstate INVALID -j DROP
$IP6TABLES -A INPUT -m conntrack --ctstate INVALID -j DROP 2>/dev/null || true
echo "$LOG_PREFIX   Dropping invalid packets"

# Allow ICMP (ping) - useful for health checks
$IPTABLES -A INPUT -p icmp --icmp-type echo-request -j ACCEPT
$IP6TABLES -A INPUT -p ipv6-icmp -j ACCEPT 2>/dev/null || true

# HTTP (80) - ACME challenges and redirect to HTTPS
# Rate limit: 50 new connections per second per IP (ACME doesn't need high throughput)
$IPTABLES -A INPUT -p tcp --dport 80 -m conntrack --ctstate NEW -m hashlimit \
    --hashlimit-above 50/sec --hashlimit-burst 100 --hashlimit-mode srcip \
    --hashlimit-name http_conn_limit -j DROP
$IP6TABLES -A INPUT -p tcp --dport 80 -m conntrack --ctstate NEW -m hashlimit \
    --hashlimit-above 50/sec --hashlimit-burst 100 --hashlimit-mode srcip \
    --hashlimit-name http_conn_limit6 -j DROP 2>/dev/null || true
$IPTABLES -A INPUT -p tcp --dport 80 -j ACCEPT
$IP6TABLES -A INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
echo "$LOG_PREFIX   Allowed: TCP/80 (HTTP, rate limited: 50/s per IP)"

# HTTPS (443-$MAX_HTTPS_PORT) - nginx proxy to kettles
# Rate limit: 200 new connections per second per IP (main traffic path)
$IPTABLES -A INPUT -p tcp --dport 443:$MAX_HTTPS_PORT -m conntrack --ctstate NEW -m hashlimit \
    --hashlimit-above 200/sec --hashlimit-burst 400 --hashlimit-mode srcip \
    --hashlimit-name https_conn_limit -j DROP
$IP6TABLES -A INPUT -p tcp --dport 443:$MAX_HTTPS_PORT -m conntrack --ctstate NEW -m hashlimit \
    --hashlimit-above 200/sec --hashlimit-burst 400 --hashlimit-mode srcip \
    --hashlimit-name https_conn_limit6 -j DROP 2>/dev/null || true
$IPTABLES -A INPUT -p tcp --dport 443:$MAX_HTTPS_PORT -j ACCEPT
$IP6TABLES -A INPUT -p tcp --dport 443:$MAX_HTTPS_PORT -j ACCEPT 2>/dev/null || true
echo "$LOG_PREFIX   Allowed: TCP/443-$MAX_HTTPS_PORT (HTTPS, rate limited: 200/s per IP)"

# Kettle ports (workerd and quote services) - allow external access with rate limiting
# Rate limit: 100 new connections per second per source IP, burst of 200
# This protects against connection flooding while allowing legitimate traffic
$IPTABLES -A INPUT -p tcp --dport 3001:$MAX_KETTLE_PORT -m conntrack --ctstate NEW -m hashlimit \
    --hashlimit-above 100/sec --hashlimit-burst 200 --hashlimit-mode srcip \
    --hashlimit-name kettle_conn_limit -j DROP
$IP6TABLES -A INPUT -p tcp --dport 3001:$MAX_KETTLE_PORT -m conntrack --ctstate NEW -m hashlimit \
    --hashlimit-above 100/sec --hashlimit-burst 200 --hashlimit-mode srcip \
    --hashlimit-name kettle_conn_limit6 -j DROP 2>/dev/null || true
$IPTABLES -A INPUT -p tcp --dport 3001:$MAX_KETTLE_PORT -j ACCEPT
$IP6TABLES -A INPUT -p tcp --dport 3001:$MAX_KETTLE_PORT -j ACCEPT 2>/dev/null || true
echo "$LOG_PREFIX   Allowed: TCP/3001-$MAX_KETTLE_PORT (Kettle HTTP, rate limited: 100/s per IP)"

# SSH (22) - only in devtools mode
if [ "$IS_DEVTOOLS" = "true" ]; then
    $IPTABLES -A INPUT -p tcp --dport 22 -j ACCEPT
    $IP6TABLES -A INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null || true
    echo "$LOG_PREFIX   Allowed: TCP/22 (SSH - devtools mode)"
else
    $IPTABLES -A INPUT -p tcp --dport 22 -j DROP
    $IP6TABLES -A INPUT -p tcp --dport 22 -j DROP 2>/dev/null || true
    echo "$LOG_PREFIX   Blocked: TCP/22 (SSH - production mode)"
fi

# Log dropped packets (rate limited to prevent log flooding)
$IPTABLES -A INPUT -m limit --limit 5/min -j LOG --log-prefix "iptables-dropped: " --log-level 4

# Final drop (explicit, matches default policy)
$IPTABLES -A INPUT -j DROP
$IP6TABLES -A INPUT -j DROP 2>/dev/null || true

echo "$LOG_PREFIX Firewall configured successfully"
echo "$LOG_PREFIX Rules summary:"
$IPTABLES -L INPUT -n --line-numbers | head -20
