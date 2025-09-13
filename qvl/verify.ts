import crypto from "node:crypto"
import {
  TdxQuoteHeader,
  TdxQuoteBody_1_0,
  parseTdxSignature,
} from "./structs.js"

/**
 * Build a DER-encoded SubjectPublicKeyInfo for a P-256 public key from raw X||Y (64 bytes)
 */
function buildSpkiDerForP256PublicKey(rawXy: Buffer): Buffer {
  if (rawXy.length !== 64) {
    throw new Error("Expected 64-byte uncompressed XY public key")
  }

  const uncompressedPoint = Buffer.concat([Buffer.from([0x04]), rawXy])

  // AlgorithmIdentifier: SEQUENCE(ecPublicKey OID, prime256v1 OID)
  // ecPublicKey: 1.2.840.10045.2.1 -> 06 07 2A 86 48 CE 3D 02 01
  // prime256v1: 1.2.840.10045.3.1.7 -> 06 08 2A 86 48 CE 3D 03 01 07
  const algorithmIdentifier = Buffer.from([
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  ])

  // BIT STRING: 0 unused bits + uncompressed point (0x04 || X || Y)
  const bitStringHeader = Buffer.from([0x03, 0x42, 0x00])
  const subjectPublicKey = Buffer.concat([bitStringHeader, uncompressedPoint])

  // SubjectPublicKeyInfo ::= SEQUENCE { algorithm AlgorithmIdentifier, subjectPublicKey BIT STRING }
  const inner = Buffer.concat([algorithmIdentifier, subjectPublicKey])

  const spki = Buffer.concat([Buffer.from([0x30, inner.length]), inner])
  return spki
}

function spkiDerToPem(spkiDer: Buffer): string {
  const b64 = spkiDer.toString("base64")
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64))
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`
}

/**
 * Verify the ECDSA-P256 signature included in a TDX v4 quote over the header+body
 * using the embedded attestation public key.
 *
 * Returns true if the signature is valid, false otherwise.
 */
export function verifyTdxV4QuoteSignature(quoteData: Buffer): boolean {
  // Parse header and body sizes so we know what was signed
  const header = new TdxQuoteHeader(quoteData)
  // The v4 layout reuses the v4 struct to get body length (fixed-size for 1.0 body)
  const bodyStruct = new TdxQuoteBody_1_0(quoteData.slice(TdxQuoteHeader.baseSize))
  // Signed portion is header + body
  const signedEndOffset = TdxQuoteHeader.baseSize + TdxQuoteBody_1_0.baseSize
  const signedBytes = quoteData.slice(0, signedEndOffset)

  // Signature data follows a 4-byte sig_data_len field after header+body
  const sigDataLenOffset = signedEndOffset
  const sigDataLen = quoteData.readUInt32LE(sigDataLenOffset)
  const sigDataStart = sigDataLenOffset + 4
  const sigData = quoteData.slice(sigDataStart, sigDataStart + sigDataLen)

  const sig = parseTdxSignature(sigData)

  const spkiDer = buildSpkiDerForP256PublicKey(sig.attestation_public_key)
  const spkiPem = spkiDerToPem(spkiDer)

  const verifier = crypto.createVerify("sha256")
  verifier.update(signedBytes)
  verifier.end()
  try {
    // ECDSA r||s in IEEE-P1363 (64 bytes)
    const ok = verifier.verify({ key: spkiPem, dsaEncoding: "ieee-p1363" }, sig.ecdsa_signature)
    return ok
  } catch (_e) {
    return false
  }
}

export function verifyTdxV4QuoteSignatureBase64(quoteBase64: string): boolean {
  return verifyTdxV4QuoteSignature(Buffer.from(quoteBase64, "base64"))
}

