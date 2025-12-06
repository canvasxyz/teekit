## @teekit/qvl

@teekit/qvl is a lightweight, WebCrypto-based SGX, TDX, and SEV-SNP
quote verification library written in TypeScript. It provides full
chain-of-trust validation from the Root CA, through intermediate
certificates, and quoting enclaves (SGX/TDX only), down to quote
signature verification.

See the
[tests](https://github.com/canvasxyz/teekit/tree/main/packages/qvl/test)
for usage examples.

For more information, see the [workspace
readme](https://github.com/canvasxyz/teekit) in Github.

### SEV-SNP Chain of Trust

AMD SEV-SNP uses a certificate chain rooted at AMD's ARK (AMD Root Key).
The ARK and ASK certificates for Milan are embedded in this library.
Only the VCEK must be fetched from AMD's Key Distribution Service (KDS)
since it's derived from the chip's unique ID and TCB version.

```
┌─────────────────────────────────────────────────────────────────┐
│                 AMD Root Key (ARK)                              │
│                           ↓                                     │
│                 AMD SEV Key (ASK)                               │
│                           ↓                                     │
│           Versioned Chip Endorsement Key (VCEK)                 │
│              [fetched from AMD KDS per chip]                    │
│                           ↓                                     │
│                   Report Signature                              │
│                    (ECDSA P-384)                                │
│                           ↓                                     │
│                    SEV-SNP Report                               │
│                           │                                     │
│       ┌───────────────────┼───────────────────┐                 │
│       ↓                   ↓                   ↓                 │
│   measurement        report_data          host_data             │
│   (launch digest)  (guest-provided)   (host-provided)           │
│                                                                 │
│   Policy Fields:                                                │
│   ├── vmpl (privilege level 0-3)                                │
│   ├── guest_svn (security version)                              │
│   └── policy (debug, migration, SMT flags)                      │
└─────────────────────────────────────────────────────────────────┘
```

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

## License

MIT (C) 2025
