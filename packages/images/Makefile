SHELL := /bin/bash
WRAPPER := scripts/env_wrapper.sh

.PHONY: all build build-dev measure clean

# Default target
all: build

# Build module
build:
	scripts/check_perms.sh
	scripts/setup_deps.sh
	$(WRAPPER) mkosi --force -I $(IMAGE).conf

# Build module with devtools profile
build-dev:
	scripts/check_perms.sh
	scripts/setup_deps.sh
	$(WRAPPER) mkosi --force --profile=devtools -I $(IMAGE).conf

# Export TDX measurements for the built image
measure:
	@if [ ! -f build/tdx-debian.efi ]; then \
		echo "Error: build/tdx-debian.efi not found. Run 'make build' first."; \
		exit 1; \
	fi
	$(WRAPPER) measured-boot build/tdx-debian.efi build/measurements.json --direct-uki
	echo "Measurements exported to build/measurements.json"

# Remove cache and build artifacts
clean:
	rm -rf build/ mkosi.builddir/ mkosi.cache/ lima-nix/
	if command -v limactl >/dev/null 2>&1 && limactl list | grep -q '^tee-builder'; then \
		echo "Stopping and deleting lima VM 'tee-builder'..."; \
		limactl stop tee-builder || true; \
		limactl delete tee-builder || true; \
	fi
