# ra-https-qvl

Intel SGX and TDX quote verification utilities used by the RA‑HTTPS project. This package parses SGX v3 and TDX v4/v5 quotes, verifies Intel PCK certificate chains, checks QE signatures and bindings, and validates quote signatures. It also exposes helpers for certificate handling and low‑level parsing.

The library targets modern runtimes with WebCrypto (Node.js 22+ or browsers). It is ESM‑only.

## Install

This package lives inside the monorepo and is consumed via workspaces:

```bash
npm install
npm --workspace packages/qvl run build
```

In code:

```ts
import {
  // High-level verification
  verifyTdx, verifyTdxBase64,
  verifySgx, verifySgxBase64,

  // Parsing
  parseTdxQuote, parseTdxQuoteBase64,
  parseSgxQuote, parseSgxQuoteBase64,

  // Cert chain helpers
  verifyPCKChain, QV_X509Certificate,

  // Utilities
  extractPemCertificates, hex,
} from "ra-https-qvl"
```

## Quick start

- Verify a TDX quote (binary):

```ts
import { verifyTdx } from "ra-https-qvl"

const quote: Uint8Array = /* load from your TEE */
const ok = await verifyTdx(quote, { date: Date.now(), crls: [] })
if (!ok) throw new Error("TDX quote failed verification")
```

- Verify a TDX quote (base64):

```ts
import { verifyTdxBase64 } from "ra-https-qvl"

const quoteB64: string = /* base64 string */
await verifyTdxBase64(quoteB64, { date: Date.now(), crls: [] })
```

- Verify an SGX quote:

```ts
import { verifySgx } from "ra-https-qvl"

const quote: Uint8Array = /* SGX v3 quote */
await verifySgx(quote, { date: Date.now(), crls: [] })
```

- Parse and inspect a TDX quote:

```ts
import { parseTdxQuote, hex } from "ra-https-qvl"

const { header, body, signature } = parseTdxQuote(quote)
console.log(header.version)          // 4 or 5
console.log(hex(body.mr_td))         // MRTD (hex)
console.log(hex(body.report_data))   // Report data (hex)
console.log(signature.qe_report_present) // true/false
```

## What verification covers

Both `verifyTdx` and `verifySgx` perform the following checks:

- Certificate chain
  - Build the chain from the embedded `cert_data` (PCK chain, type 5)
  - Walk issuer/subject, verify all signatures, validate BasicConstraints
  - Check validity window at a specific verification time (`date`) or now
  - Optional: check CRL membership (see Revocation below)
  - Enforce root pinning against Intel SGX Root CA by default
- QE report signature: PCK leaf key over the 384‑byte QE report blob
- QE binding: attestation public key bound into `qe_report.report_data`
- Quote signature: attestation public key over the quote’s signed region
- Header sanity: supported TEE type (SGX or TDX) and ECDSA P‑256 keys

On success the function resolves to `true`. On failure it throws with a descriptive error (e.g. "invalid root", "invalid cert chain", "invalid qe report binding", etc.).

## API

### High‑level verification

```ts
async function verifyTdx(quote: Uint8Array, config?: VerifyConfig): Promise<true>
async function verifyTdxBase64(quoteB64: string, config?: VerifyConfig): Promise<true>
async function verifySgx(quote: Uint8Array, config?: VerifyConfig): Promise<true>
async function verifySgxBase64(quoteB64: string, config?: VerifyConfig): Promise<true>
```

Config:

```ts
interface VerifyConfig {
  // DER-encoded CRLs; membership-only check of revoked serials
  crls: Uint8Array[]
  // Override the pinned root set (defaults to Intel SGX Root CA)
  pinnedRootCerts?: QV_X509Certificate[]
  // Milliseconds since epoch to evaluate certificate validity windows
  date?: number
  // PEM certificates to use if the quote has no embedded cert_data
  extraCertdata?: string[]
}
```

Notes:
- Pass `crls: []` if you do not need CRL checking.
- If a quote is missing `cert_data`, provide `extraCertdata` containing PEMs for `[leaf, intermediate(s), root]`.

### Low‑level verification helpers

```ts
// QE report signature and binding
async function verifyTdxQeReportSignature(quote: string | Uint8Array, extraCerts?: string[]): Promise<boolean>
async function verifyTdxQeReportBinding(quote: string | Uint8Array): Promise<boolean>
async function verifyTdxQuoteSignature(quote: string | Uint8Array): Promise<boolean>

async function verifySgxQeReportSignature(quote: string | Uint8Array, extraCerts?: string[]): Promise<boolean>
async function verifySgxQeReportBinding(quote: string | Uint8Array): Promise<boolean>
async function verifySgxQuoteSignature(quote: string | Uint8Array): Promise<boolean>
```

### Parsing

```ts
function parseTdxQuote(quote: Uint8Array): {
  header: QuoteHeaderType
  body: TdxQuoteBody10Type | TdxQuoteBody15Type
  signature: TdxSignature
}
function parseTdxQuoteBase64(quoteB64: string): ReturnType<typeof parseTdxQuote>

function parseSgxQuote(quote: Uint8Array): {
  header: QuoteHeaderType
  body: SgxReportBodyType
  signature: SgxSignature
}
function parseSgxQuoteBase64(quoteB64: string): ReturnType<typeof parseSgxQuote>

// Signed regions used by quote signature verification
function getTdx10SignedRegion(quote: Uint8Array): Uint8Array
function getTdx15SignedRegion(quote: Uint8Array): Uint8Array
function getSgxSignedRegion(quote: Uint8Array): Uint8Array
```

Type guards:

```ts
type TdxQuote = ReturnType<typeof parseTdxQuote>
type SgxQuote = ReturnType<typeof parseSgxQuote>
function isTdxQuote(q: SgxQuote | TdxQuote): q is TdxQuote
function isSgxQuote(q: SgxQuote | TdxQuote): q is SgxQuote
```

### Certificate utilities

```ts
// Build and validate a PCK chain (no pinning)
async function verifyPCKChain(
  certData: string[],
  verifyAtTimeMs: number | null,
  crls?: Uint8Array[],
): Promise<{ status: "valid" | "invalid" | "expired" | "revoked"; root: QV_X509Certificate | null; chain: QV_X509Certificate[] }>

class QV_X509Certificate {
  constructor(pem: string)
  get subject(): string
  get issuer(): string
  get serialNumber(): string // uppercase hex
  get notBefore(): Date
  get notAfter(): Date
  get publicKey(): { rawData: ArrayBuffer }
  verify(issuerCert: QV_X509Certificate): Promise<boolean>
  getExtension<T>(type: new (...args: any[]) => T): T | null // supports BasicConstraints
}

class BasicConstraintsExtension { ca: boolean; pathLength?: number }

// Helpers
function extractPemCertificates(certData: Uint8Array): string[]
function computeCertSha256Hex(cert: QV_X509Certificate): Promise<string>
function normalizeSerialHex(input: string): string
function parseCrlRevokedSerials(der: Uint8Array): string[]
```

Root pinning:

```ts
import { DEFAULT_PINNED_ROOT_CERTS } from "ra-https-qvl"
// Defaults to Intel SGX Root CA; you can override via VerifyConfig.pinnedRootCerts
```

### Formatting helpers

```ts
function formatTDXHeader(header: QuoteHeaderType): object
function formatTDXQuoteBodyV4(body: TdxQuoteBody10Type | TdxQuoteBody15Type): object
function formatTdxSignature(sig: TdxSignature): object
```

### QE Identity (optional)

Verify that the embedded QE report matches an expected QE identity JSON (time window, attributes mask, MRSIGNER, optional ISVPRODID and ISVSVN):

```ts
import { verifyQeIdentity } from "ra-https-qvl"

const ok = verifyQeIdentity(quoteBytesOrBase64, qeIdentityJson, Date.now())
```

`qeIdentityJson` should match Intel’s QE identity schema (fields: `enclaveIdentity.{issueDate,nextUpdate,attributes,attributesMask,mrsigner,isvprodid?,tcbLevels[]}` as used by the function).

### Additional utilities

```ts
function hex(bytes: Uint8Array): string
function reverseHexBytes(hexString: string): string
function toBase64Url(bytes: Uint8Array): string
function encodeEcdsaSignatureToDer(rawSig: Uint8Array): Uint8Array
function concatBytes(chunks: Uint8Array[]): Uint8Array
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean
```

## Revocation

Pass CRLs as DER buffers via `crls`. The library parses revoked serial numbers and treats any match in the chain as revoked. It does not validate CRL signatures or extensions; if you need full PKIX revocation validation, perform it externally and pass `crls: []` here.

## Missing embedded certificates

Some sample quotes omit `cert_data`. You can provide a fallback via `extraCertdata: string[]` with PEMs for `[leaf, intermediate(s), root]`:

```ts
import { extractPemCertificates, verifyTdx, QV_X509Certificate } from "ra-https-qvl"

const root = extractPemCertificates(fs.readFileSync("trustedRootCaCert.pem"))
const chain = extractPemCertificates(fs.readFileSync("pckSignChain.pem"))
const leaf  = extractPemCertificates(fs.readFileSync("pckCert.pem"))

await verifyTdx(quote, {
  pinnedRootCerts: [new QV_X509Certificate(root[0])],
  extraCertdata: [...root, ...chain, ...leaf],
  date: Date.now(),
  crls: [],
})
```

## Environment

- ESM only (`"type": "module"`)
- Requires WebCrypto (`globalThis.crypto.subtle`), available in Node.js 22+ and modern browsers

## Security considerations

- Pin expected measurements at the application layer (e.g., compare MRTD/REPORT_DATA or implement a custom matcher in your calling code)
- Keep `pinnedRootCerts` up to date if Intel rotates root CAs
- Use unique nonces and track freshness to prevent replay
- Prefer passing a fixed `date` for deterministic verification in tests

## Additional docs

- `src/ATTESTATION.md`: Azure TDX setup and evidence collection
- `src/ATTESTATION-GCP.md`: GCP TDX setup and evidence collection
- `src/VERIFICATION.md`: Walkthrough of quote verification steps

## License

MIT © 2025