#!/bin/bash

# Build script for tdx-seal-rs
# Intel TDX Sealing - Deterministic Private Key Derivation (Rust implementation)

set -e

echo "Building tdx-seal-rs..."

# Check if we're in the right directory
if [ ! -f "Cargo.toml" ]; then
    echo "Error: Cargo.toml not found. Please run this script from the tdx-seal-rs directory."
    exit 1
fi

# Check if cargo is installed
if ! command -v cargo &> /dev/null; then
    echo "Error: cargo is not installed. Please install Rust and Cargo first."
    echo "Visit: https://rustup.rs/"
    exit 1
fi

# Build options
BUILD_MODE="release"
ENABLE_TDX_GUEST=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --debug)
            BUILD_MODE="debug"
            shift
            ;;
        --with-tdx-guest)
            ENABLE_TDX_GUEST=true
            shift
            ;;
        --help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --debug           Build in debug mode (default: release)"
            echo "  --with-tdx-guest  Enable tdx-guest library support"
            echo "  --help            Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                           # Build in release mode without tdx-guest"
            echo "  $0 --debug                   # Build in debug mode"
            echo "  $0 --with-tdx-guest          # Build with tdx-guest support"
            echo "  $0 --debug --with-tdx-guest  # Build in debug mode with tdx-guest"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Set build features
FEATURES=""
if [ "$ENABLE_TDX_GUEST" = true ]; then
    FEATURES="--features tdx-guest"
    echo "Building with tdx-guest support..."
else
    echo "Building without tdx-guest support (simulation mode)..."
fi

# Build the project
echo "Building in $BUILD_MODE mode..."
if [ "$BUILD_MODE" = "debug" ]; then
    cargo build $FEATURES
    BINARY_PATH="./target/debug/tdx-seal-rs"
else
    cargo build --release $FEATURES
    BINARY_PATH="./target/release/tdx-seal-rs"
fi

if [ $? -eq 0 ]; then
    echo ""
    echo "Build successful!"
    echo "Binary location: $BINARY_PATH"
    echo ""
    echo "To run the executable:"
    if [ "$ENABLE_TDX_GUEST" = true ]; then
        echo "  sudo $BINARY_PATH"
    else
        echo "  $BINARY_PATH"
    fi
    echo ""
    echo "For help:"
    echo "  $BINARY_PATH --help"
else
    echo "Build failed!"
    exit 1
fi
