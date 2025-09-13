import crypto from "crypto"

import { TdxQuoteHeader, TdxQuoteV4, TdxQuoteBody_1_0, parseTdxSignature } from "./structs.js"
import { ecdsaSigRawToDer, p256RawPublicKeyToSpkiDer } from "./utils.js"

/**
 * Verify only the quote-level ECDSA signature in a V4 TDX quote.
 * This does NOT validate the Intel certificate chain or collateral.
 *
 * Steps (per DCAP spec and dcap-qvl):
 * - The signed message is the first 432 bytes (header + report body)
 * - The signature is a 64-byte raw P-256 (r||s) over SHA256(message)
 * - The verifying public key is the PCK cert public key embedded in cert_data
 */
export function verifyTdxV4QuoteSignature(quote: Buffer): boolean {
  const header = new TdxQuoteHeader(quote)
  if (header.version !== 4) throw new Error("Expected TDX quote v4")

  const v4 = new TdxQuoteV4(quote)
  const sig = parseTdxSignature(v4.sig_data)

  // Compute over header + body (exact struct sizes)
  const headerSize = (TdxQuoteHeader as any).baseSize as number
  const bodySize = (TdxQuoteBody_1_0 as any).baseSize as number
  const signedRegion = quote.subarray(0, headerSize + bodySize)

  // Convert raw 64-byte signature to DER
  const derSig = ecdsaSigRawToDer(sig.ecdsa_signature)

  // Build SPKI from raw (x||y) public key
  const spki = p256RawPublicKeyToSpkiDer(sig.attestation_public_key)
  const keyObj = crypto.createPublicKey({ key: spki, format: "der", type: "spki" })

  // Verify with SHA256
  const verifier = crypto.createVerify("sha256")
  verifier.update(signedRegion)
  verifier.end()
  const ok = verifier.verify(keyObj, derSig)
  return ok
}

/** Convenience base64 wrapper */
export function verifyTdxV4QuoteSignatureBase64(quoteBase64: string): boolean {
  return verifyTdxV4QuoteSignature(Buffer.from(quoteBase64, "base64"))
}

/**
 * Verify the QE report binds the `attestation_public_key` to the quote.
 * The QE report is an SGX report whose report_data should contain SHA256(pubkey).
 * This function checks the binding only; it does not verify the QE report signature chain.
 */
export function verifyTdxV4QeReportPublicKeyBinding(quote: Buffer): boolean {
  const v4 = new TdxQuoteV4(quote)
  const sig = parseTdxSignature(v4.sig_data)

  if (!sig.qe_report_present) return false

  // SGX report structure: report_data is at offset 320 (64 bytes) in 384-byte report
  const REPORT_DATA_OFFSET = 320
  const reportData = sig.qe_report.subarray(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + 64)

  const candidates: Buffer[] = []
  const raw = sig.attestation_public_key
  const with04 = Buffer.concat([Buffer.from([0x04]), raw])
  const qea = sig.qe_auth_data

  const add = (bufs: Buffer[]) => {
    const h = crypto.createHash("sha256")
    for (const b of bufs) h.update(b)
    candidates.push(h.digest())
  }

  add([raw])
  add([with04])
  add([raw, qea])
  add([with04, qea])

  return candidates.some((h) => reportData.subarray(0, 32).equals(h))
}

