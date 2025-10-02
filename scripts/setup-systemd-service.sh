#!/bin/sh

# Set up a systemd service to run the `teekit-demo` server on boot.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "must run as root"; exit 1; }

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WORKDIR=$(cd "$SCRIPT_DIR/.." && pwd)
UNIT=/etc/systemd/system/teekit-demo.service
RUN_USER=${SUDO_USER:-root}

cat > "$UNIT" <<EOF
[Unit]
Description=TEE Channels Demo Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$WORKDIR
Environment=NODE_VERSION=22
ExecStart=/root/.nvm/nvm-exec npm run server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable teekit-demo.service
systemctl restart teekit-demo.service || systemctl start teekit-demo.service
echo ok
