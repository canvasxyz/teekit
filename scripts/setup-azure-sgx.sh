#!/bin/bash
#
# This script installs all dependencies needed to run JS kettles in an SGX enclave
# on Azure Confidential Computing VMs.
#
# Prerequisites:
#   - Intel SGX enabled VM, e.g. Azure DCsv3 or DCdsv3
#   - Ubuntu 22.04 LTS or Debian 12

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    VERSION=$VERSION_ID
else
    log_error "Cannot detect OS"
    exit 1
fi

log_info "Detected OS: $OS $VERSION"

# Check for SGX support
log_info "Checking SGX hardware support..."
if ! grep -q sgx /proc/cpuinfo 2>/dev/null; then
    log_warn "SGX not detected in /proc/cpuinfo"
    log_warn "This may be normal on Azure - SGX is exposed differently"
fi

# Add Intel SGX repository
log_info "Adding Intel SGX repository..."
case $OS in
    ubuntu|debian)
        sudo apt-get update
        sudo apt-get install -y curl gnupg

        # Intel SGX repository key
        curl -fsSL https://download.01.org/intel-sgx/sgx_repo/ubuntu/intel-sgx-deb.key | \
            sudo gpg --dearmor --yes -o /usr/share/keyrings/intel-sgx.gpg

        # Add repository based on Ubuntu version
        if [ "$OS" = "ubuntu" ]; then
            echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-sgx.gpg] https://download.01.org/intel-sgx/sgx_repo/ubuntu $(lsb_release -cs) main" \
                | sudo tee /etc/apt/sources.list.d/intel-sgx.list > /dev/null
        else
            # For Debian, use bookworm or closest Ubuntu equivalent
            echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-sgx.gpg] https://download.01.org/intel-sgx/sgx_repo/ubuntu jammy main" \
                | sudo tee /etc/apt/sources.list.d/intel-sgx.list > /dev/null
        fi
        ;;
    *)
        log_error "Unsupported OS: $OS"
        exit 1
        ;;
esac

# Add Gramine repository
log_info "Adding Gramine repository..."
curl -fsSL https://packages.gramineproject.io/gramine-keyring.gpg | \
    sudo gpg --dearmor --yes -o /usr/share/keyrings/gramine-keyring.gpg

if [ "$OS" = "ubuntu" ]; then
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gramine-keyring.gpg] https://packages.gramineproject.io/ $(lsb_release -cs) main" \
        | sudo tee /etc/apt/sources.list.d/gramine.list > /dev/null
else
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gramine-keyring.gpg] https://packages.gramineproject.io/ bookworm main" \
        | sudo tee /etc/apt/sources.list.d/gramine.list > /dev/null
fi

# Update package lists
log_info "Updating package lists..."
sudo apt-get update

# Install Intel SGX driver and PSW
log_info "Installing Intel SGX components..."
sudo apt-get install -y \
    build-essential \
    libsgx-launch \
    libsgx-urts \
    libsgx-enclave-common \
    libsgx-dcap-ql \
    libsgx-dcap-default-qpl \
    libsgx-quote-ex \
    sgx-aesm-service

# Install Gramine
log_info "Installing Gramine..."
sudo apt-get install -y gramine

# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" || true

# Install Node.js v22
nvm install v22
nvm alias default v22

# Install homebrew
NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo >> ~/.bashrc
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.bashrc
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"

echo 'Installed nvm and homebrew, use `source ~/.bashrc` to update your command line.'

# Install dependencies
npm install

# Create kettle directories
log_info "Creating kettle directories..."
sudo mkdir -p /opt/kettle
sudo mkdir -p /var/lib/kettle
sudo mkdir -p /etc/kettle

# Configure AESM service for Azure
log_info "Configuring AESM service..."
sudo tee /etc/aesmd.conf > /dev/null << 'EOF'
# Azure SGX configuration
# Use Azure's DCAP Quote Provider
default quoting type = ecdsa_256
EOF

# For Azure, configure the DCAP Quote Provider Library
log_info "Configuring Azure DCAP Quote Provider..."
if [ -f /usr/lib/x86_64-linux-gnu/libdcap_quoteprov.so ]; then
    # Azure provides its own quote provider
    export AZDCAP_DEBUG_LOG_LEVEL=INFO
fi

# Start AESM service
log_info "Starting AESM service..."
sudo systemctl enable aesmd
sudo systemctl start aesmd || log_warn "AESM service failed to start (may be normal on some Azure configs)"

# Verify SGX setup
log_info "Verifying SGX setup..."
if command -v is-sgx-available &> /dev/null; then
    is-sgx-available || log_warn "SGX availability check returned non-zero"
else
    log_warn "is-sgx-available not found, skipping verification"
fi

# Generate Gramine signing key (for development)
log_info "Generating Gramine signing key..."
if [ ! -f /opt/kettle/enclave-key.pem ]; then
    gramine-sgx-gen-private-key /opt/kettle/enclave-key.pem
    chmod 600 /opt/kettle/enclave-key.pem
    log_warn "Generated development signing key at /opt/kettle/enclave-key.pem"
    log_warn "For production, use your own signing key!"
fi

# Print summary
log_info "=========================================="
log_info "SGX setup complete!"
log_info "=========================================="
echo ""
echo "Installed components:"
echo "  - Intel SGX PSW (Platform Software)"
echo "  - Intel SGX DCAP (Data Center Attestation Primitives)"
echo "  - Gramine Library OS"
echo "  - Node.js via NVM"
echo ""
echo "Directories created:"
echo "  - /opt/kettle       (enclave files)"
echo "  - /var/lib/kettle   (database storage)"
echo "  - /etc/kettle       (configuration)"
echo ""
