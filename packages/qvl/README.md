## @teekit/qvl

@teekit/qvl is a lightweight, WebCrypto-based SGX/TDX quote
verification library written in TypeScript (ESM). It provides full
chain-of-trust validation from the Intel SGX Root CA, through quoting
enclave checks, down to quote signature verification.

See the
[tests](https://github.com/canvasxyz/teekit/tree/main/packages/qvl/test)
for usage examples.

For more information, see the [workspace
readme](https://github.com/canvasxyz/teekit) in Github.

### TDX Chain of Trust

```
┌─────────────────────────────────────────────────────────────────┐
│                      Intel Root CA                              │
│                           ↓                                     │
│                    PCK Certificate                              │
│                           ↓                                     │
│                   QE Report Signature                           │
│                           ↓                                     │
│                      TDX Quote                                  │
│                           │                                     │
│            ┌──────────────┴──────────────┐                      │
│            ↓                             ↓                      │
│      Measurements                   report_data                 │
│   (mr_td, rtmr0-3)             (application-defined)            │
└─────────────────────────────────────────────────────────────────┘
```

### Azure Chain of Trust

For Azure TDX, we support vTPM-based attestation. This relies on hash
binding via a separate `runtime_data` object:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Intel Root CA                              │
│                           ↓                                     │
│                    PCK Certificate                              │
│                           ↓                                     │
│                   QE Report Signature                           │
│                           ↓                                     │
│                      TDX Quote                                  │
│                           │                                     │
│            ┌──────────────┴──────────────┐                      │
│            ↓                             ↓                      │
│      Measurements                 report_data[0:32]             │
│   (mr_td, rtmr0-3)            = SHA256(runtime_data)            │
│                                          ↓                      │
│                                   runtime_data JSON             │
│                                          │                      │
│                          ┌───────────────┼───────────────┐      │
│                          ↓               ↓               ↓      │
│                        keys          vm-config       user-data  │
│                          │                      (e.g. key hash) │
│                          ├── HCLAkPub                           │
│                          └── HCLEkPub                           │
└─────────────────────────────────────────────────────────────────┘
```

## License

MIT (C) 2025
