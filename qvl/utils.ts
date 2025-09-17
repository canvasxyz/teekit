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

/** Normalize a certificate serial number to lowercase hex without separators or leading zeros */
export function normalizeSerialHex(input: string): string {
  const hexOnly = input.toLowerCase().replace(/[^0-9a-f]/g, "")
  const trimmed = hexOnly.replace(/^0+/, "")
  return trimmed.length === 0 ? "0" : trimmed
}

/**
 * Minimal DER decoder to walk ASN.1 structures. Supports definite-length forms.
 * Only features needed for CRL parsing are implemented (SEQUENCE, SET, INTEGER, context-specific containers).
 */
type DerNode = {
  tag: number
  constructed: boolean
  start: number
  headerLen: number
  len: number
  end: number
  value: Buffer
  children?: DerNode[]
}

function readDerLength(buf: Buffer, offset: number): { length: number; bytes: number } {
  const first = buf[offset]
  if (first < 0x80) return { length: first, bytes: 1 }
  const numBytes = first & 0x7f
  let length = 0
  for (let i = 0; i < numBytes; i++) {
    length = (length << 8) | buf[offset + 1 + i]
  }
  return { length, bytes: 1 + numBytes }
}

function decodeDerNode(buf: Buffer, offset: number): { node: DerNode; next: number } {
  const tag = buf[offset]
  const constructed = (tag & 0x20) === 0x20
  const lenInfo = readDerLength(buf, offset + 1)
  const headerLen = 1 + lenInfo.bytes
  const valueStart = offset + headerLen
  const len = lenInfo.length
  const valueEnd = valueStart + len
  const node: DerNode = {
    tag,
    constructed,
    start: offset,
    headerLen,
    len,
    end: valueEnd,
    value: buf.subarray(valueStart, valueEnd),
  }
  if (constructed) {
    const children: DerNode[] = []
    let childOffset = valueStart
    while (childOffset < valueEnd) {
      const { node: child, next } = decodeDerNode(buf, childOffset)
      children.push(child)
      childOffset = next
    }
    node.children = children
  }
  return { node, next: valueEnd }
}

function isSequence(node: DerNode): boolean {
  return (node.tag & 0x1f) === 0x10 && (node.tag & 0xc0) === 0x00
}

function isInteger(node: DerNode): boolean {
  return (node.tag & 0x1f) === 0x02 && (node.tag & 0xc0) === 0x00
}

/**
 * Heuristically find the revokedCertificates sequence within TBSCertList.
 * It is a SEQUENCE whose children are SEQUENCEs with first child INTEGER (serial number).
 */
function findRevokedCertificatesSequence(node: DerNode): DerNode | null {
  if (!node.children) return null
  for (const child of node.children) {
    if (isSequence(child) && child.children && child.children.length > 0) {
      const allChildrenAreRevokedEntries = child.children.every((entry) =>
        isSequence(entry) && !!entry.children && entry.children.length >= 1 && isInteger(entry.children[0]!)
      )
      if (allChildrenAreRevokedEntries) return child
      const deeper = findRevokedCertificatesSequence(child)
      if (deeper) return deeper
    }
  }
  return null
}

/** Parse a DER-encoded CRL and return a set of revoked certificate serial numbers (hex) */
export function parseCrlRevokedSerials(crlDer: Buffer): Set<string> {
  try {
    const { node: top } = decodeDerNode(crlDer, 0) // CertificateList
    if (!isSequence(top) || !top.children || top.children.length < 1) return new Set()
    const tbsCertList = top.children[0]!
    if (!isSequence(tbsCertList)) return new Set()
    const revokedSeq = findRevokedCertificatesSequence(tbsCertList)
    const revoked = new Set<string>()
    if (!revokedSeq || !revokedSeq.children) return revoked
    for (const revokedEntry of revokedSeq.children) {
      if (!revokedEntry.children || revokedEntry.children.length === 0) continue
      const serialNode = revokedEntry.children[0]!
      if (!isInteger(serialNode)) continue
      let serial = Buffer.from(serialNode.value)
      // INTEGER may be encoded as two's complement; strip leading 0x00 if present
      while (serial.length > 1 && serial[0] === 0x00) serial = serial.subarray(1)
      const hex = serial.toString("hex").toLowerCase().replace(/^0+/, "") || "0"
      revoked.add(hex)
    }
    return revoked
  } catch {
    return new Set()
  }
}

/** Load CRL files (.der or .crl) from a directory. Returns raw buffers. */
export function loadCrls(crlDirectory: string): Buffer[] {
  const baseDir = path.resolve(crlDirectory)
  let entries: Array<{ name: string; isFile: boolean }>
  try {
    const dirents = fs.readdirSync(baseDir, { withFileTypes: true })
    entries = dirents.map((d) => ({ name: d.name, isFile: d.isFile() }))
  } catch {
    return []
  }
  const results: Buffer[] = []
  for (const e of entries) {
    if (!e.isFile) continue
    const lower = e.name.toLowerCase()
    if (!lower.endsWith(".der") && !lower.endsWith(".crl")) continue
    try {
      const filePath = path.join(baseDir, e.name)
      const buf = fs.readFileSync(filePath)
      results.push(buf)
    } catch {}
  }
  return results
}
