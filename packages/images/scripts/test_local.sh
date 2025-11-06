#!/usr/bin/env bash
set -euo pipefail

# Test the built image locally with QEMU

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$IMAGES_DIR/build"

IMAGE="$BUILD_DIR/tdx-debian.efi"

if [ ! -f "$IMAGE" ]; then
  echo "Error: Image not found at $IMAGE"
  echo "Please run 'npm run build:vm' first"
  exit 1
fi

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

echo "Starting VM with image: $IMAGE"
echo "Kettle service should be available on http://localhost:3001"
echo "Dummy TDX DCAP on http://localhost:8080"
echo ""
echo "Press Ctrl+C to stop the VM"
echo ""

# Build QEMU command
QEMU_CMD=(
  qemu-system-x86_64
  -m 2G
  -smp 2
  -nographic
  -serial mon:stdio
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
  -netdev user,id=net0,hostfwd=tcp::3001-:3001,hostfwd=tcp::8080-:8080
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
}

trap 'cleanup_vm INT; exit 130' INT
trap 'cleanup_vm TERM' TERM
trap 'cleanup_vm TERM' EXIT

"${QEMU_CMD[@]}" &
QEMU_PID=$!

set +e
wait "$QEMU_PID"
EXIT_CODE=$?
set -e

QEMU_PID=""
exit "$EXIT_CODE"
