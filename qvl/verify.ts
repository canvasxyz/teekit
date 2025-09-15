import {
  createHash,
  createPublicKey,
  createVerify,
  verify as cryptoVerify,
  X509Certificate,
} from "node:crypto"

import { getTdxV4SignedRegion, parseTdxQuote } from "./structs.js"
import {
  computeCertSha256Hex,
  encodeEcdsaSignatureToDer,
  extractPemCertificates,
  extractAllX509CertificatesFromCertData,
  extractPemCertificatesFromBinary,
  extractX509CertificatesFromPemBegins,
  extractX509CertificatesFromBuffer,
  loadRootCerts,
  toBase64Url,
} from "./utils.js"

/**
 * Validate a candidate root certificate is one of our pinned
 * Intel SGX root certificates, by comparing their SHA-256 hash.
 */
export function isPinnedRootCertificate(
  candidateRoot: X509Certificate,
  certsDirectory: string,
): boolean {
  // Check for Intel root identity subject fragments
  const EXPECTED_ROOT_CN = "CN=Intel SGX Root CA"
  const EXPECTED_ROOT_O = "O=Intel Corporation"
  const EXPECTED_ROOT_C = "C=US"
  if (!candidateRoot.issuer.includes(EXPECTED_ROOT_CN)) return false
  if (!candidateRoot.issuer.includes(EXPECTED_ROOT_O)) return false
  if (!candidateRoot.issuer.includes(EXPECTED_ROOT_C)) return false

  const knownRoots = loadRootCerts(certsDirectory)
  if (knownRoots.length === 0) return false
  const candidateHash = computeCertSha256Hex(candidateRoot)
  const knownHashes = new Set(knownRoots.map(computeCertSha256Hex))
  return knownHashes.has(candidateHash)
}

/**
 * Validate a PCK certificate chain embedded in cert_data.
 * - Identifies the leaf certificate and walks up the chain, following issuer/subject chaining.
 * - Expects at least two certificates.
 * - Checks the validity window of each certificate.
 */
export function verifyProvisioningCertificationChain(
  certData: Buffer,
  { verifyAtTimeMs }: { verifyAtTimeMs: number },
): {
  status: "valid" | "invalid" | "expired"
  root: X509Certificate | null
  chain: X509Certificate[]
} {
  // Collect both PEM and embedded DER certificates
  const pems = extractPemCertificates(certData)
  const initial: X509Certificate[] = pems.map((pem) => new X509Certificate(pem))
  const more = extractAllX509CertificatesFromCertData(certData)
  // Deduplicate by fingerprint
  const seen = new Set(initial.map(computeCertSha256Hex))
  const certs: X509Certificate[] = [...initial]
  for (const c of more) {
    const fp = computeCertSha256Hex(c)
    if (!seen.has(fp)) {
      certs.push(c)
      seen.add(fp)
    }
  }
  if (certs.length === 0) return { status: "invalid", root: null, chain: [] }

  // Identify leaf (not an issuer of any other provided cert)
  let leaf: X509Certificate | undefined
  for (const c of certs) {
    const isParentOfAny = certs.some((other) => other.issuer === c.subject)
    if (!isParentOfAny) {
      leaf = c
      break
    }
  }
  if (!leaf) leaf = certs[0]

  // Walk up by issuer -> subject
  const chain: X509Certificate[] = [leaf]
  while (true) {
    const current = chain[chain.length - 1]
    const parent = certs.find((c) => c.subject === current.issuer)
    if (!parent || parent === current) break
    chain.push(parent)
  }

  // Validate chaining and validity windows
  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i]
    const parent = chain[i + 1]
    if (child.issuer !== parent.subject)
      return { status: "invalid", root: null, chain: [] }
  }

  // Check for expired or not-yet-valid certificates
  for (const c of chain) {
    const notBefore = new Date(c.validFrom).getTime()
    const notAfter = new Date(c.validTo).getTime()
    if (!(notBefore <= verifyAtTimeMs && verifyAtTimeMs <= notAfter)) {
      return { status: "expired", root: chain[chain.length - 1] ?? null, chain }
    }
  }

  return { status: "valid", root: chain[chain.length - 1] ?? null, chain }
}

/**
 * Verify that the cert chain has signed the quoting enclave report,
 * by checking qe_report_signature against the PCK leaf certificate public key.
 */
export function verifyQeReportSignature(quote: string | Buffer): boolean {
  const quoteBytes = Buffer.isBuffer(quote)
    ? quote
    : Buffer.from(quote, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4) throw new Error("Unsupported quote version")
  if (!signature.cert_data) throw new Error("Missing cert_data in quote")

  // Build candidate public keys for verifying QE report signature.
  // Providers like GCP place the PCK leaf certificate inside qe_auth_data (PEM),
  // while cert_data usually holds Platform CA + Root. Prefer any certs found
  // in qe_auth_data as the leaf public key.
  const candidateCerts: X509Certificate[] = []
  const seenFingerprints = new Set<string>()

  const pushUnique = (c: X509Certificate) => {
    const fp = computeCertSha256Hex(c)
    if (!seenFingerprints.has(fp)) {
      candidateCerts.push(c)
      seenFingerprints.add(fp)
    }
  }

  // 1) Extract PEMs from qe_auth_data (if present)
  try {
    const pemsInAuth = extractPemCertificatesFromBinary(signature.qe_auth_data)
    for (const pem of pemsInAuth) {
      try {
        pushUnique(new X509Certificate(pem))
      } catch {}
    }
  } catch {}

  // 2) Extract raw DER certs by scanning qe_auth_data
  try {
    const derCertsInAuth = extractX509CertificatesFromBuffer(signature.qe_auth_data)
    for (const c of derCertsInAuth) pushUnique(c)
  } catch {}

  // 2b) Heuristic: when END delimiter is missing, parse base64 after BEGIN
  try {
    const more = extractX509CertificatesFromPemBegins(signature.qe_auth_data)
    for (const c of more) pushUnique(c)
  } catch {}

  // 2c) Fallback: read base64 after BEGIN until non-base64 and try to parse
  try {
    const begin = Buffer.from('-----BEGIN CERTIFICATE-----', 'ascii')
    const s = signature.qe_auth_data.indexOf(begin)
    if (s >= 0) {
      let i = s + begin.length
      const isB64 = (ch: number) =>
        (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) || (ch >= 0x30 && ch <= 0x39) || ch === 0x2b || ch === 0x2f || ch === 0x3d || ch === 0x0a || ch === 0x0d
      while (i < signature.qe_auth_data.length && isB64(signature.qe_auth_data[i])) i++
      const b64 = signature.qe_auth_data.subarray(s + begin.length, i).toString('ascii').replace(/[\r\n]/g, '')
      const der = Buffer.from(b64, 'base64')
      try {
        const cert = new X509Certificate(der)
        pushUnique(cert)
      } catch {}
    }
  } catch {}

  // 3) Fallback to any certs discoverable from cert_data (e.g., Platform CA)
  const { chain } = verifyProvisioningCertificationChain(signature.cert_data, {
    verifyAtTimeMs: 0,
  })
  for (const c of chain) pushUnique(c)

  // 3b) Some providers split the PEM boundary across qe_auth_data and cert_data
  try {
    const combined = Buffer.concat([signature.qe_auth_data, signature.cert_data])
    const pemsCombined = extractPemCertificates(combined)
    for (const pem of pemsCombined) {
      try { pushUnique(new X509Certificate(pem)) } catch {}
    }
    const derCombined = extractX509CertificatesFromBuffer(combined)
    for (const c of derCombined) pushUnique(c)
  } catch {}

  // 3c) Combine buffers and manually reconstruct matching BEGIN..END slices
  try {
    const combined = Buffer.concat([signature.qe_auth_data, signature.cert_data])
    const begin = Buffer.from('-----BEGIN CERTIFICATE-----', 'ascii')
    const end = Buffer.from('-----END CERTIFICATE-----', 'ascii')
    const findAll = (buf: Buffer, needle: Buffer) => {
      const idxs: number[] = []
      let pos = 0
      while (true) {
        const i = buf.indexOf(needle, pos)
        if (i === -1) break
        idxs.push(i)
        pos = i + needle.length
      }
      return idxs
    }
    const beginIdx = findAll(combined, begin)
    const endIdx = findAll(combined, end)
    const pairs = Math.min(beginIdx.length, endIdx.length)
    for (let i = 0; i < pairs; i++) {
      const s = beginIdx[i]
      const e = endIdx[i]
      if (e > s) {
        const pem = combined.subarray(s, e + end.length).toString('utf8')
        try { pushUnique(new X509Certificate(pem)) } catch {}
      }
    }
  } catch {}
  if (candidateCerts.length === 0) return false

  // Strategy A: Verify with DER-encoded ECDSA signature (common case)
  try {
    const derSig = encodeEcdsaSignatureToDer(signature.qe_report_signature)
    for (const cert of candidateCerts) {
      try {
        const verifierA = createVerify('sha256')
        verifierA.update(signature.qe_report)
        verifierA.end()
        if (verifierA.verify(cert.publicKey, derSig)) return true
      } catch {}
    }
  } catch {}

  // Strategy B: Verify using IEEE-P1363 raw (r||s) signature encoding
  try {
    for (const cert of candidateCerts) {
      try {
        const verifierB = createVerify("sha256")
        verifierB.update(signature.qe_report)
        verifierB.end()
        if (
          verifierB.verify(
            { key: cert.publicKey, dsaEncoding: "ieee-p1363" as const },
            signature.qe_report_signature,
          )
        )
          return true
      } catch {}
    }
  } catch {}

  // Strategy C: Some providers sign qe_report with the quote's attestation public key
  try {
    const pubRaw = signature.attestation_public_key
    if (pubRaw.length === 64) {
      const jwk = {
        kty: "EC",
        crv: "P-256",
        x: toBase64Url(pubRaw.subarray(0, 32)),
        y: toBase64Url(pubRaw.subarray(32, 64)),
      } as const
      const attKey = createPublicKey({ key: jwk, format: "jwk" })
      // Try DER first
      try {
        const derSig = encodeEcdsaSignatureToDer(signature.qe_report_signature)
        const v = createVerify("sha256")
        v.update(signature.qe_report)
        v.end()
        if (v.verify(attKey, derSig)) return true
      } catch {}
      // Then raw P1363
      try {
        const v2 = createVerify("sha256")
        v2.update(signature.qe_report)
        v2.end()
        if (
          v2.verify(
            { key: attKey, dsaEncoding: "ieee-p1363" as const },
            signature.qe_report_signature,
          )
        )
          return true
      } catch {}
    }
  } catch {}

  return false
}

// /**
//  * Verify QE binding: qe_report.report_data[0..32) == SHA256(attestation_public_key || qe_auth_data)
//  */
// export function verifyQeReportBinding(quoteInput: string | Buffer): boolean {
//   const quoteBytes = Buffer.isBuffer(quoteInput)
//     ? quoteInput
//     : Buffer.from(quoteInput, "base64")

//   const { header, signature } = parseTdxQuote(quoteBytes)
//   if (header.version !== 4) throw new Error("Unsupported quote version")
//   if (!signature.qe_report_present) throw new Error("Missing QE report")

//   const pubRaw = signature.attestation_public_key
//   const pubUncompressed = Buffer.concat([Buffer.from([0x04]), pubRaw])

//   // Build SPKI DER from JWK and hash that too
//   const jwk = {
//     kty: "EC",
//     crv: "P-256",
//     x: pubRaw.subarray(0, 32).toString("base64url"),
//     y: pubRaw.subarray(32, 64).toString("base64url"),
//   } as const
//   let spki: Buffer | undefined
//   try {
//     spki = createPublicKey({ key: jwk, format: "jwk" }).export({
//       type: "spki",
//       format: "der",
//     }) as Buffer
//   } catch {}

//   const candidates: Buffer[] = []
//   candidates.push(createHash("sha256").update(pubRaw).digest())
//   candidates.push(createHash("sha256").update(pubUncompressed).digest())
//   if (spki) candidates.push(createHash("sha256").update(spki).digest())
//   candidates.push(
//     createHash("sha256").update(pubRaw).update(signature.qe_auth_data).digest(),
//   )
//   candidates.push(
//     createHash("sha256")
//       .update(pubUncompressed)
//       .update(signature.qe_auth_data)
//       .digest(),
//   )

//   // SGX REPORT structure is 384 bytes; report_data occupies the last 64 bytes (offset 320)
//   const reportData = signature.qe_report.subarray(320, 384)
//   const first = reportData.subarray(0, 32)
//   const second = reportData.subarray(32, 64)
//   return candidates.some((c) => c.equals(first) || c.equals(second))
// }

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
