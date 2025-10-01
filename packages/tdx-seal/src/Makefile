# Makefile for TDX Sealing Executable
# Requires root privileges and TDX-capable hardware

CC = gcc
CFLAGS = -Wall -Wextra -O2 -std=c99 -fno-stack-protector
LDFLAGS = -lssl -lcrypto
TARGET = tdx_seal
SOURCE = tdx_seal.c

# Try to detect OpenSSL paths
OPENSSL_CFLAGS = $(shell pkg-config --cflags openssl 2>/dev/null || echo "")
OPENSSL_LDFLAGS = $(shell pkg-config --libs openssl 2>/dev/null || echo "-lssl -lcrypto")

# Use detected paths if available
ifneq ($(OPENSSL_CFLAGS),)
    CFLAGS += $(OPENSSL_CFLAGS)
endif
ifneq ($(OPENSSL_LDFLAGS),)
    LDFLAGS = $(OPENSSL_LDFLAGS)
endif

# Default target
all: $(TARGET)

# Build the executable
$(TARGET): $(SOURCE)
	$(CC) $(CFLAGS) -o $(TARGET) $(SOURCE) $(LDFLAGS)

# Install the executable (requires root)
install: $(TARGET)
	sudo cp $(TARGET) /usr/local/bin/
	sudo chmod +x /usr/local/bin/$(TARGET)

# Clean build artifacts
clean:
	rm -f $(TARGET)

# Run the executable (requires root)
run: $(TARGET)
	sudo ./$(TARGET)

# Debug build
debug: CFLAGS += -g -DDEBUG
debug: $(TARGET)

# Help target
help:
	@echo "Available targets:"
	@echo "  all     - Build the TDX sealing executable"
	@echo "  install - Install the executable to /usr/local/bin (requires root)"
	@echo "  clean   - Remove build artifacts"
	@echo "  run     - Build and run the executable (requires root)"
	@echo "  debug   - Build with debug symbols"
	@echo "  help    - Show this help message"
	@echo ""
	@echo "Requirements:"
	@echo "  - Root privileges"
	@echo "  - TDX-capable Intel CPU"
	@echo "  - TDX VM environment"
	@echo "  - OpenSSL development libraries"

.PHONY: all install clean run debug help
