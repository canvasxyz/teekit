import crypto from "node:crypto"
import { TdxQuoteBody_1_0, TdxQuoteHeader, parseTdxQuote } from "./structs.js"

function toBase64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

function rawEcdsaSigToDer(rawSig: Buffer): Buffer {
  if (rawSig.length !== 64) throw new Error("Invalid raw ECDSA signature length")
  const r = rawSig.subarray(0, 32)
  const s = rawSig.subarray(32)

  const encodeInt = (bn: Buffer) => {
    // Trim leading zeros
    let i = 0
    while (i < bn.length && bn[i] === 0) i++
    let v = bn.subarray(i)
    if (v.length === 0) v = Buffer.from([0])
    // If highest bit set, prepend 0x00
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v])
    return Buffer.concat([Buffer.from([0x02, v.length]), v])
  }

  const rEnc = encodeInt(r)
  const sEnc = encodeInt(s)
  const seqLen = rEnc.length + sEnc.length
  return Buffer.concat([Buffer.from([0x30, seqLen]), rEnc, sEnc])
}

function createP256PublicKeyFromXY(pubXY: Buffer) {
  if (pubXY.length !== 64) throw new Error("Invalid P-256 public key length")
  const x = pubXY.subarray(0, 32)
  const y = pubXY.subarray(32)

  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(x),
    y: toBase64Url(y),
  } as crypto.JsonWebKeyInput & { kty: "EC" }

  return crypto.createPublicKey({ key: jwk, format: "jwk" })
}

/**
 * Verify the quote-level ECDSA signature in a TDX v4 quote.
 * This checks only the signature over (header || body) using the embedded attestation_public_key.
 */
export function verifyTdxV4QuoteSignature(quoteBase64: string) {
  const quote = Buffer.from(quoteBase64, "base64")

  // Signed region is the concatenation of header and body
  const signedRegionLength = TdxQuoteHeader.baseSize + TdxQuoteBody_1_0.baseSize
  const signedRegion = quote.subarray(0, signedRegionLength)

  const { signature } = parseTdxQuote(quote)
  const publicKey = createP256PublicKeyFromXY(signature.attestation_public_key)
  const derSig = rawEcdsaSigToDer(signature.ecdsa_signature)

  const ok = crypto.verify("sha256", signedRegion, publicKey, derSig)
  return ok
}

/**
 * Verify that qe_report.report_data binds the attestation_public_key
 * Expected: report_data[0:32] == SHA256(attestation_public_key)
 */
export function verifyTdxV4AttestationKeyBinding(quoteBase64: string) {
  const { signature } = parseTdxQuote(Buffer.from(quoteBase64, "base64"))
  const pub = signature.attestation_public_key
  const qeReport = signature.qe_report
  if (qeReport.length !== 384) return false
  const reportData = qeReport.subarray(384 - 64)
  const first = reportData.subarray(0, 32)
  const second = reportData.subarray(32)

  // Candidate hashes for public key binding
  const candidatesFirst: Buffer[] = []
  // raw x||y
  candidatesFirst.push(crypto.createHash("sha256").update(pub).digest())
  // uncompressed 0x04||x||y
  candidatesFirst.push(
    crypto
      .createHash("sha256")
      .update(Buffer.concat([Buffer.from([0x04]), pub]))
      .digest(),
  )
  // DER SPKI encoding of the public key
  try {
    const spkiDer = createP256PublicKeyFromXY(pub).export({
      type: "spki",
      format: "der",
    }) as Buffer
    candidatesFirst.push(crypto.createHash("sha256").update(spkiDer).digest())
  } catch {}

  const qeAuth = signature.qe_auth_data
  const candidatesSecond: Buffer[] = []
  // If present, prefer sha256(qe_auth_data)
  candidatesSecond.push(crypto.createHash("sha256").update(qeAuth).digest())
  // Some implementations may use zeros when qe_auth_data is empty
  candidatesSecond.push(Buffer.alloc(32))
  // Or sha256(empty)
  candidatesSecond.push(crypto.createHash("sha256").update(Buffer.alloc(0)).digest())

  const firstMatches = candidatesFirst.some((c) => c.equals(first))
  const secondMatches = candidatesSecond.some((c) => c.equals(second))
  return firstMatches && secondMatches
}

