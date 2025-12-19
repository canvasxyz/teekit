# Gramine SGX Makefile for Kettle
#
# This Makefile builds and signs the workerd enclave for running kettle in SGX.
#
# Usage:
#   make              - Build the SGX enclave (signed)
#   make SGX=1        - Build with SGX enabled (default)
#   make SGX=0        - Build for direct (non-SGX) mode (testing)
#   make clean        - Remove build artifacts
#   make distclean    - Remove all generated files including keys

SGX ?= 1
DEBUG ?= 0
LOG_LEVEL ?= error

# Architecture detection
ARCH_LIBDIR ?= /lib/$(shell $(CC) -dumpmachine)

# Gramine tools
ifeq ($(SGX),1)
GRAMINE = gramine-sgx
else
GRAMINE = gramine-direct
endif

# Signing key (generate if not present)
SGX_SIGN_KEY ?= enclave-key.pem

# workerd binary location (local binary in this directory)
WORKERD_BIN ?= $(CURDIR)/workerd

# Kettle bundle directory
KETTLE_BUNDLE_DIR ?= /opt/kettle

# Output files
MANIFEST = workerd.manifest
SGX_MANIFEST = workerd.manifest.sgx
SGX_SIG = workerd.sig
SGX_TOKEN = workerd.token
MRENCLAVE_FILE = .mrenclave

# Data directories
KETTLE_DATA_DIR ?= /var/lib/kettle
DO_STORAGE_DIR = $(KETTLE_DATA_DIR)/do-storage
MRENCLAVE_MARKER = $(DO_STORAGE_DIR)/.mrenclave

.PHONY: all clean distclean check-gramine check-workerd run sgx-run direct-run check-mrenclave

all: $(SGX_MANIFEST) $(SGX_SIG)
ifeq ($(SGX),1)
	@echo "SGX enclave built successfully."
	@echo "  Manifest: $(SGX_MANIFEST)"
	@echo "  Signature: $(SGX_SIG)"
	@echo ""
	@echo "Run with: make run"
else
	@echo "Direct-mode manifest built."
	@echo "Run with: make direct-run"
endif

# Check that Gramine is installed
check-gramine:
	@which gramine-sgx-sign > /dev/null 2>&1 || \
		(echo "Error: Gramine not found. Install with: apt install gramine" && exit 1)

# Decompress workerd binary from zstd archive
$(WORKERD_BIN): $(WORKERD_BIN).zst
	@echo "Decompressing workerd binary..."
	@zstd -d -f $< -o $@
	@chmod +x $@

# Check that workerd is installed
check-workerd: $(WORKERD_BIN)
	@test -f $(WORKERD_BIN) || \
		(echo "Error: workerd not found at $(WORKERD_BIN)" && \
		 echo "Decompress with: zstd -d workerd.zst" && exit 1)

# Generate signing key if not present
$(SGX_SIGN_KEY):
	@echo "Generating SGX signing key..."
	gramine-sgx-gen-private-key $@
	@echo "WARNING: This is a development key. Use a secure key for production."

# Generate the manifest from template
$(MANIFEST): workerd.manifest.template check-gramine check-workerd
	gramine-manifest \
		-Dlog_level=$(LOG_LEVEL) \
		-Darch_libdir=$(ARCH_LIBDIR) \
		-Dworkerd_bin=$(WORKERD_BIN) \
		-Dkettle_bundle_dir=$(KETTLE_BUNDLE_DIR) \
		-DDEBUG=$(DEBUG) \
		$< > $@

# Sign the manifest to create the enclave
$(SGX_MANIFEST) $(SGX_SIG): $(MANIFEST) $(SGX_SIGN_KEY)
ifeq ($(SGX),1)
	@echo "Signing SGX enclave..."
	gramine-sgx-sign \
		--manifest $< \
		--key $(SGX_SIGN_KEY) \
		--output $(SGX_MANIFEST)
	@echo ""
	@echo "Enclave measurements:"
	@gramine-sgx-sigstruct-view $(SGX_SIG) | grep -E "(mr_enclave|mr_signer|isv_prod_id|isv_svn)"
	@# Save MRENCLAVE to file for later comparison
	@gramine-sgx-sigstruct-view $(SGX_SIG) | grep "mr_enclave" | awk '{print $$2}' > $(MRENCLAVE_FILE)
	@echo "MRENCLAVE saved to $(MRENCLAVE_FILE)"
else
	@echo "SGX disabled, skipping signing"
	@cp $(MANIFEST) $(SGX_MANIFEST)
	@touch $(SGX_SIG)
	@echo "direct" > $(MRENCLAVE_FILE)
endif

# Generate token for enclave (optional, for some configurations)
$(SGX_TOKEN): $(SGX_SIG)
ifeq ($(SGX),1)
	gramine-sgx-get-token --output $@ --sig $(SGX_SIG)
endif

# Run the enclave
run: $(SGX_MANIFEST) $(SGX_SIG)
ifeq ($(SGX),1)
	@$(MAKE) sgx-run
else
	@$(MAKE) direct-run
endif

# Check MRENCLAVE compatibility with existing storage
# If do-storage has data from a different MRENCLAVE, abort with helpful error
check-mrenclave: $(MRENCLAVE_FILE)
	@if [ -f "$(MRENCLAVE_MARKER)" ]; then \
		CURRENT=$$(cat $(MRENCLAVE_FILE)); \
		STORED=$$(cat $(MRENCLAVE_MARKER)); \
		if [ "$$CURRENT" != "$$STORED" ]; then \
			echo ""; \
			echo "================================================================================"; \
			echo "MRENCLAVE mismatch detected!"; \
			echo "================================================================================"; \
			echo ""; \
			echo "The enclave has been rebuilt with a different measurement:"; \
			echo "  Current MRENCLAVE: $$CURRENT"; \
			echo "  Storage MRENCLAVE: $$STORED"; \
			echo ""; \
			echo "The encrypted data in $(DO_STORAGE_DIR)"; \
			echo "cannot be decrypted with the current enclave."; \
			echo ""; \
			echo "To fix this, clear the old storage data (destructive):"; \
			echo "  rm -rf $(DO_STORAGE_DIR)/*"; \
			echo ""; \
			echo "================================================================================"; \
			echo ""; \
			exit 1; \
		fi; \
	fi
	@# Create storage directory and marker if needed
	@mkdir -p $(DO_STORAGE_DIR)
	@if [ ! -f "$(MRENCLAVE_MARKER)" ]; then \
		cp $(MRENCLAVE_FILE) $(MRENCLAVE_MARKER); \
		echo "Created MRENCLAVE marker in $(MRENCLAVE_MARKER)"; \
	fi

# Run in SGX mode
sgx-run: $(SGX_MANIFEST) $(SGX_SIG) check-mrenclave
	@echo "Starting kettle in SGX enclave..."
	@echo "  Serving on http://localhost:3001"
	$(GRAMINE) workerd

# Run in direct mode (for testing without SGX hardware)
direct-run: $(MANIFEST)
	@echo "Starting kettle in direct mode (no SGX)..."
	@echo "  Serving on http://localhost:3001"
	gramine-direct workerd

# Print enclave measurements (MRENCLAVE/MRSIGNER)
measurements: $(SGX_SIG)
	@echo "=== Enclave Measurements ==="
	@gramine-sgx-sigstruct-view $(SGX_SIG)

# Verify SGX is available on the system
check-sgx:
	@echo "Checking SGX availability..."
	@is-sgx-available || (echo "SGX not available on this system" && exit 1)
	@echo "SGX is available."

# Clean build artifacts
clean:
	rm -f $(MANIFEST) $(SGX_MANIFEST) $(SGX_SIG) $(SGX_TOKEN) $(MRENCLAVE_FILE)
	rm -rf __pycache__

# Clean everything including keys and decompressed binary
distclean: clean
	rm -f $(SGX_SIGN_KEY)
	rm -f $(WORKERD_BIN)

# Help target
help:
	@echo "Gramine SGX Makefile for Kettle"
	@echo ""
	@echo "Targets:"
	@echo "  all          - Build the SGX enclave (default)"
	@echo "  run          - Run kettle in SGX enclave"
	@echo "  direct-run   - Run in direct mode (no SGX)"
	@echo "  measurements - Print MRENCLAVE/MRSIGNER values"
	@echo "  check-sgx    - Verify SGX hardware availability"
	@echo "  clean        - Remove build artifacts"
	@echo "  distclean    - Remove all generated files"
	@echo ""
	@echo "Variables:"
	@echo "  SGX=1        - Enable SGX (default)"
	@echo "  SGX=0        - Disable SGX (direct mode)"
	@echo "  DEBUG=1      - Enable debug mode"
	@echo "  LOG_LEVEL=   - Set log level (error, warning, debug, trace)"
	@echo ""
	@echo "Example:"
	@echo "  make SGX=1 LOG_LEVEL=debug"
	@echo "  make run"
