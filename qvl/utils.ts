import { createHash, X509Certificate } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

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
  const text = certData.toString("utf8")
  const pemRegex =
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  const matches = text.match(pemRegex)
  return matches ? matches : []
}

/** Extract PEM certificates by scanning raw bytes for BEGIN/END delimiters. */
export function extractPemCertificatesFromBinary(buf: Buffer): string[] {
  const begin = Buffer.from("-----BEGIN CERTIFICATE-----", "ascii")
  const end = Buffer.from("-----END CERTIFICATE-----", "ascii")
  const results: string[] = []
  let offset = 0
  while (true) {
    const s = buf.indexOf(begin, offset)
    if (s === -1) break
    const e = buf.indexOf(end, s)
    if (e === -1) break
    const slice = buf.subarray(s, e + end.length)
    const pem = slice.toString("utf8")
    results.push(pem)
    offset = e + end.length
  }
  return results
}

/** Heuristically parse X.509 certs from binary that contains PEM starts but missing END delimiters. */
export function extractX509CertificatesFromPemBegins(buf: Buffer): X509Certificate[] {
  const results: X509Certificate[] = []
  const seen = new Set<string>()
  const begin = Buffer.from("-----BEGIN CERTIFICATE-----", "ascii")

  let offset = 0
  while (true) {
    const s = buf.indexOf(begin, offset)
    if (s === -1) break
    let i = s + begin.length
    // Gather subsequent base64-ish bytes
    const base64Chars = [] as number[]
    for (; i < buf.length; i++) {
      const ch = buf[i]
      const isNl = ch === 0x0a || ch === 0x0d
      const isSp = ch === 0x20 || ch === 0x09
      const isB64 =
        (ch >= 0x41 && ch <= 0x5a) || // A-Z
        (ch >= 0x61 && ch <= 0x7a) || // a-z
        (ch >= 0x30 && ch <= 0x39) || // 0-9
        ch === 0x2b || // +
        ch === 0x2f || // /
        ch === 0x3d // =
      if (isB64 || isNl || isSp) {
        if (!isSp) base64Chars.push(ch)
        continue
      }
      // stop when non-base64 byte encountered
      break
    }
    const base64Str = Buffer.from(base64Chars).toString("ascii").replace(/[\r\n]/g, "")
    try {
      const der = Buffer.from(base64Str, "base64")
      if (der.length > 0) {
        try {
          const cert = new X509Certificate(der)
          const fp = computeCertSha256Hex(cert)
          if (!seen.has(fp)) {
            results.push(cert)
            seen.add(fp)
          }
        } catch {}
      }
    } catch {}
    offset = i
  }
  return results
}

/** Compute SHA-256 of a certificate's DER bytes, lowercase hex */
export function computeCertSha256Hex(cert: X509Certificate): string {
  return createHash("sha256").update(cert.raw).digest("hex")
}

/** Load root CA PEMs from local directory. */
export function loadRootCerts(certsDirectory: string): X509Certificate[] {
  const baseDir = path.resolve(certsDirectory)
  let entries: Array<{ name: string; isFile: boolean }>
  try {
    const dirents = fs.readdirSync(baseDir, { withFileTypes: true })
    entries = dirents.map((d) => ({ name: d.name, isFile: d.isFile() }))
  } catch {
    return []
  }

  const results: X509Certificate[] = []
  for (const e of entries) {
    if (!e.isFile) continue
    const lower = e.name.toLowerCase()
    if (
      !lower.endsWith(".pem") &&
      !lower.endsWith(".crt") &&
      !lower.endsWith(".cer")
    )
      continue
    try {
      const filePath = path.join(baseDir, e.name)
      const text = fs.readFileSync(filePath, "utf8")
      const pems = extractPemCertificates(Buffer.from(text, "utf8"))
      for (const pem of pems) {
        try {
          results.push(new X509Certificate(pem))
        } catch {}
      }
    } catch {}
  }
  return results
}

/**
 * Extract all X.509 certificates present in a DCAP cert_data blob.
 * Some providers embed a PKCS#7/CMS structure encoded as base64 in plain text
 * before appending PEM certificates. This routine:
 * - extracts PEM blocks directly
 * - removes them from the text and collects remaining base64-like tokens
 * - base64-decodes those tokens and scans for DER-encoded certificates
 */
export function extractAllX509CertificatesFromCertData(
  certData: Buffer,
): X509Certificate[] {
  const results: X509Certificate[] = []
  const seen = new Set<string>()

  const text = certData.toString("utf8")
  const pemRegex = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

  // Helper to add if unique
  const addCert = (cert: X509Certificate) => {
    const fp = computeCertSha256Hex(cert)
    if (!seen.has(fp)) {
      results.push(cert)
      seen.add(fp)
    }
  }

  // 1) Parse PEM blocks directly
  const pemMatches = text.match(pemRegex) || []
  for (const pem of pemMatches) {
    try {
      addCert(new X509Certificate(pem))
    } catch {}
  }

  // 2) Many providers prepend a CMS/PKCS#7 SignedData as a long base64 string
  //    without PEM headers. Reconstruct the contiguous base64 before the first PEM.
  const firstPemIdx = text.indexOf("-----BEGIN CERTIFICATE-----")
  const beforePems = firstPemIdx >= 0 ? text.substring(0, firstPemIdx) : text
  const base64Joined = beforePems.replace(/[^A-Za-z0-9+/=]/g, "")
  try {
    const cmsDer = Buffer.from(base64Joined, "base64")
    if (cmsDer.length > 0) {
      // Scan the CMS DER blob for embedded X.509 certificate DER sequences
      const readAsn1Length = (buf: Buffer, offset: number): { len: number; headerLen: number } | null => {
        if (offset + 2 > buf.length) return null
        const lenByte = buf[offset + 1]
        if (lenByte < 0x80) return { len: lenByte, headerLen: 2 }
        const numLenBytes = lenByte & 0x7f
        if (numLenBytes === 0 || numLenBytes > 3) return null
        if (offset + 2 + numLenBytes > buf.length) return null
        let len = 0
        for (let j = 0; j < numLenBytes; j++) {
          len = (len << 8) | buf[offset + 2 + j]
        }
        return { len, headerLen: 2 + numLenBytes }
      }
      for (let i = 0; i + 2 <= cmsDer.length; i++) {
        if (cmsDer[i] !== 0x30) continue // Only consider SEQUENCE
        const l = readAsn1Length(cmsDer, i)
        if (!l) continue
        const total = l.headerLen + l.len
        if (total <= 0 || i + total > cmsDer.length) continue
        const candidate = cmsDer.subarray(i, i + total)
        try {
          addCert(new X509Certificate(candidate))
          i += total - 1
        } catch {}
      }
    }
  } catch {}

  return results
}

/** Extract X.509 certificates from an arbitrary binary buffer by:
 * - parsing PEM blocks
 * - scanning for DER SEQUENCE elements that parse as X.509 certs
 */
export function extractX509CertificatesFromBuffer(buf: Buffer): X509Certificate[] {
  const results: X509Certificate[] = []
  const seen = new Set<string>()

  const addCert = (c: X509Certificate) => {
    const fp = computeCertSha256Hex(c)
    if (!seen.has(fp)) {
      results.push(c)
      seen.add(fp)
    }
  }

  // Try PEM blocks
  try {
    const text = buf.toString("utf8")
    const pemRegex = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
    const pemMatches = text.match(pemRegex) || []
    for (const pem of pemMatches) {
      try { addCert(new X509Certificate(pem)) } catch {}
    }
  } catch {}

  // Scan raw DER sequences
  const readAsn1Length = (bytes: Buffer, offset: number): { len: number; headerLen: number } | null => {
    if (offset + 2 > bytes.length) return null
    const lenByte = bytes[offset + 1]
    if (lenByte < 0x80) return { len: lenByte, headerLen: 2 }
    const numLenBytes = lenByte & 0x7f
    if (numLenBytes === 0 || numLenBytes > 4) return null
    if (offset + 2 + numLenBytes > bytes.length) return null
    let len = 0
    for (let j = 0; j < numLenBytes; j++) len = (len << 8) | bytes[offset + 2 + j]
    return { len, headerLen: 2 + numLenBytes }
  }

  for (let i = 0; i + 2 <= buf.length; i++) {
    if (buf[i] !== 0x30) continue
    const l = readAsn1Length(buf, i)
    if (!l) continue
    const total = l.headerLen + l.len
    if (total <= 0 || i + total > buf.length) continue
    const candidate = buf.subarray(i, i + total)
    try {
      addCert(new X509Certificate(candidate))
      i += total - 1
    } catch {}
  }

  return results
}
