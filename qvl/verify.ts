import { createPublicKey, createVerify, createHash } from "node:crypto"

import { TdxQuoteHeader, TdxQuoteBody_1_0, parseTdxQuote } from "./structs.js"

/** Convert a raw 64-byte ECDSA signature (r||s) into ASN.1 DER format */
function encodeEcdsaSignatureToDer(rawSignature: Buffer): Buffer {
  if (rawSignature.length !== 64) {
    throw new Error("Expected 64-byte raw ECDSA signature")
  }

  const r = rawSignature.subarray(0, 32)
  const s = rawSignature.subarray(32, 64)

  const encodeInteger = (buf: Buffer) => {
    let i = 0
    while (i < buf.length && buf[i] === 0x00) i++
    let v = buf.subarray(i)
    if (v.length === 0) v = Buffer.from([0])
    // If high bit is set, prepend 0x00 to indicate positive integer
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v])
    return Buffer.concat([Buffer.from([0x02, v.length]), v])
  }

  const rEncoded = encodeInteger(r)
  const sEncoded = encodeInteger(s)
  const sequenceLen = rEncoded.length + sEncoded.length
  return Buffer.concat([Buffer.from([0x30, sequenceLen]), rEncoded, sEncoded])
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

/**
 * Compute the signed region of a TDX v4 quote: header + body (excludes sig length and sig_data)
 */
export function getTdxV4SignedRegion(quoteBytes: Buffer): Buffer {
  const headerLen = (TdxQuoteHeader as any).baseSize as number
  const bodyLen = (TdxQuoteBody_1_0 as any).baseSize as number
  return quoteBytes.subarray(0, headerLen + bodyLen)
}

/**
 * Verify the ECDSA-P256 signature inside a TDX v4 quote against the embedded
 * attestation public key. This checks only the quote signature itself and does
 * not validate the certificate chain or QE report.
 */
export function verifyTdxV4Signature(quoteInput: string | Buffer): boolean {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)

  if (header.version !== 4) {
    throw new Error(`Unsupported TDX quote version: ${header.version}`)
  }

  const message = getTdxV4SignedRegion(quoteBytes)

  const rawSig = signature.ecdsa_signature
  const derSig = encodeEcdsaSignatureToDer(rawSig)

  const pub = signature.attestation_public_key
  if (pub.length !== 64) {
    throw new Error("Unexpected attestation public key length")
  }

  const x = toBase64Url(pub.subarray(0, 32))
  const y = toBase64Url(pub.subarray(32, 64))
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x,
    y,
  } as const

  const publicKey = createPublicKey({ key: jwk, format: "jwk" })

  const verifier = createVerify("sha256")
  verifier.update(message)
  verifier.end()
  return verifier.verify(publicKey, derSig)
}

/** Extract PEM certificates embedded in DCAP cert_data (type 5) */
export function extractPemCertificates(certData: Buffer): string[] {
  const text = certData.toString("utf8")
  const pemRegex = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  const matches = text.match(pemRegex)
  return matches ? matches : []
}

/** Verify qe_report_signature using PCK leaf certificate public key over qe_report */
export function verifyQeReportSignature(quoteInput: string | Buffer): boolean {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4) throw new Error("Unsupported quote version")
  if (!signature.cert_data) throw new Error("Missing cert_data in quote")

  const pems = extractPemCertificates(signature.cert_data)
  if (pems.length === 0) throw new Error("No certificates found in cert_data")

  const derSig = encodeEcdsaSignatureToDer(signature.qe_report_signature)

  for (const pem of pems) {
    try {
      const key = createPublicKey(pem)
      const verifier = createVerify("sha256")
      verifier.update(signature.qe_report)
      verifier.end()
      if (verifier.verify(key, derSig)) return true
    } catch {}
  }
  return false
}

/**
 * Verify QE binding: qe_report.report_data[0..32) == SHA256(attestation_public_key || qe_auth_data)
 */
export function verifyQeReportBinding(quoteInput: string | Buffer): boolean {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4) throw new Error("Unsupported quote version")
  if (!signature.qe_report_present) throw new Error("Missing QE report")

  const pubRaw = signature.attestation_public_key
  const pubUncompressed = Buffer.concat([Buffer.from([0x04]), pubRaw])

  // Build SPKI DER from JWK and hash that too
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: pubRaw.subarray(0, 32).toString("base64url"),
    y: pubRaw.subarray(32, 64).toString("base64url"),
  } as const
  let spki: Buffer | undefined
  try {
    spki = createPublicKey({ key: jwk, format: "jwk" })
      .export({ type: "spki", format: "der" }) as Buffer
  } catch {}

  const candidates: Buffer[] = []
  candidates.push(createHash("sha256").update(pubRaw).digest())
  candidates.push(createHash("sha256").update(pubUncompressed).digest())
  if (spki) candidates.push(createHash("sha256").update(spki).digest())
  candidates.push(
    createHash("sha256").update(pubRaw).update(signature.qe_auth_data).digest(),
  )
  candidates.push(
    createHash("sha256")
      .update(pubUncompressed)
      .update(signature.qe_auth_data)
      .digest(),
  )

  // SGX REPORT structure is 384 bytes; report_data occupies the last 64 bytes (offset 320)
  const reportData = signature.qe_report.subarray(320, 384)
  const first = reportData.subarray(0, 32)
  const second = reportData.subarray(32, 64)
  return candidates.some((c) => c.equals(first) || c.equals(second))
}
