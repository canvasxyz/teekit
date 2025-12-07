SHELL := /bin/bash
WRAPPER := scripts/env_wrapper.sh

.PHONY: all build build-dev measure measure-gcp clean

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

# Export TPM PCR measurements for the built image
measure:
	@if [ ! -f build/kettle-vm.efi ]; then \
		echo "Error: build/kettle-vm.efi not found. Run 'make build' first."; \
		exit 1; \
	fi
	$(WRAPPER) measured-boot build/kettle-vm.efi build/pcr_measurements.json --direct-uki
	@echo "PCR measurements exported to build/pcr_measurements.json"

# Export TDX MRTD/RTMR measurements for GCP
measure-gcp:
	@if [ ! -f build/kettle-vm.efi ]; then \
		echo "Error: build/kettle-vm.efi not found. Run 'make build' first."; \
		exit 1; \
	fi
	$(WRAPPER) dstack-mr -uki build/kettle-vm.efi -json > build/tdx_measurements.json
	@echo "TDX measurements (MRTD, RTMR0-2) exported to build/tdx_measurements.json"

# Remove cache and build artifacts
clean:
	rm -rf build/ mkosi.builddir/ mkosi.cache/ lima-nix/
	if command -v limactl >/dev/null 2>&1 && limactl list | grep -q '^tee-builder'; then \
		echo "Stopping and deleting lima VM 'tee-builder'..."; \
		limactl stop tee-builder || true; \
		limactl delete tee-builder || true; \
	fi
