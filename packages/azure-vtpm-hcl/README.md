## @teekit/azure-vtpm-hcl

Parses attestation reports from the Azure vTPM host compatibility layer.

### Usage

Parse HCL report from bytes or base64:

```
parseHclReport(data)
parseHclReportBase64(b64)
```

Extract attestation key and userdata from parsed report:

```
getAkPub(report)
getUserData(report)
getUserDataBytes(report)
```

Verify chain of trust binding:

```
computeVariableDataHash(report)
verifyVariableDataBinding(report, quoteReportData)
```

### About HCL Attestation

Azure HCL attestations are made via the TDX quote's `report_data` field.
The first 32 bytes of `report_data` are set to `sha256(variable_data)`.

The variable_data itself encodes raw JSON:

```
{
    "keys": [{ "kid": "HCLAkPub", "kty": "RSA", "n": "...", "e": "AQAB" }],
    "user-data": "4B453B5F70E5E2080AD97AFC62B0546BA3..."
}
```

The user-data field is based on the --aztdx quote we requested using
`trustauthority-cli`, and is equal to SHA512(nonce || userData) encoded
as a hex string. For example:

```
trustauthority-cli quote --aztdx \
    --nonce 'dGVzdG5vbmNl' \                     # base64("testnonce")
    --user-data 'A6gQcDB6++rAaw3074ZXY5GLXiq...' # base64(x25519 pubkey)
```

```
{
    "keys": [{ "kid": "HCLAkPub", ... }],
    "user-data": "4B453B5F70E5E2080AD97AFC62B0546BA3EFED53966A5DA9BBB42BCC8DECB5BE6B77F1F
  6F042C7FBFFA2CEA1042D89AA96CA51D204AD00ABA2D04FA5A9702BE9"
}
```

## HCL Attestation Format

The vTPM HCL attestation is a separate attestation, with a chain of trust
rooted in an Microsoft Azure root CA. The HCL contains an IGVM request data
section, the same as the VariableData referenced in `report_data`.

```
  IGVM Request Data (20 bytes fixed header + variable)
  ├── dataSize:           u32  (4 bytes) - total size of this structure
  ├── version:            u32  (4 bytes)
  ├── reportType:         u32  (4 bytes) - 4 = TDX, 2 = SNP
  ├── reportDataHashType: u32  (4 bytes) - hash algorithm (1 = SHA256)
  ├── variableDataSize:   u32  (4 bytes) - size of variableData
  └── variableData:       [u8] (variableDataSize bytes) ← THIS is what gets hashed
```

## License

MIT (C) 2025
