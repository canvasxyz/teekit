import { createPublicKey, verify as verifySignature } from "node:crypto"
import { TdxQuoteBody_1_0, TdxQuoteHeader, parseTdxQuote } from "./structs.js"

function toBase64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

/**
 * Verify the ECDSA-P256 signature inside a V4 TDX quote.
 *
 * This verifies only the quote signature over (header || body) using the
 * embedded ECDSA attestation public key, following Intel DCAP semantics.
 * It does not verify the QE report or certificate chain.
 */
export function verifyTdxV4QuoteSignature(quote: string | Buffer): boolean {
  const quoteBytes = Buffer.isBuffer(quote)
    ? quote
    : Buffer.from(quote, "base64")

  // Signed region is the header concatenated with the body for V4 TDX quotes
  const signedRegionLength = TdxQuoteHeader.baseSize + TdxQuoteBody_1_0.baseSize
  const signedRegion = quoteBytes.slice(0, signedRegionLength)

  const parsed = parseTdxQuote(quoteBytes)
  const signature = parsed.signature.ecdsa_signature
  const attestationPublicKey = parsed.signature.attestation_public_key

  if (attestationPublicKey.length !== 64 || signature.length !== 64) {
    return false
  }

  const x = attestationPublicKey.subarray(0, 32)
  const y = attestationPublicKey.subarray(32, 64)

  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(x),
    y: toBase64Url(y),
    ext: true,
  }

  const keyObject = createPublicKey({ key: jwk as any, format: "jwk" })

  // Quote signature uses IEEE-P1363 encoding (r||s)
  const ok = verifySignature(
    "sha256",
    signedRegion,
    { key: keyObject, dsaEncoding: "ieee-p1363" },
    signature,
  )

  return ok
}

