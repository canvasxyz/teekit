#!/bin/bash

# Test script for TDX Sealing executable
# This script tests the build process and basic functionality

set -e

echo "Testing TDX Sealing Executable Build"
echo "===================================="

# Check if we're in the right directory
if [ ! -f "tdx_seal.c" ]; then
    echo "Error: tdx_seal.c not found. Please run this script from the src directory."
    exit 1
fi

# Check for required tools
echo "Checking build dependencies..."

if ! command -v gcc &> /dev/null; then
    echo "Error: gcc not found. Please install build-essential."
    exit 1
fi

if ! pkg-config --exists openssl; then
    echo "Error: OpenSSL development libraries not found."
    echo "Please install libssl-dev (Ubuntu/Debian) or openssl-devel (RHEL/CentOS)."
    exit 1
fi

echo "Build dependencies OK"

# Test compilation
echo "Testing compilation..."
make clean
make

if [ ! -f "tdx_seal" ]; then
    echo "Error: Compilation failed - executable not created."
    exit 1
fi

echo "Compilation successful"

# Test executable properties
echo "Testing executable properties..."

if [ ! -x "tdx_seal" ]; then
    echo "Error: Executable is not executable."
    exit 1
fi

# Check file type
file_output=$(file tdx_seal)
if [[ $file_output == *"ELF"* ]] || [[ $file_output == *"Mach-O"* ]]; then
    echo "Executable type: $file_output"
else
    echo "Error: Unexpected file type: $file_output"
    exit 1
fi

# Test help functionality (if implemented)
echo "Testing basic functionality..."

# Note: We can't actually run the TDX executable without TDX hardware
# So we just verify it exists and is executable
echo "Executable created successfully: tdx_seal"

# Clean up
echo "Cleaning up..."
make clean

echo "All tests passed!"
echo ""
echo "Note: To actually run the TDX sealing executable, you need:"
echo "1. Root privileges"
echo "2. TDX-capable Intel CPU"
echo "3. TDX VM environment"
echo "4. Run: sudo ./tdx_seal"
