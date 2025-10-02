# Makefile for TDX Sealing Executable (Rust implementation)
# Intel TDX Sealing - Deterministic Private Key Derivation

CARGO = cargo
TARGET_DIR = target
RELEASE_DIR = $(TARGET_DIR)/release
DEBUG_DIR = $(TARGET_DIR)/debug
BINARY_NAME = tdx-seal-rs
RELEASE_BINARY = $(RELEASE_DIR)/$(BINARY_NAME)
DEBUG_BINARY = $(DEBUG_DIR)/$(BINARY_NAME)

# Default target
.PHONY: all
all: release

# Build in release mode (simulation)
.PHONY: release
release:
	$(CARGO) build --release

# Build in debug mode (simulation)
.PHONY: debug
debug:
	$(CARGO) build

# Build with TDX guest library support (release)
.PHONY: release-tdx
release-tdx:
	$(CARGO) build --release --features tdx-guest

# Build with TDX guest library support (debug)
.PHONY: debug-tdx
debug-tdx:
	$(CARGO) build --features tdx-guest

# Run in simulation mode
.PHONY: run
run: release
	./$(RELEASE_BINARY)

# Run with verbose output
.PHONY: run-verbose
run-verbose: release
	./$(RELEASE_BINARY) --verbose

# Run with base64 output
.PHONY: run-base64
run-base64: release
	./$(RELEASE_BINARY) --format base64

# Run with TDX guest library support (requires root and TDX environment)
.PHONY: run-tdx
run-tdx: release-tdx
	sudo ./$(RELEASE_BINARY)

# Run with TDX guest library support and verbose output
.PHONY: run-tdx-verbose
run-tdx-verbose: release-tdx
	sudo ./$(RELEASE_BINARY) --verbose

# Install the executable (requires root)
.PHONY: install
install: release
	sudo cp $(RELEASE_BINARY) /usr/local/bin/
	sudo chmod +x /usr/local/bin/$(BINARY_NAME)

# Install with TDX guest library support
.PHONY: install-tdx
install-tdx: release-tdx
	sudo cp $(RELEASE_BINARY) /usr/local/bin/
	sudo chmod +x /usr/local/bin/$(BINARY_NAME)

# Clean build artifacts
.PHONY: clean
clean:
	$(CARGO) clean

# Run tests
.PHONY: test
test:
	$(CARGO) test

# Run tests with TDX guest library support
.PHONY: test-tdx
test-tdx:
	$(CARGO) test --features tdx-guest

# Run benchmarks
.PHONY: bench
bench:
	$(CARGO) bench

# Check code formatting
.PHONY: fmt
fmt:
	$(CARGO) fmt

# Check code with clippy
.PHONY: clippy
clippy:
	$(CARGO) clippy

# Check code with clippy and TDX guest library support
.PHONY: clippy-tdx
clippy-tdx:
	$(CARGO) clippy --features tdx-guest

# Check dependencies for security vulnerabilities
.PHONY: audit
audit:
	$(CARGO) audit

# Update dependencies
.PHONY: update
update:
	$(CARGO) update

# Show help
.PHONY: help
help:
	@echo "Available targets:"
	@echo "  all              - Build in release mode (default)"
	@echo "  release          - Build in release mode (simulation)"
	@echo "  debug            - Build in debug mode (simulation)"
	@echo "  release-tdx      - Build in release mode with TDX guest library"
	@echo "  debug-tdx        - Build in debug mode with TDX guest library"
	@echo "  run              - Build and run in simulation mode"
	@echo "  run-verbose      - Build and run with verbose output"
	@echo "  run-base64       - Build and run with base64 output format"
	@echo "  run-tdx          - Build and run with TDX guest library (requires root)"
	@echo "  run-tdx-verbose  - Build and run with TDX guest library and verbose output"
	@echo "  install          - Install the executable to /usr/local/bin (requires root)"
	@echo "  install-tdx      - Install with TDX guest library support (requires root)"
	@echo "  clean            - Remove build artifacts"
	@echo "  test             - Run tests"
	@echo "  test-tdx         - Run tests with TDX guest library support"
	@echo "  bench            - Run benchmarks"
	@echo "  fmt              - Check code formatting"
	@echo "  clippy           - Check code with clippy"
	@echo "  clippy-tdx       - Check code with clippy and TDX guest library support"
	@echo "  audit            - Check dependencies for security vulnerabilities"
	@echo "  update           - Update dependencies"
	@echo "  help             - Show this help message"
	@echo ""
	@echo "Requirements:"
	@echo "  - Rust toolchain (1.70+)"
	@echo "  - Cargo package manager"
	@echo "  - Root privileges (for real TDX mode)"
	@echo "  - TDX-capable Intel CPU (for real TDX mode)"
	@echo "  - TDX VM environment (for real TDX mode)"
	@echo ""
	@echo "Examples:"
	@echo "  make release     # Build in release mode"
	@echo "  make run         # Build and run in simulation mode"
	@echo "  make run-tdx     # Build and run with TDX guest library (requires root)"
	@echo "  make install     # Install system-wide (requires root)"
