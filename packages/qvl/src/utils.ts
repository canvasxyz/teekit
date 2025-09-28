import { QV_X509Certificate } from "./x509.js"
import { base64url as scureBase64Url, hex as scureHex } from "@scure/base"
import { concatUint8Arrays, areUint8ArraysEqual } from "uint8array-extras"
import type { TdxQuote } from "./verifyTdx.js"
import type { SgxQuote } from "./verifySgx.js"

export const hex = (b: Uint8Array) => scureHex.encode(b)

export const reverseHexBytes = (h: string) => {
  const arr = scureHex.decode(h)
  Array.prototype.reverse.call(arr)
  return scureHex.encode(arr)
}

/** Convert a raw 64-byte ECDSA signature (r||s) into ASN.1 DER format */
export function encodeEcdsaSignatureToDer(
  rawSignature: Uint8Array,
): Uint8Array {
  if (rawSignature.length !== 64) {
    throw new Error("Expected 64-byte raw ECDSA signature")
  }

  const r = rawSignature.subarray(0, 32)
  const s = rawSignature.subarray(32, 64)

  const encodeInteger = (buf: Uint8Array) => {
    let i = 0
    while (i < buf.length && buf[i] === 0x00) i++
    let v = buf.subarray(i)
    if (v.length === 0) v = new Uint8Array([0])
    // If high bit is set, prepend 0x00 to indicate positive integer
    if (v[0] & 0x80) v = concatBytes([new Uint8Array([0x00]), v])
    return concatBytes([new Uint8Array([0x02, v.length]), v])
  }

  const rEncoded = encodeInteger(r)
  const sEncoded = encodeInteger(s)
  const sequenceLen = rEncoded.length + sEncoded.length
  return concatBytes([new Uint8Array([0x30, sequenceLen]), rEncoded, sEncoded])
}

export function toBase64Url(buf: Uint8Array): string {
  return scureBase64Url.encode(buf).replace(/=+$/, "")
}

/** Extract PEM certificates embedded in DCAP cert_data (type 5) */
export function extractPemCertificates(certData: Uint8Array): string[] {
  const text = new TextDecoder().decode(certData)
  const pemRegex =
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  const matches = text.match(pemRegex)
  return matches ? matches : []
}

/** Compute SHA-256 of a certificate's DER bytes, lowercase hex */
export async function computeCertSha256Hex(
  cert: QV_X509Certificate,
): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", cert.rawData.slice())
  return scureHex.encode(new Uint8Array(hashBuffer))
}

/** Normalize a certificate serial number to uppercase hex without delimiters or leading zeros */
export function normalizeSerialHex(input: string): string {
  const hexOnly = input.replace(/[^a-fA-F0-9]/g, "").toUpperCase()
  // Drop leading zeros but keep at least one digit
  return hexOnly.replace(/^0+(?=[0-9A-F])/g, "")
}

/**
 * Parse a DER-encoded X.509 CRL and return a list of revoked certificate serials (uppercase hex)
 *
 * This is a minimal DER parser that walks the CRL structure and extracts the
 * userCertificate fields from revokedCertificates. It does not validate CRL
 * signatures or extensions; it is only used to check serial membership.
 */
export function parseCrlRevokedSerials(der: Uint8Array): string[] {
  const revokedSerials: string[] = []

  const readTLV = (buf: Uint8Array, offset: number) => {
    if (offset >= buf.length) throw new Error("DER: out of bounds")
    const tag = buf[offset]
    let cursor = offset + 1
    if (cursor >= buf.length) throw new Error("DER: truncated length")
    let lenByte = buf[cursor++]
    let length = 0
    if (lenByte & 0x80) {
      const numBytes = lenByte & 0x7f
      if (numBytes === 0 || cursor + numBytes > buf.length)
        throw new Error("DER: invalid length")
      for (let i = 0; i < numBytes; i++) {
        length = (length << 8) | buf[cursor++]
      }
    } else {
      length = lenByte
    }
    const valueOffset = cursor
    const nextOffset = valueOffset + length
    if (nextOffset > buf.length) throw new Error("DER: value out of bounds")
    return { tag, length, valueOffset, nextOffset }
  }

  const TAG_SEQUENCE = 0x30
  const TAG_INTEGER = 0x02
  const TAG_UTCTIME = 0x17
  const TAG_GENERALIZEDTIME = 0x18

  try {
    // CertificateList (SEQUENCE)
    const outer = readTLV(der, 0)
    if (outer.tag !== TAG_SEQUENCE) return []

    // tbsCertList (SEQUENCE)
    const tbs = readTLV(der, outer.valueOffset)
    if (tbs.tag !== TAG_SEQUENCE) return []

    let p = tbs.valueOffset
    // Optional version (INTEGER)
    const maybeVersion = readTLV(der, p)
    if (maybeVersion.tag === TAG_INTEGER) {
      p = maybeVersion.nextOffset
    }

    // signature (SEQUENCE)
    const sigAlg = readTLV(der, p)
    if (sigAlg.tag !== TAG_SEQUENCE) return []
    p = sigAlg.nextOffset

    // issuer (SEQUENCE)
    const issuer = readTLV(der, p)
    if (issuer.tag !== TAG_SEQUENCE) return []
    p = issuer.nextOffset

    // thisUpdate (UTCTime or GeneralizedTime)
    const thisUpdate = readTLV(der, p)
    if (
      thisUpdate.tag !== TAG_UTCTIME &&
      thisUpdate.tag !== TAG_GENERALIZEDTIME
    )
      return []
    p = thisUpdate.nextOffset

    // nextUpdate (optional)
    if (p < tbs.nextOffset) {
      const maybeNext = readTLV(der, p)
      if (
        maybeNext.tag === TAG_UTCTIME ||
        maybeNext.tag === TAG_GENERALIZEDTIME
      ) {
        p = maybeNext.nextOffset
      }
    }

    // revokedCertificates (optional SEQUENCE)
    if (p < tbs.nextOffset) {
      const maybeRevoked = readTLV(der, p)
      if (maybeRevoked.tag === TAG_SEQUENCE) {
        let q = maybeRevoked.valueOffset
        while (q < maybeRevoked.nextOffset) {
          const entry = readTLV(der, q)
          if (entry.tag !== TAG_SEQUENCE) break
          let r = entry.valueOffset
          const serialTLV = readTLV(der, r)
          if (serialTLV.tag === TAG_INTEGER) {
            const serialHex = scureHex
              .encode(der.subarray(serialTLV.valueOffset, serialTLV.nextOffset))
              .toUpperCase()
              .replace(/^0+(?=[0-9A-F])/g, "")
            revokedSerials.push(serialHex)
            // Skip revocationDate and optional extensions without parsing
          }
          q = entry.nextOffset
        }
      }
    }
  } catch {
    return []
  }

  return revokedSerials
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  return concatUint8Arrays(chunks)
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return areUint8ArraysEqual(a, b)
}

/**
 * Compute the expected 64-byte report_data binding for a server X25519 public key,
 * given the verifier nonce value and issued-at timestamp from the attestation service.
 *
 * expected = SHA-512(verifier_nonce.val || verifier_nonce.iat || x25519_public_key)
 */
export async function getX25519ExpectedReportData(
  verifierNonceVal: Uint8Array,
  verifierNonceIat: Uint8Array,
  x25519PublicKey: Uint8Array,
): Promise<Uint8Array> {
  if (!verifierNonceVal || verifierNonceVal.length === 0)
    throw new Error("missing verifier_nonce.val")
  if (!verifierNonceIat || verifierNonceIat.length === 0)
    throw new Error("missing verifier_nonce.iat")
  if (!x25519PublicKey || x25519PublicKey.length === 0)
    throw new Error("missing x25519 key")

  const payload = concatBytes([
    verifierNonceVal,
    verifierNonceIat,
    x25519PublicKey,
  ])
  const expectedReport = await crypto.subtle.digest("SHA-512", payload)
  return new Uint8Array(expectedReport)
}

/**
 * Check whether an SGX or TDX quote's report_data equals the expected X25519 binding
 * derived from verifier_nonce and the server's X25519 public key.
 */
export async function isX25519Bound(
  quote: TdxQuote | SgxQuote,
  verifierNonceVal: Uint8Array,
  verifierNonceIat: Uint8Array,
  x25519PublicKey: Uint8Array,
): Promise<boolean> {
  const expected = await getX25519ExpectedReportData(
    verifierNonceVal,
    verifierNonceIat,
    x25519PublicKey,
  )
  return bytesEqual(quote.body.report_data, expected)
}
