# Intel TDX Sealing - Deterministic Private Key Derivation (Rust Implementation)

This is a Rust implementation of the TDX sealing functionality that demonstrates how to use Intel TDX sealing to derive a deterministic private key within a TDX virtual machine (VM) using the [Intel TDX Guest](https://github.com/intel/tdx-guest) Rust library.

## Overview

The program implements the TDX sealing functionality as described in Intel TDX documentation section 12.8. It:

1. Verifies TDX sealing availability by checking `TDX_FEATURES0.SEALING` and `ATTRIBUTES.MIGRATABLE`
2. Obtains a TDX measurement report using `TDG.MR.REPORT` (simulated)
3. Derives a sealing key using `TDG.KEY.REQUEST` (simulated)
4. Generates a deterministic private key from the sealing key using SHA-256

## Features

- **Rust Implementation**: Modern, memory-safe implementation using Rust
- **TDX Guest Library Integration**: Uses the official Intel TDX Guest Rust library
- **Simulation Mode**: Can run in simulation mode for testing without TDX hardware
- **Flexible Output**: Supports hex and base64 output formats
- **Comprehensive Error Handling**: Robust error handling with detailed error messages
- **Security**: Secure memory clearing of sensitive data

## Requirements

### For Real TDX Environment
- **Root privileges**: The program must run as root to access TDX features
- **TDX-capable hardware**: Intel CPU with TDX support
- **TDX VM environment**: Must run within a TDX virtual machine
- **Rust toolchain**: Rust 1.70+ with Cargo

### For Simulation Mode
- **Rust toolchain**: Rust 1.70+ with Cargo
- **No special privileges required**

## Building

### Quick Start

```bash
# Clone and navigate to the project
cd packages/tdx-seal-rs

# Build in simulation mode (default)
./build.sh

# Build with TDX guest library support
./build.sh --with-tdx-guest

# Build in debug mode
./build.sh --debug

# Build with both options
./build.sh --debug --with-tdx-guest
```

### Manual Build

```bash
# Build in simulation mode
cargo build --release

# Build with TDX guest library support
cargo build --release --features tdx-guest

# Build in debug mode
cargo build

# Build with TDX guest library support in debug mode
cargo build --features tdx-guest
```

## Usage

### Simulation Mode (Default)

```bash
# Run the executable in simulation mode
./target/release/tdx-seal-rs

# Run with verbose output
./target/release/tdx-seal-rs --verbose

# Run with base64 output format
./target/release/tdx-seal-rs --format base64

# Show help
./target/release/tdx-seal-rs --help
```

### Real TDX Environment

```bash
# Run with TDX guest library support (requires root and TDX environment)
sudo ./target/release/tdx-seal-rs

# Run with verbose output
sudo ./target/release/tdx-seal-rs --verbose

# Run with base64 output format
sudo ./target/release/tdx-seal-rs --format base64
```

## Output

The program will output:

1. **TDX Feature Verification**: Confirms sealing is available
2. **MRENCLAVE**: The measurement report enclave identifier
3. **Sealing Key**: The derived sealing key from TDX
4. **Derived Private Key**: The deterministic private key

Example output (simulation mode):
```
Intel TDX Sealing - Deterministic Private Key Derivation (Rust)
===============================================================

TDX_FEATURES0.SEALING = 1 (sealing available)
ATTRIBUTES.MIGRATABLE = 0 (sealing available)
Successfully obtained TDX measurement report (simulated)
MRENCLAVE: abacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9
Sealing Key: 78797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f9091929394959697
Successfully derived sealing key (simulated)
Successfully derived deterministic private key
Derived Private Key: 9f8e7d6c5b4a3928012345678901234567890abcdef1234567890abcdef123456

Successfully derived deterministic private key using TDX sealing!
```

## Command Line Options

- `--verbose, -v`: Enable verbose output
- `--format, -f <FORMAT>`: Output format (hex or base64, default: hex)
- `--help, -h`: Show help message

## Error Handling

The program will exit with an error if:

- Not running as root (in real TDX mode)
- `TDX_FEATURES0.SEALING` is not set to 1
- `ATTRIBUTES.MIGRATABLE` is not set to 0
- TDX TDCALL instructions fail (in real TDX mode)
- Cryptographic operations fail

## Security Considerations

- The program securely zeros sensitive memory before exiting
- All cryptographic operations use secure implementations
- The derived private key is deterministic and unique to the TDX environment
- The sealing key is bound to the specific TDX measurement report
- Memory safety is guaranteed by Rust's ownership system

## Implementation Details

### TDX TDCALL Functions

- **TDG.VP.INFO**: Gets TDX execution environment information (via tdx-guest library)
- **TDG.MR.REPORT**: Obtains the TDX measurement report containing MRENCLAVE (simulated)
- **TDG.KEY.REQUEST**: Derives a sealing key using the MRENCLAVE value (simulated)

### Key Derivation

The deterministic private key is derived using:
1. Domain separator: "TDX_SEALING_PRIVATE_KEY_DERIVATION"
2. Sealing key from TDX
3. SHA-256 hash function

This ensures the private key is:
- Deterministic (same input always produces same output)
- Unique to the TDX environment
- Cryptographically secure

### TDX Guest Library Integration

The implementation uses the official Intel TDX Guest Rust library when available:

```rust
// When tdx-guest feature is enabled
use tdx_guest::tdcall::get_tdinfo;

// Get TDX information
let td_info = get_tdinfo()?;
```

## Troubleshooting

### Common Issues

1. **Permission denied**: Ensure running as root in real TDX mode
2. **TDX not available**: Verify running in TDX VM with TDX support
3. **Build errors**: Ensure Rust toolchain is up to date
4. **TDCALL failures**: Check TDX VM configuration and hardware support

### Dependencies

Install Rust toolchain:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

### Build Issues

If you encounter build issues with the tdx-guest library:

1. **Git dependency issues**: The tdx-guest library is fetched from GitHub
2. **Feature not available**: Use simulation mode if tdx-guest is not available
3. **Platform compatibility**: Ensure you're building on a supported platform

## Comparison with C Implementation

This Rust implementation provides several advantages over the C version:

- **Memory Safety**: Rust's ownership system prevents memory leaks and buffer overflows
- **Error Handling**: Comprehensive error handling with the `anyhow` crate
- **Modern Tooling**: Uses Cargo for dependency management and building
- **Cross-Platform**: Better cross-platform support
- **Simulation Mode**: Can run without TDX hardware for testing
- **Flexible Output**: Multiple output formats supported

## License

This implementation is provided as a reference for TDX sealing functionality. Please refer to Intel TDX documentation for official specifications and requirements.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## References

- [Intel TDX Guest Rust Library](https://github.com/intel/tdx-guest)
- [Intel TDX Documentation](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-trust-domain-extensions.html)
- [Rust Programming Language](https://www.rust-lang.org/)
