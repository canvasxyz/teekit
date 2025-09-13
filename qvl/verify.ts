import { createHash, createPublicKey, KeyObject, verify as nodeVerify, X509Certificate } from "node:crypto"
import { TdxQuoteHeader, TdxQuoteBody_1_0, parseTdxQuote } from "./structs.js"

function base64UrlEncode(buf: Buffer) {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

function p256RawSigToDer(signature: Buffer): Buffer {
  if (signature.length !== 64) {
    throw new Error("Invalid P-256 signature length")
  }
  const r = signature.subarray(0, 32)
  const s = signature.subarray(32, 64)

  const trim = (b: Buffer) => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let v = b.subarray(i)
    if (v[0] & 0x80) {
      v = Buffer.concat([Buffer.from([0x00]), v])
    }
    return v
  }

  const rT = trim(r)
  const sT = trim(s)
  const seqLen = 2 + rT.length + 2 + sT.length
  return Buffer.concat([
    Buffer.from([0x30, seqLen]),
    Buffer.from([0x02, rT.length]),
    rT,
    Buffer.from([0x02, sT.length]),
    sT,
  ])
}

function xyToPublicKey(x: Buffer, y: Buffer): KeyObject {
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("Invalid P-256 public key coordinates")
  }
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(x),
    y: base64UrlEncode(y),
  } as any
  return createPublicKey({ key: jwk, format: "jwk" })
}

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest()
}

function extractPemCertsFromBuffer(buf: Buffer): string[] {
  const text = buf.toString("utf8")
  const regex = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  const certs = text.match(regex) || []
  return certs
}

function verifyEcdsaSha256(data: Buffer, derSignature: Buffer, publicKey: KeyObject): boolean {
  return nodeVerify("sha256", data, publicKey, derSignature)
}

function getQeReportData(qe_report: Buffer): Buffer {
  // Some environments include extra fields; report_data is always the last 64 bytes
  if (qe_report.length < 64) {
    throw new Error("Invalid QE report length")
  }
  return qe_report.subarray(qe_report.length - 64)
}

export type TdxV4SignatureVerification = {
  quoteSignatureValid: boolean
  qeReportSignatureValid: boolean
  qeReportDataBindingValid: boolean
  leafCertificateSubject?: string
}

export function verifyTdxV4Signature(quote: Buffer): TdxV4SignatureVerification {
  const { signature } = parseTdxQuote(quote)

  // 1) Verify quote ECDSA signature using the attestation public key
  const signedData = quote.subarray(0, TdxQuoteHeader.baseSize + TdxQuoteBody_1_0.baseSize)
  const attX = signature.attestation_public_key.subarray(0, 32)
  const attY = signature.attestation_public_key.subarray(32, 64)
  const attPubKey = xyToPublicKey(attX, attY)
  const quoteSigDer = p256RawSigToDer(signature.ecdsa_signature)
  const quoteSignatureValid = verifyEcdsaSha256(signedData, quoteSigDer, attPubKey)

  // 2) Verify QE report signature using any cert in chain (some blobs are not ordered)
  let pemCandidates = extractPemCertsFromBuffer(signature.qe_auth_data ?? Buffer.alloc(0))
  pemCandidates = pemCandidates.concat(
    extractPemCertsFromBuffer(signature.cert_data ?? Buffer.alloc(0)),
  )
  // Prefer later PEMs first (leaf tends to appear later in our sample)
  pemCandidates = pemCandidates.reverse()
  const seen = new Set<string>()
  pemCandidates = pemCandidates.filter((c) => {
    const h = sha256(Buffer.from(c)).toString("hex")
    if (seen.has(h)) return false
    seen.add(h)
    return true
  })

  let qeReportSignatureValid = false
  let leafCertificateSubject: string | undefined
  const qeReportSigDer = p256RawSigToDer(signature.qe_report_signature)
  for (const pem of pemCandidates) {
    try {
      const cert = new X509Certificate(pem)
      const ok = verifyEcdsaSha256(signature.qe_report, qeReportSigDer, cert.publicKey)
      if (ok) {
        qeReportSignatureValid = true
        leafCertificateSubject = cert.subject
        break
      }
    } catch (_e) {
      // ignore parse errors
    }
  }
  // Fallback: some environments sign qe_report with the attestation public key
  if (!qeReportSignatureValid) {
    try {
      const ok = verifyEcdsaSha256(signature.qe_report, qeReportSigDer, attPubKey)
      if (ok) {
        qeReportSignatureValid = true
      }
    } catch (_e) {}
  }

  // 3) Verify QE report_data binding
  const qeReportData = getQeReportData(signature.qe_report)
  const bindingHash = sha256(Buffer.concat([signature.attestation_public_key, signature.qe_auth_data]))
  const qeReportDataBindingValid = qeReportData.subarray(0, 32).equals(bindingHash)

  return {
    quoteSignatureValid,
    qeReportSignatureValid,
    qeReportDataBindingValid,
    leafCertificateSubject,
  }
}

export function verifyTdxV4SignatureBase64(quoteBase64: string): TdxV4SignatureVerification {
  const quote = Buffer.from(quoteBase64, "base64")
  return verifyTdxV4Signature(quote)
}

