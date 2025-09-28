## ra-https-qvl

ra-https-qvl is a lightweight, WebCrypto-based SGX/TDX quote verification library written in TypeScript (ESM). It provides full chain-of-trust validation from the Intel SGX Root CA, through quoting enclave checks, down to quote signature verification.

## Features

- **TDX v4/v5 and SGX v3** quote parsing and validation
- **Certificate chain** validation to Intel SGX Root CA (ECDSA)
- **CRL-based revocation** checks (DER CRL parsing helper included)
- **QE report signature** and **QE binding** verification
- **Quote signature** verification (ECDSA P‑256)
- Optional: **TCB evaluation** (match quote SVNs against Intel TCB Info JSON)
- Small API surface; zero native dependencies

## Requirements

- Node.js 20+ (WebCrypto `crypto.subtle`)
- ESM environment (`"type": "module"`)

## Quickstart

```ts
import { verifyTdx } from "ra-https-qvl"

const ok = await verifyTdx(quote, {
  date: Date.now(),     // verification time (ms)
  crls: [],             // optional: array of DER CRLs as Uint8Array
})
```

```ts
import { verifySgx } from "ra-https-qvl"

const ok = await verifySgx(quoteBytes, {
  date: Date.now(),
  crls: [],
})
```

If cert_data is missing in the quote, you can provide the leaf, intermediate, and root PEMs via `extraCertdata`.

You can also provide alternative pinned root certificates. We embed the Intel SGX Root CA and use it as a default otherwise.

```ts
import { verifyTdx, QV_X509Certificate } from "ra-https-qvl"

const rootPem = "-----BEGIN CERTIFICATE-----..." // Intel SGX Root CA PEM
const intermediatePem = "-----BEGIN CERTIFICATE-----..."
const leafPem = "-----BEGIN CERTIFICATE-----..."

await verifyTdx(quoteBytes, {
  date: Date.now(),
  extraCertdata: [leafPem, intermediatePem, rootPem],
  // Optional: pin the expected root certificate object
  pinnedRootCerts: [new QV_X509Certificate(rootPem)],
  crls: [],
})
```

## API

- `verifyTdx(quote: Uint8Array, config?: VerifyConfig): Promise<boolean>`
- `verifyTdxBase64(quote: string, config?: VerifyConfig): Promise<boolean>`
- `verifySgx(quote: Uint8Array, config?: VerifyConfig): Promise<boolean>`
- `verifySgxBase64(quote: string, config?: VerifyConfig): Promise<boolean>`
- `evaluateTcb(quote: string | Uint8Array, tcbInfo: SgxTcbInfo | TdxTcbInfo, options?): { ok, type, matchedStatus, matchedIndex }`
- `evaluateSgxTcb(...)`, `evaluateTdxTcb(...)` for narrower control
- `verifyTcbInfoSignature({ tcbInfoObject|tcbInfoText, signature, signingChain })` to check Intel JSON signatures

Verification performs:
- PCK chain build and validation (leaf → intermediate → root)
- Chain validity window checks against `config.date` (or now)
- Optional CRL membership checks via `config.crls`
- Root pinning against Intel SGX Root CA by default (override via `pinnedRootCerts`)
- QE report signature verification
- QE binding check between `attestation_public_key` and QE report data
- Quote signature verification by `attestation_public_key`
 - (Optional) TCB evaluation when you provide Intel `tcbInfo.json`

Errors are thrown for invalid conditions (e.g. "invalid root", "invalid cert chain", "expired cert chain, or not yet valid", "revoked certificate in cert chain", "invalid qe report signature", "invalid qe report binding", "invalid signature over quote", "only TDX/SGX is supported", "only ECDSA att_key_type is supported", "only PCK cert_data is supported", "missing certdata", "Unsupported quote version").

### Configuration

```ts
export interface VerifyConfig {
  crls: Uint8Array[]                 // DER CRLs for revocation checks (optional; [] if none)
  pinnedRootCerts?: QV_X509Certificate[]
  date?: number                      // ms since epoch; defaults to now
  extraCertdata?: string[]           // PEM blocks when quote lacks embedded cert_data
}
```

Defaults: `pinnedRootCerts` pins Intel SGX Root CA. Provide your own to narrow trust.

### Parsers

- `parseTdxQuote(quote: Uint8Array)` / `parseTdxQuoteBase64(quote: string)`
- `parseSgxQuote(quote: Uint8Array)` / `parseSgxQuoteBase64(quote: string)`

These return `{ header, body, signature }` views with typed fields:
- TDX: v4 or v5 supported (TEE type 129)
- SGX: v3 supported (TEE type 0)

### Formatters

Human‑readable JSON views for logging:
- `formatTDXHeader(header)`
- `formatTDXQuoteBodyV4(body)`
- `formatTdxSignature(signature)`

## Limitations

- Only ECDSA attestation key (P‑256) is supported (for now)
- Only DCAP `cert_data` type 5 is supported
- QE report must be present for QE signature/binding checks

## TCB evaluation (frontend friendly)

Intel publishes TCB Info JSON for SGX and TDX. This package ships a lightweight evaluator which compares the quote's SVN values against the TCB levels you provide.

Basic usage in a browser:

```ts
import { verifyTdxBase64, evaluateTcb } from "ra-https-qvl"

// 1) Perform chain-of-trust validation
await verifyTdxBase64(quoteBase64, { date: Date.now(), crls: [] })

// 2) Fetch TCB Info JSON from your backend (you fetch & cache Intel docs server-side)
const tcbInfo = await (await fetch("/tcb/tdx/tcbInfo.json")).json()

// 3) Evaluate TCB
const { ok, matchedStatus, matchedIndex } = evaluateTcb(quoteBase64, tcbInfo, {
  atTimeMs: Date.now(),
  enforceUpToDate: true, // require UpToDate; if false, you can inspect status
})

if (!ok) throw new Error(`TCB not acceptable: ${matchedStatus}`)
```

If you need to validate Intel's signature over the TCB Info JSON, use `verifyTcbInfoSignature`. Supply the raw JSON string and the Intel signing chain you trust. In a browser, we recommend downloading and verifying server-side, then serving the verified JSON to clients.

## License

MIT (C) 2025
