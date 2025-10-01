# Intel TDX Sealing - Deterministic Private Key Derivation

This executable demonstrates how to use Intel TDX sealing to derive a deterministic private key within a TDX virtual machine (VM).

## Overview

The program implements the TDX sealing functionality as described in Intel TDX documentation section 12.8. It:

1. Verifies TDX sealing availability by checking `TDX_FEATURES0.SEALING` and `ATTRIBUTES.MIGRATABLE`
2. Obtains a TDX measurement report using `TDG.MR.REPORT`
3. Derives a sealing key using `TDG.KEY.REQUEST`
4. Generates a deterministic private key from the sealing key using SHA-256

## Requirements

- **Root privileges**: The program must run as root to access TDX features
- **TDX-capable hardware**: Intel CPU with TDX support
- **TDX VM environment**: Must run within a TDX virtual machine
- **OpenSSL**: Development libraries for cryptographic operations

## Building

```bash
# Build the executable
make

# Build with debug symbols
make debug

# Clean build artifacts
make clean
```

## Installation

```bash
# Install to /usr/local/bin (requires root)
sudo make install
```

## Usage

```bash
# Run the executable (requires root)
sudo ./tdx_seal

# Or if installed system-wide
sudo tdx_seal
```

## Output

The program will output:

1. **TDX Feature Verification**: Confirms sealing is available
2. **MRENCLAVE**: The measurement report enclave identifier
3. **Sealing Key**: The derived sealing key from TDX
4. **Derived Private Key**: The deterministic private key

Example output:
```
Intel TDX Sealing - Deterministic Private Key Derivation
========================================================

TDX_FEATURES0.SEALING = 1 (sealing available)
ATTRIBUTES.MIGRATABLE = 0 (sealing available)
Successfully obtained TDX measurement report
MRENCLAVE: a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456
Sealing Key: f1e2d3c4b5a6978012345678901234567890abcdef1234567890abcdef123456
Successfully derived sealing key
Successfully derived deterministic private key
Derived Private Key: 9f8e7d6c5b4a3928012345678901234567890abcdef1234567890abcdef123456

Successfully derived deterministic private key using TDX sealing!
```

## Error Handling

The program will exit with an error if:

- Not running as root
- `TDX_FEATURES0.SEALING` is not set to 1
- `ATTRIBUTES.MIGRATABLE` is not set to 0
- TDX TDCALL instructions fail
- Cryptographic operations fail

## Security Considerations

- The program securely zeros sensitive memory before exiting
- All cryptographic operations use OpenSSL's secure implementations
- The derived private key is deterministic and unique to the TDX environment
- The sealing key is bound to the specific TDX measurement report

## Implementation Details

### TDX TDCALL Functions

- **TDG.MR.REPORT**: Obtains the TDX measurement report containing MRENCLAVE
- **TDG.KEY.REQUEST**: Derives a sealing key using the MRENCLAVE value

### Key Derivation

The deterministic private key is derived using:
1. Domain separator: "TDX_SEALING_PRIVATE_KEY_DERIVATION"
2. Sealing key from TDX
3. SHA-256 hash function

This ensures the private key is:
- Deterministic (same input always produces same output)
- Unique to the TDX environment
- Cryptographically secure

## Troubleshooting

### Common Issues

1. **Permission denied**: Ensure running as root
2. **TDX not available**: Verify running in TDX VM with TDX support
3. **OpenSSL errors**: Install OpenSSL development libraries
4. **TDCALL failures**: Check TDX VM configuration and hardware support

### Dependencies

Install required packages on Ubuntu/Debian:
```bash
sudo apt-get install build-essential libssl-dev
```

Install required packages on RHEL/CentOS:
```bash
sudo yum install gcc openssl-devel
```

## License

This implementation is provided as a reference for TDX sealing functionality. Please refer to Intel TDX documentation for official specifications and requirements.

