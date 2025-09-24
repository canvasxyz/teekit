## ra-https-qvl — Intel SGX/TDX Quote Verification Library

Lightweight, WebCrypto-based verification for Intel SGX and TDX quotes (v4 and v5). Provides parsing helpers, full-chain validation to Intel SGX Root CA, QE report signature/binding checks, and quote signature verification. Written in TypeScript (ESM).

### Features
- **TDX v4/v5 and SGX v3** quote parsing and validation
- **Certificate chain** validation to Intel SGX Root CA (ECDSA)
- **CRL-based revocation** checks (DER CRL parsing helper included)
- **QE report signature** and **QE binding** verification
- **Quote signature** verification (ECDSA P‑256)
- Small API surface; zero native dependencies

### Requirements
- Node.js 20+ (WebCrypto `crypto.subtle` required)
- ESM environment (`"type": "module"`)

### Install
If using this package standalone (published name shown here for illustration):

```bash
npm install ra-https-qvl
```

In this monorepo, the package is consumed via workspace imports: `import { ... } from "ra-https-qvl"`.

---

## Quick Start

### Verify a TDX quote (base64)
```ts
import { verifyTdxBase64 } from "ra-https-qvl"

const ok = await verifyTdxBase64(quoteBase64, {
  date: Date.now(),     // verification time (ms)
  crls: [],             // optional: array of DER CRLs as Uint8Array
})
```

### Verify an SGX quote (bytes)
```ts
import { verifySgx } from "ra-https-qvl"

const ok = await verifySgx(quoteBytes, {
  date: Date.now(),
  crls: [],
})
```

### When cert_data is missing in the quote
Provide the leaf, intermediate, and root PEMs via `extraCertdata`:
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

---

## API

### Quote verification
- `verifyTdx(quote: Uint8Array, config?: VerifyConfig): Promise<boolean>`
- `verifyTdxBase64(quote: string, config?: VerifyConfig): Promise<boolean>`
- `verifySgx(quote: Uint8Array, config?: VerifyConfig): Promise<boolean>`
- `verifySgxBase64(quote: string, config?: VerifyConfig): Promise<boolean>`

Verification performs:
- PCK chain build and validation (leaf → intermediate → root)
- Chain validity window checks against `config.date` (or now)
- Optional CRL membership checks via `config.crls`
- Root pinning against Intel SGX Root CA by default (override via `pinnedRootCerts`)
- QE report signature verification
- QE binding check between `attestation_public_key` and QE report data
- Quote signature verification by `attestation_public_key`

Errors are thrown for invalid conditions (e.g. "invalid root", "invalid cert chain", "expired cert chain, or not yet valid", "revoked certificate in cert chain", "invalid qe report signature", "invalid qe report binding", "invalid signature over quote", "only TDX/SGX is supported", "only ECDSA att_key_type is supported", "only PCK cert_data is supported", "missing certdata", "Unsupported quote version").

### Config
```ts
export interface VerifyConfig {
  crls: Uint8Array[]                 // DER CRLs for revocation checks (optional; [] if none)
  pinnedRootCerts?: QV_X509Certificate[]
  date?: number                      // ms since epoch; defaults to now
  extraCertdata?: string[]           // PEM blocks when quote lacks embedded cert_data
}
```

Defaults: `pinnedRootCerts` pins Intel SGX Root CA. Provide your own to narrow trust.

### Parsing
- `parseTdxQuote(quote: Uint8Array)` / `parseTdxQuoteBase64(quote: string)`
- `parseSgxQuote(quote: Uint8Array)` / `parseSgxQuoteBase64(quote: string)`

These return `{ header, body, signature }` views with typed fields:
- TDX: v4 or v5 supported (TEE type 129)
- SGX: v3 supported (TEE type 0)

Signed region helpers:
- `getTdx10SignedRegion(quote: Uint8Array)`
- `getTdx15SignedRegion(quote: Uint8Array)`
- `getSgxSignedRegion(quote: Uint8Array)`

### Fine‑grained checks
If you need individual steps:
- TDX: `verifyTdxQeReportSignature`, `verifyTdxQeReportBinding`, `verifyTdxQuoteSignature`
- SGX: `verifySgxQeReportSignature`, `verifySgxQeReportBinding`, `verifySgxQuoteSignature`

### QE Identity check (optional)
Verify a QE Identity JSON (from Intel) against the QE report in the quote:
```ts
import { verifyQeIdentity } from "ra-https-qvl"

const ok = verifyQeIdentity(quoteBytesOrBase64, qeIdentityJson)
```

### X.509 helpers
- `class QV_X509Certificate` — minimal wrapper over PKIjs for verification and fields
- `BasicConstraintsExtension` — parsed `basicConstraints` view

### Utilities
- `hex(buf)`, `reverseHexBytes(hexStr)`
- `extractPemCertificates(certData: Uint8Array): string[]` — parse PEMs from quote `cert_data`
- `computeCertSha256Hex(cert: QV_X509Certificate): Promise<string>`
- `normalizeSerialHex(serial: string): string`
- `parseCrlRevokedSerials(der: Uint8Array): string[]` — enumerate revoked serials
- `encodeEcdsaSignatureToDer(raw: Uint8Array): Uint8Array`
- `toBase64Url(buf: Uint8Array): string`
- `concatBytes(chunks)`, `bytesEqual(a,b)`

### Formatters
Human‑readable JSON views for logging:
- `formatTDXHeader(header)`
- `formatTDXQuoteBodyV4(body)`
- `formatTdxSignature(signature)`

---

## TDX Example (with CRLs and pinned root)
```ts
import {
  verifyTdxBase64,
  QV_X509Certificate,
} from "ra-https-qvl"

const rootPem = "-----BEGIN CERTIFICATE-----..."
const crls: Uint8Array[] = [
  await fetch("https://.../rootCaCrl.der").then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
  await fetch("https://.../intermediateCaCrl.der").then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
]

await verifyTdxBase64(quoteBase64, {
  date: Date.now(),
  pinnedRootCerts: [new QV_X509Certificate(rootPem)],
  crls,
})
```

## SGX Example (fallback `extraCertdata`)
```ts
import { verifySgx, extractPemCertificates } from "ra-https-qvl"

// If the quote's cert_data was stripped, provide PEMs out‑of‑band
const certdata: string[] = [leafPem, intermediatePem, rootPem]

await verifySgx(quoteBytes, {
  date: Date.now(),
  extraCertdata: certdata,
  crls: [],
})
```

---

## Notes & Limitations
- Only ECDSA attestation key (P‑256) is supported
- Only DCAP `cert_data` type 5 is supported
- QE report must be present for QE signature/binding checks
- Root CA pinning defaults to Intel SGX Root CA; override for custom trust stores

## Related docs in this package
- `src/ATTESTATION.md` — environment setup and obtaining quotes
- `src/ATTESTATION-GCP.md` — GCP‑specific notes
- `src/VERIFICATION.md` — background on verification process

## License
MIT © 2025

