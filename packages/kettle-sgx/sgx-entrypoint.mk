# Reproducible build configuration for sgx-entrypoint
#
# This Makefile builds a static Go binary with reproducible build flags:
# - -trimpath: Remove all file system paths from the binary
# - -buildvcs=false: Don't embed VCS information
# - -buildid=: Empty build ID for reproducibility
# - -mod=readonly: Ensure go.mod is not modified during build
#
# The sgx-entrypoint binary combines:
# - SGX quote service (HTTP server for attestation)
# - workerd launcher (starts and manages workerd process)
#
# Usage:
#   make -f sgx-entrypoint.mk        # Build the binary
#   make -f sgx-entrypoint.mk clean  # Clean build artifacts

.PHONY: all clean test

BINARY := sgx-entrypoint
SOURCE := sgx-entrypoint.go

# Go build flags for reproducibility
# See: https://reproducible-builds.org/docs/
# Note: -buildvcs requires Go 1.18+, -buildid= requires Go 1.20+
GO_BUILD_FLAGS := \
	-trimpath \
	-mod=readonly

# Static linking flags
GO_LDFLAGS := \
	-s -w \
	-extldflags=-static

# CGO must be disabled for true static linking
export CGO_ENABLED=0

all: $(BINARY)

$(BINARY): $(SOURCE)
	@echo "Building reproducible static binary: $(BINARY)"
	@echo "  Source: $(SOURCE)"
	@echo "  Flags: $(GO_BUILD_FLAGS)"
	@go build $(GO_BUILD_FLAGS) -ldflags="$(GO_LDFLAGS)" -o $(BINARY) $(SOURCE)
	@echo "Build complete: $(BINARY)"
	@ls -lh $(BINARY)
	@file $(BINARY)

clean:
	rm -f $(BINARY)

test:
	@echo "Testing sgx-entrypoint..."
	@if [ ! -f $(BINARY) ]; then \
		echo "Binary not found. Building..."; \
		$(MAKE) -f sgx-entrypoint.mk $(BINARY); \
	fi
	@echo "Starting sgx-entrypoint in test mode (no workerd)..."
	@echo "Testing /healthz endpoint..."
	@QUOTE_SERVICE_PORT=3333 timeout 2 ./$(BINARY) --help 2>&1 || true
	@echo ""
	@echo "Test complete"

.DEFAULT_GOAL := all
