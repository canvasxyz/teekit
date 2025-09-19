# TDX Attestation Verification Guide

## Overview

This guide walks you through verifying a TDX (Trust Domain Extensions) attestation from stdin. Your attestation contains a TDX quote with a 3-certificate chain and verifier nonce.

## Analysis of Your Attestation

### Quote Structure
- **Version**: 4 (TDX Quote v4)
- **Total Size**: 7,998 bytes  
- **Certificate Chain**: 3 certificates (Intel PCK chain)
- **TEE Type**: 129 (TDX identifier)

### Key Measurements
- **MRENCLAVE**: `ead5ee68461afd9b6c728dce7534602d...`
- **MRSIGNER**: `00000000000000000000001000000000...`  
- **Report Data**: `00000000000000009d112d1d2c2546d9...`

### Verifier Nonce
- **Timestamp**: 2025-08-19 19:05:37 +0000 UTC
- **Signature**: 384 bytes (RSA/ECDSA signature)

## Step-by-Step Verification Process

### 1. Parse the TDX Quote Structure

```bash
# Extract and decode the base64 quote
echo "$quote_base64" | base64 -d > quote.bin

# Examine the header (first 48 bytes)
xxd -l 48 quote.bin
```

**Expected Structure**:
- Bytes 0-1: Version (0x0004 for v4)
- Bytes 2-3: Attestation Key Type  
- Bytes 4-7: TEE Type (0x81 for TDX)
- Bytes 48-431: Report Body (384 bytes)
- Bytes 432+: Signature Data with certificates

### 2. Verify Certificate Chain

```bash
# Extract certificates from the quote
openssl x509 -in cert1.pem -text -noout
openssl x509 -in cert2.pem -text -noout  
openssl x509 -in cert3.pem -text -noout

# Verify chain (cert1 signed by cert2, cert2 signed by cert3)
openssl verify -CAfile root_ca.pem -untrusted cert2.pem cert1.pem
```

**Your certificate chain**:
1. **Leaf Certificate**: Intel SGX PCK Certificate (platform-specific)
2. **Intermediate**: Intel SGX Processor CA
3. **Root**: Intel SGX Root CA

### 3. Validate Quote Signature

The quote signature proves the measurements came from genuine Intel hardware:

```python
# Verify quote signature using the leaf certificate's public key
def verify_quote_signature(quote_bytes, cert_pem):
    # Extract signature from quote
    signature_data = quote_bytes[432:]  # Everything after report body
    
    # Hash the signed portion (header + report body)
    signed_data = quote_bytes[:432]
    
    # Verify using certificate's public key
    # (requires cryptographic library implementation)
```

### 4. Check Measurements Against Expected Values

```python
def validate_measurements(mrenclave, mrsigner, expected_values):
    """Validate enclave measurements against known good values"""
    
    if mrenclave != expected_values['enclave_hash']:
        raise ValueError("MRENCLAVE mismatch - untrusted enclave")
    
    if mrsigner != expected_values['signer_hash']:
        raise ValueError("MRSIGNER mismatch - untrusted signer")
    
    print("✓ Measurements validated successfully")
```

### 5. Verify Report Data

The report data should contain your challenge/nonce:

```python
def verify_report_data(report_data, expected_challenge):
    """Verify report data contains expected challenge"""
    
    # Report data is 64 bytes, may contain:
    # - Your challenge/nonce
    # - Hash of additional data
    # - Application-specific data
    
    if expected_challenge not in report_data:
        raise ValueError("Challenge not found in report data")
```

### 6. Validate Verifier Nonce (Optional)

If using a remote verifier service:

```python
def verify_verifier_signature(nonce_data, verifier_public_key):
    """Verify the verifier's signature on the nonce"""
    
    # Reconstruct signed data
    message = nonce_data['val'] + nonce_data['iat']
    signature = base64.b64decode(nonce_data['signature'])
    
    # Verify signature
    verifier_public_key.verify(signature, message, padding.PSS(...))
```

## Complete Verification Script

Run the provided scripts:

```bash
# Basic analysis
python3 simple_tdx_verify.py < attestation.json

# Full verification (requires cryptography library)
python3 verify_tdx.py < attestation.json
```

## Production Checklist

For production TDX attestation verification:

- [ ] **Certificate Validation**
  - [ ] Verify chain to Intel Root CA
  - [ ] Check certificate expiration dates
  - [ ] Validate certificate revocation status (OCSP/CRL)

- [ ] **Quote Verification**  
  - [ ] Verify quote signature cryptographically
  - [ ] Validate quote structure and version
  - [ ] Check TEE configuration (attributes, security version)

- [ ] **Measurement Validation**
  - [ ] Compare MRENCLAVE against expected enclave hash
  - [ ] Validate MRSIGNER against trusted signer
  - [ ] Verify minimum security version numbers

- [ ] **Report Data Validation**
  - [ ] Confirm report data contains your challenge
  - [ ] Validate any additional application data

- [ ] **Freshness & Replay Protection**
  - [ ] Check timestamp freshness (if applicable)
  - [ ] Implement nonce/challenge tracking

## Security Considerations

1. **Pin Expected Measurements**: Always validate MRENCLAVE/MRSIGNER against known good values
2. **Certificate Pinning**: Pin Intel's root CA certificate  
3. **Revocation Checking**: Implement OCSP/CRL checking for certificates
4. **Replay Prevention**: Use unique challenges and track used nonces
5. **Secure Storage**: Protect verification keys and expected measurements

## Troubleshooting

**Common Issues**:
- Certificate chain verification failures → Check Intel root CA
- MRENCLAVE mismatches → Verify enclave build reproducibility  
- Quote signature failures → Validate certificate public key extraction
- Timestamp issues → Check clock synchronization

Your attestation appears structurally valid with a proper 3-certificate Intel chain. Implement the full cryptographic verification for production use.