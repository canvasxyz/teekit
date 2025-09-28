## Fetching up-to-date TCB (SGX and TDX)

This guide shows how to fetch Intel TCB Info JSON from the Intel PCS (Provisioning Certification Service), verify its signature, cache it until `nextUpdate`, and surface it to the frontend for TCB evaluation with this repo’s `ra-https-qvl` package.

### What you’ll fetch

- SGX TCB Info JSON for a given FMSPC
- TDX TCB Info JSON for a given FMSPC
- Corresponding signature and issuer chain from HTTP response headers

You will need an Intel PCS API subscription key.

### Prerequisites

- An Intel PCS API key stored as an environment variable:

```bash
export INTEL_PCS_KEY="<your Ocp-Apim-Subscription-Key>"
```

- The platform’s FMSPC (Family‑Model‑Stepping and Platform Configuration), a 6‑byte hex string (12 hex chars). The FMSPC is embedded in the platform’s PCK certificate.

You can extract FMSPC from the PCK leaf certificate (from the quote’s `cert_data`) using OpenSSL (text output will include a field named FMSPC):

```bash
openssl x509 -in pck_leaf.pem -text -noout | grep -i -A5 FMSPC
```

Or derive it via your DCAP tooling/library on the backend. Use uppercase hex without `0x` when calling PCS.

### Step 1 — Fetch SGX TCB Info (by FMSPC)

```bash
FMSPC="00707F000000"   # example; replace with your platform’s FMSPC
curl -sS \
  -D sgx.headers.txt \
  -H "Ocp-Apim-Subscription-Key: ${INTEL_PCS_KEY}" \
  -H "Accept: application/json" \
  "https://api.trustedservices.intel.com/sgx/certification/v4/tcb?fmspc=${FMSPC}" \
  -o sgx.tcbInfo.json
```

Important response headers to capture:
- `SGX-TCB-Info-Signature`: base64 signature over the response body
- `SGX-TCB-Info-Issuer-Chain`: PEM chain used to verify the signature (leaf first)

### Step 2 — Fetch TDX TCB Info (by FMSPC)

```bash
FMSPC_TDX="ED742AF8ADF5"  # example; replace with your TDX platform FMSPC
curl -sS \
  -D tdx.headers.txt \
  -H "Ocp-Apim-Subscription-Key: ${INTEL_PCS_KEY}" \
  -H "Accept: application/json" \
  "https://api.trustedservices.intel.com/tdx/certification/v1/tcb?fmspc=${FMSPC_TDX}" \
  -o tdx.tcbInfo.json
```

Common response headers:
- `TDX-TCB-Info-Signature`: base64 signature over the response body
- `TDX-TCB-Info-Issuer-Chain`: PEM chain used to verify the signature (leaf first)

Note: TDX API version may change over time; if `v1` is unavailable in your region/tenant, consult Intel PCS docs and switch to the current version.

### Step 3 — Verify the TCB Info signatures (server‑side)

Use `ra-https-qvl` to verify the JSON body against the signature and issuer chain from headers. Example (Node/TS):

```ts
import fs from "node:fs/promises"
import { verifyTcbInfoSignature } from "ra-https-qvl"

function parseIssuerChainFromHeadersFile(h: string): string[] {
  // Extract the issuer chain header value and split into PEMs
  // The header typically contains concatenated PEM blocks
  const m = h.match(/^(?:SGX|TDX)-TCB-Info-Issuer-Chain:\s*([^\n]+)$/im)
  if (!m) return []
  const chain = decodeURIComponent(m[1]) // sometimes URL-encoded; safe to decode
  const parts = chain
    .split("-----END CERTIFICATE-----")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.endsWith("-----END CERTIFICATE-----") ? p : p + "\n-----END CERTIFICATE-----\n"))
  return parts
}

async function verifyOne(jsonPath: string, headerPath: string) {
  const [jsonText, headersText] = await Promise.all([
    fs.readFile(jsonPath, "utf8"),
    fs.readFile(headerPath, "utf8"),
  ])

  const sigMatch = headersText.match(/^(?:SGX|TDX)-TCB-Info-Signature:\s*([^\n]+)$/im)
  if (!sigMatch) throw new Error("Missing TCB-Info-Signature header")
  const signature = sigMatch[1].trim()
  const signingChain = parseIssuerChainFromHeadersFile(headersText)

  const ok = await verifyTcbInfoSignature({
    tcbInfoText: jsonText,
    signature,
    signingChain,
    hash: "SHA-256",
  })
  if (!ok) throw new Error("TCB Info signature verification failed")
}
```

Why server‑side: validating Intel’s signature and caching reduces client complexity and avoids exposing PCS keys.

### Step 4 — Cache and refresh policy

- Read `tcbInfo.issueDate` and `tcbInfo.nextUpdate` from the verified JSON
- Cache the JSON until `nextUpdate` (serve it to clients)
- Refresh proactively (e.g., daily) and on cache miss

### Step 5 — Surface to frontend and evaluate

Serve the verified JSON at a stable URL (e.g., `/tcb/sgx/<fmspc>.json`, `/tcb/tdx/<fmspc>.json`). In the browser:

```ts
import { evaluateTcb } from "ra-https-qvl"

const tcbInfo = await (await fetch("/tcb/tdx/<fmspc>.json")).json()
const res = evaluateTcb(quoteBase64, tcbInfo, {
  atTimeMs: Date.now(),
  enforceUpToDate: true,
})
if (!res.ok) {
  // res.matchedStatus gives the policy-relevant status (e.g., OutOfDate, Revoked)
}
```

### Optional — Fetch CRLs and QE Identity

- PCK CRLs (SGX): `https://api.trustedservices.intel.com/sgx/certification/v4/pckcrl?ca=processor` (and `platform`)
- QE Identity (SGX): `https://api.trustedservices.intel.com/sgx/certification/v4/qe/identity`

These can further harden chain validation and QE checks; `ra-https-qvl` supports CRL lists and QE Identity matching.

### One‑liners you can adapt

```bash
# SGX TCB Info
curl -sS -D sgx.headers.txt \
  -H "Ocp-Apim-Subscription-Key: ${INTEL_PCS_KEY}" \
  -H "Accept: application/json" \
  "https://api.trustedservices.intel.com/sgx/certification/v4/tcb?fmspc=${FMSPC}" \
  -o sgx.tcbInfo.json

# TDX TCB Info (version may vary; consult Intel docs)
curl -sS -D tdx.headers.txt \
  -H "Ocp-Apim-Subscription-Key: ${INTEL_PCS_KEY}" \
  -H "Accept: application/json" \
  "https://api.trustedservices.intel.com/tdx/certification/v1/tcb?fmspc=${FMSPC_TDX}" \
  -o tdx.tcbInfo.json
```

Keep your PCS key secret and never ship it to the browser.

