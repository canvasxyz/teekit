// @ts-nocheck
import {
  getSgxSignedRegion,
  getTdx10SignedRegion,
  parseTdxQuote,
  parseSgxQuote,
  extractPemCertificates,
  verifyPCKChain,
  computeCertSha256Hex,
  QV_X509Certificate,
} from "../qvl/index.js"

export function pemToDer(pem: string): Buffer {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "")
  return Buffer.from(b64, "base64")
}

export function derToPem(der: Buffer): string {
  const b64 = der.toString("base64")
  const lines = b64.match(/.{1,64}/g) || []
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`
}

export function tamperPemSignature(pem: string): string {
  const der = Buffer.from(pemToDer(pem))
  der[der.length - 1] ^= 0x01
  return derToPem(der)
}

export function buildCRLWithSerials(serialsUpperHex: string[]): Buffer {
  const encodeLen = (len: number) => {
    if (len < 0x80) return Buffer.from([len])
    const bytes: number[] = []
    let v = len
    while (v > 0) {
      bytes.unshift(v & 0xff)
      v >>= 8
    }
    return Buffer.from([0x80 | bytes.length, ...bytes])
  }
  const tlv = (tag: number, value: Buffer) =>
    Buffer.concat([Buffer.from([tag]), encodeLen(value.length), value])

  const encodeIntegerHex = (hex: string) => {
    let v = Buffer.from(hex.replace(/[^0-9A-F]/g, ""), "hex")
    if (v.length === 0) v = Buffer.from([0])
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v])
    return tlv(0x02, v)
  }

  const version = tlv(0x02, Buffer.from([0x01]))
  const sigAlg = tlv(0x30, Buffer.alloc(0))
  const issuer = tlv(0x30, Buffer.alloc(0))
  const thisUpdate = tlv(0x17, Buffer.from("250101000000Z"))

  const revokedEntries = serialsUpperHex.map((s) =>
    tlv(0x30, encodeIntegerHex(s)),
  )
  const revokedSeq = tlv(0x30, Buffer.concat(revokedEntries))

  const tbs = tlv(
    0x30,
    Buffer.concat([version, sigAlg, issuer, thisUpdate, revokedSeq]),
  )
  const outer = tlv(0x30, tbs)
  return outer
}

export function rebuildQuoteWithCertData(
  baseQuote: Buffer,
  certData: Buffer,
): Buffer {
  const signedLen = getTdx10SignedRegion(baseQuote).length
  const sigLen = baseQuote.readUInt32LE(signedLen)
  const sigStart = signedLen + 4
  const sigData = baseQuote.subarray(sigStart, sigStart + sigLen)

  const FIXED_LEN = 64 + 64 + 6 + 384 + 64 + 2 // ECDSA fixed portion
  const qeAuthLen = sigData.readUInt16LE(64 + 64 + 6 + 384 + 64)
  const fixedPlusAuth = sigData.subarray(0, FIXED_LEN + qeAuthLen)

  const tail = Buffer.alloc(2 + 4)
  tail.writeUInt16LE(5, 0) // cert_data_type = 5 (PCK)
  tail.writeUInt32LE(certData.length, 2)

  const newSigData = Buffer.concat([fixedPlusAuth, tail, certData])
  const newSigLen = Buffer.alloc(4)
  newSigLen.writeUInt32LE(newSigData.length, 0)

  const prefix = baseQuote.subarray(0, signedLen)
  return Buffer.concat([prefix, newSigLen, newSigData])
}

export function rebuildSgxQuoteWithCertData(
  baseQuote: Buffer,
  certData: Buffer,
  certDataType: number = 5,
): Buffer {
  const signedLen = getSgxSignedRegion(baseQuote).length
  const sigLen = baseQuote.readUInt32LE(signedLen)
  const sigStart = signedLen + 4
  const sigData = baseQuote.subarray(sigStart, sigStart + sigLen)

  // SGX ECDSA fixed portion: 64 (sig) + 64 (att_pub) + 384 (qe_report) + 64 (qe_report_sig) + 2 (qe_auth_len)
  const FIXED_LEN = 64 + 64 + 384 + 64 + 2
  const qeAuthLen = sigData.readUInt16LE(64 + 64 + 384 + 64)
  const fixedPlusAuth = sigData.subarray(0, FIXED_LEN + qeAuthLen)

  const tail = Buffer.alloc(2 + 4)
  tail.writeUInt16LE(certDataType, 0)
  tail.writeUInt32LE(certData.length, 2)

  const newSigData = Buffer.concat([fixedPlusAuth, tail, certData])
  const newSigLen = Buffer.alloc(4)
  newSigLen.writeUInt32LE(newSigData.length, 0)

  const prefix = baseQuote.subarray(0, signedLen)
  return Buffer.concat([prefix, newSigLen, newSigData])
}

export async function getCertPemsFromTdxQuoteBuffer(): Promise<{
  leaf: string
  intermediate: string
  root: string
  all: string[]
}> {
  throw new Error(
    "getCertPemsFromTdxQuoteBuffer requires a quote Buffer argument",
  )
}

export async function getCertPemsFromTdxQuoteBufferImpl(
  quote: Buffer,
): Promise<{
  leaf: string
  intermediate: string
  root: string
  all: string[]
}> {
  const { signature } = parseTdxQuote(quote)
  const pems = extractPemCertificates(signature.cert_data)
  const { chain } = await verifyPCKChain(pems, null)
  const hashToPem = new Map<string, string>()
  for (const pem of pems) {
    const h = await computeCertSha256Hex(new QV_X509Certificate(pem))
    hashToPem.set(h, pem)
  }
  const leafPem = hashToPem.get(await computeCertSha256Hex(chain[0]))!
  const intermediatePem = hashToPem.get(await computeCertSha256Hex(chain[1]))!
  const rootPem = hashToPem.get(await computeCertSha256Hex(chain[2]))!
  return {
    leaf: leafPem,
    intermediate: intermediatePem,
    root: rootPem,
    all: pems,
  }
}

export async function getCertPemsFromSgxQuoteBufferImpl(
  quote: Buffer,
): Promise<{
  leaf: string
  intermediate: string
  root: string
  all: string[]
}> {
  const { signature } = parseSgxQuote(quote)
  const pems = extractPemCertificates(signature.cert_data)
  const { chain } = await verifyPCKChain(pems, null)
  const hashToPem = new Map<string, string>()
  for (const pem of pems) {
    const h = await computeCertSha256Hex(new QV_X509Certificate(pem))
    hashToPem.set(h, pem)
  }
  const leafPem = hashToPem.get(await computeCertSha256Hex(chain[0]))!
  const intermediatePem = hashToPem.get(await computeCertSha256Hex(chain[1]))!
  const rootPem = hashToPem.get(await computeCertSha256Hex(chain[2]))!
  return {
    leaf: leafPem,
    intermediate: intermediatePem,
    root: rootPem,
    all: pems,
  }
}
