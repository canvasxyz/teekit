import test from "ava"
import fs from "node:fs"
import { base64 as scureBase64 } from "@scure/base"

import {
  parseTdxQuoteBase64,
  getX25519ExpectedReportData,
  isX25519Bound,
  hex,
} from "ra-https-qvl"

function getGcpSample() {
  const data = JSON.parse(
    fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"),
  )
  return data as {
    tdx: {
      quote: string
      verifier_nonce: { val: string; iat: string }
    }
  }
}

test.serial(
  "X25519 expected report_data equals SHA-512(nonce||iat||key) using GCP sample",
  async (t) => {
    const sample = getGcpSample()
    const nonce = scureBase64.decode(sample.tdx.verifier_nonce.val)
    const iat = scureBase64.decode(sample.tdx.verifier_nonce.iat)

    // Deterministic dummy X25519 public key (32 bytes): 0x00,0x01,...,0x1f
    const x25519 = new Uint8Array(32)
    for (let i = 0; i < x25519.length; i++) x25519[i] = i & 0xff

    const expected = await getX25519ExpectedReportData(nonce, iat, x25519)

    // Independently compute the same digest to validate correctness
    const concatenated = new Uint8Array(nonce.length + iat.length + x25519.length)
    concatenated.set(nonce, 0)
    concatenated.set(iat, nonce.length)
    concatenated.set(x25519, nonce.length + iat.length)
    const manual = new Uint8Array(
      await crypto.subtle.digest("SHA-512", concatenated),
    )

    t.is(expected.length, 64)
    t.deepEqual(expected, manual)
  },
)

test.serial(
  "isX25519Bound returns false for GCP sample with dummy key",
  async (t) => {
    const sample = getGcpSample()
    const nonce = scureBase64.decode(sample.tdx.verifier_nonce.val)
    const iat = scureBase64.decode(sample.tdx.verifier_nonce.iat)
    const quoteB64 = sample.tdx.quote
    const quote = parseTdxQuoteBase64(quoteB64)

    // Deterministic dummy X25519 public key (32 bytes)
    const x25519 = new Uint8Array(32)
    for (let i = 0; i < x25519.length; i++) x25519[i] = i & 0xff

    const bound = await isX25519Bound(quote, nonce, iat, x25519)
    t.false(bound)
  },
)

