#!/usr/bin/env bash
set -euo pipefail

# Parse arguments
USE_DEVTOOLS=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --devtools)
      USE_DEVTOOLS=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--devtools]"
      exit 1
      ;;
  esac
done

# Ensure at least 8GB swap (Linux only)
if [ -f /proc/meminfo ]; then
    required_kb=$((8 * 1024 * 1024))
    total_swap_kb=$(grep -i '^SwapTotal:' /proc/meminfo | awk '{print $2}')
    if (( total_swap_kb >= required_kb )); then
        echo "OK: System has swap: ($((total_swap_kb / 1024 / 1024)) GB)."
    else
        echo "Warning: System has $((total_swap_kb / 1024 / 1024)) GB swap, recommended 8GB for build."
    fi
fi

# Test the built image locally with QEMU, exposing serial console via Unix socket

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$IMAGES_DIR/build"

# Select image based on devtools flag
if [ "$USE_DEVTOOLS" = true ]; then
  # Check for tdx-debian-devtools.efi, fall back to tdx-debian-azure.efi if not found
  if [ -f "$BUILD_DIR/tdx-debian-devtools.efi" ]; then
    IMAGE_NAME="tdx-debian-devtools.efi"
  elif [ -f "$BUILD_DIR/tdx-debian-azure.efi" ]; then
    IMAGE_NAME="tdx-debian-azure.efi"
    echo "Note: Using tdx-debian-azure.efi (tdx-debian-devtools.efi not found)"
  else
    IMAGE_NAME="tdx-debian-devtools.efi"  # Set to default for error message
  fi
else
  # Check for tdx-debian.efi, fall back to tdx-debian-azure.efi if not found
  if [ -f "$BUILD_DIR/tdx-debian.efi" ]; then
    IMAGE_NAME="tdx-debian.efi"
  elif [ -f "$BUILD_DIR/tdx-debian-azure.efi" ]; then
    IMAGE_NAME="tdx-debian-azure.efi"
    echo "Note: Using tdx-debian-azure.efi (tdx-debian.efi not found)"
  else
    IMAGE_NAME="tdx-debian.efi"  # Set to default for error message
  fi
fi

IMAGE="$BUILD_DIR/$IMAGE_NAME"
SERIAL_SOCKET="/tmp/qemu-teekit-serial.sock"
METADATA_SERVICE_LOG="/tmp/qemu-teekit-metadata.log"

echo "Using image: $IMAGE_NAME"

if [ ! -f "$IMAGE" ]; then
  echo "Error: Image not found at $IMAGE"
  echo "Please run 'npm run build:vm' first"
  exit 1
fi

# Remove old socket if it exists
rm -f "$SERIAL_SOCKET"

# Start local metadata service
echo "Starting local metadata service..."
METADATA_SERVICE_PID=""
if [ -f "$SCRIPT_DIR/metadata-service.js" ]; then
  # Try to use manifest from kettle-artifacts if available
  MANIFEST_PATH=""
  if [ -f "$IMAGES_DIR/kettle-artifacts/manifest.json" ]; then
    MANIFEST_PATH="$IMAGES_DIR/kettle-artifacts/manifest.json"
    echo "Using manifest from: $MANIFEST_PATH"
  fi

  if [ -n "$MANIFEST_PATH" ]; then
    node "$SCRIPT_DIR/metadata-service.js" "$MANIFEST_PATH" > "$METADATA_SERVICE_LOG" 2>&1 &
  else
    node "$SCRIPT_DIR/metadata-service.js" > "$METADATA_SERVICE_LOG" 2>&1 &
  fi
  METADATA_SERVICE_PID=$!

  # Give the service a moment to start
  sleep 1

  # Check if service is running
  if kill -0 "$METADATA_SERVICE_PID" 2>/dev/null; then
    echo "Metadata service started (PID: $METADATA_SERVICE_PID)"
    echo "Metadata service log: $METADATA_SERVICE_LOG"
    echo "Test with: curl http://localhost:8090/manifest/decoded"
  else
    echo "Warning: Failed to start metadata service"
    cat "$METADATA_SERVICE_LOG" 2>/dev/null || true
    METADATA_SERVICE_PID=""
  fi
else
  echo "Warning: Metadata service script not found at $SCRIPT_DIR/metadata-service.js"
fi
echo ""

# Check if OVMF firmware is available
OVMF_CODE="/usr/share/OVMF/OVMF_CODE.fd"
if [ ! -f "$OVMF_CODE" ]; then
  # Try homebrew location
  OVMF_CODE="/home/linuxbrew/.linuxbrew/share/qemu/edk2-x86_64-code.fd"
  if [ ! -f "$OVMF_CODE" ]; then
    echo "Warning: OVMF firmware not found. Using QEMU default BIOS."
    echo "For EFI boot, install OVMF: sudo apt install ovmf"
    OVMF_CODE=""
  fi
fi

echo "Kettle service should be available on http://localhost:3001"
echo "Dummy TDX DCAP on http://localhost:8080"
echo "Local metadata service on http://localhost:8090"
echo ""
echo "Serial console available at: $SERIAL_SOCKET"
echo "Connect from another terminal with:"
echo "  socat - UNIX-CONNECT:$SERIAL_SOCKET"
echo ""
echo "Press Ctrl+C to stop the VM"
echo ""

# Build QEMU command
QEMU_CMD=(
  qemu-system-x86_64
  -cpu host
  -m 8G
  -overcommit mem-lock=off
  -smp 2
  -nographic
  -serial "unix:$SERIAL_SOCKET,server,nowait"
  -monitor stdio
)

# Add EFI firmware if available
if [ -n "$OVMF_CODE" ]; then
  QEMU_CMD+=(
    -drive "if=pflash,format=raw,readonly=on,file=$OVMF_CODE"
  )
fi

# Add the kernel image
QEMU_CMD+=(
  -kernel "$IMAGE"
  -append "console=ttyS0 systemd.log_level=debug"
)

# Port forwarding for services
QEMU_CMD+=(
  -netdev user,id=net0,hostfwd=tcp::3001-:3001,hostfwd=tcp::8080-:8080,hostfwd=tcp::2222-:22
  -device virtio-net-pci,netdev=net0
)

# Enable KVM if available
if [ -e /dev/kvm ]; then
  QEMU_CMD+=(-enable-kvm)
fi

# Track QEMU process so we can stop it on Ctrl+C
QEMU_PID=""

cleanup_vm() {
  local signal="${1:-TERM}"
  if [[ -n "$QEMU_PID" ]] && kill -0 "$QEMU_PID" 2>/dev/null; then
    echo ""
    echo "Stopping VM..."
    kill "-$signal" "$QEMU_PID" 2>/dev/null || true
    wait "$QEMU_PID" 2>/dev/null || true
    QEMU_PID=""
  fi
  # Stop metadata service
  if [[ -n "$METADATA_SERVICE_PID" ]] && kill -0 "$METADATA_SERVICE_PID" 2>/dev/null; then
    echo "Stopping metadata service..."
    kill "$METADATA_SERVICE_PID" 2>/dev/null || true
    wait "$METADATA_SERVICE_PID" 2>/dev/null || true
  fi
  # Clean up socket
  rm -f "$SERIAL_SOCKET"
}

trap 'cleanup_vm INT; exit 130' INT
trap 'cleanup_vm TERM' TERM
trap 'cleanup_vm TERM' EXIT

"${QEMU_CMD[@]}"
EXIT_CODE=$?

exit "$EXIT_CODE"
