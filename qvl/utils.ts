import { Crypto } from "@peculiar/webcrypto"
import { X509Certificate, cryptoProvider } from "@peculiar/x509"

cryptoProvider.set(new Crypto())

export const hex = (b: Buffer) => b.toString("hex")

export const reverseHexBytes = (h: string) => {
  return Buffer.from(h, "hex").reverse().toString("hex")
}

/** Convert a raw 64-byte ECDSA signature (r||s) into ASN.1 DER format */
export function encodeEcdsaSignatureToDer(rawSignature: Buffer): Buffer {
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

export function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

/** Extract PEM certificates embedded in DCAP cert_data (type 5) */
export function extractPemCertificates(certData: Buffer): string[] {
  // Use 'latin1' encoding to avoid UTF-8 corruption of binary data
  // This preserves all byte values 0-255 as-is
  const text = certData.toString("latin1")
  const pemRegex =
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  const matches = text.match(pemRegex)
  return matches ? matches : []
}

/** Compute SHA-256 of a certificate's DER bytes, lowercase hex */
export async function computeCertSha256Hex(
  cert: X509Certificate,
): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", cert.rawData)
  return Buffer.from(hashBuffer).toString("hex")
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
export function parseCrlRevokedSerials(der: Buffer): string[] {
  const revokedSerials: string[] = []

  const readTLV = (buf: Buffer, offset: number) => {
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
            const serialHex = Buffer.from(
              der.subarray(serialTLV.valueOffset, serialTLV.nextOffset),
            )
              .toString("hex")
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
