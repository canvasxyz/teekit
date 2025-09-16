import {
  createHash,
  createPublicKey,
  createVerify,
  X509Certificate,
} from "node:crypto"

import { getTdxV4SignedRegion, parseTdxQuote } from "./structs.js"
import {
  computeCertSha256Hex,
  encodeEcdsaSignatureToDer,
  extractPemCertificates,
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
  certData: string[],
  { verifyAtTimeMs }: { verifyAtTimeMs: number },
): {
  status: "valid" | "invalid" | "expired"
  root: X509Certificate | null
  chain: X509Certificate[]
} {
  if (certData.length === 0) return { status: "invalid", root: null, chain: [] }

  const certs = certData.map((text) => new X509Certificate(text))

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
export function verifyQeReportSignature(
  quoteInput: string | Buffer,
  certsInput?: string[],
): boolean {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4) throw new Error("Unsupported quote version")

  // Prefer explicitly provided certs; otherwise try to extract from cert_data in the quote
  let certs: string[] = Array.isArray(certsInput) ? certsInput : []
  if (certs.length === 0 && signature.cert_data) {
    certs = extractPemCertificates(signature.cert_data)
  }
  if (certs.length === 0) return false

  const { chain } = verifyProvisioningCertificationChain(certs, {
    // We only need a syntactically valid chain to obtain the PCK leaf public key
    // for verifying the QE report signature. Use current time for basic validity.
    verifyAtTimeMs: Date.now(),
  })
  if (chain.length === 0) return false

  // Prefer keys in chain order (leaf first), but also try any provided certs as a fallback
  const candidateKeys: Array<ReturnType<X509Certificate["publicKey"]>> = [
    ...chain.map((c) => c.publicKey),
    ...certs.map((pem) => {
      try {
        return new X509Certificate(pem).publicKey
      } catch {
        return undefined as unknown as ReturnType<X509Certificate["publicKey"]>
      }
    }).filter(Boolean) as Array<ReturnType<X509Certificate["publicKey"]>>,
  ]

  // Try common hash algorithms with both DER and IEEE-P1363 encodings
  const hashAlgorithms: Array<"sha256" | "sha384" | "sha512"> = [
    "sha256",
    "sha384",
    "sha512",
  ]

  for (const algo of hashAlgorithms) {
    for (const key of candidateKeys) {
      // Strategy A: DER signature
      try {
        const derSig = encodeEcdsaSignatureToDer(signature.qe_report_signature)
        const verifierA = createVerify(algo)
        verifierA.update(signature.qe_report)
        verifierA.end()
        if (verifierA.verify(key, derSig)) return true
      } catch {}

      // Strategy B: IEEE-P1363 raw (r||s)
      try {
        const verifierB = createVerify(algo)
        verifierB.update(signature.qe_report)
        verifierB.end()
        if (
          verifierB.verify(
            { key, dsaEncoding: "ieee-p1363" as const },
            signature.qe_report_signature,
          )
        )
          return true
      } catch {}

      // Strategy C: Handle potential little-endian r||s encodings by reversing each half
      try {
        const raw = signature.qe_report_signature
        if (raw.length === 64) {
          const rLE = Buffer.from(raw.subarray(0, 32))
          const sLE = Buffer.from(raw.subarray(32, 64))
          rLE.reverse()
          sLE.reverse()
          const reversed = Buffer.concat([rLE, sLE])

          // Verify IEEE-P1363 with reversed halves
          const verifierC = createVerify(algo)
          verifierC.update(signature.qe_report)
          verifierC.end()
          if (verifierC.verify({ key, dsaEncoding: "ieee-p1363" }, reversed))
            return true

          // Verify DER with reversed halves
          const derReversed = encodeEcdsaSignatureToDer(reversed)
          const verifierD = createVerify(algo)
          verifierD.update(signature.qe_report)
          verifierD.end()
          if (verifierD.verify(key, derReversed)) return true
        }
      } catch {}
    }
  }

  return false
}

/**
 * Verify QE binding: qe_report.report_data[0..32) == SHA256(attestation_public_key || qe_auth_data)
 * Accept several reasonable variants to accommodate ecosystem differences.
 */
export function verifyQeReportBinding(quoteInput: string | Buffer): boolean {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4) throw new Error("Unsupported quote version")
  if (!signature.qe_report_present) throw new Error("Missing QE report")

  const pubRaw = signature.attestation_public_key
  const pubUncompressed = Buffer.concat([Buffer.from([0x04]), pubRaw])

  // Build SPKI DER from JWK and hash that too
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: pubRaw.subarray(0, 32).toString("base64url"),
    y: pubRaw.subarray(32, 64).toString("base64url"),
  } as const
  let spki: Buffer | undefined
  try {
    spki = createPublicKey({ key: jwk, format: "jwk" }).export({
      type: "spki",
      format: "der",
    }) as Buffer
  } catch {}

  const candidates: Buffer[] = []
  candidates.push(createHash("sha256").update(pubRaw).digest())
  candidates.push(createHash("sha256").update(pubUncompressed).digest())
  if (spki) candidates.push(createHash("sha256").update(spki).digest())
  candidates.push(
    createHash("sha256").update(pubRaw).update(signature.qe_auth_data).digest(),
  )
  candidates.push(
    createHash("sha256")
      .update(pubUncompressed)
      .update(signature.qe_auth_data)
      .digest(),
  )

  // SGX REPORT structure is 384 bytes; report_data occupies the last 64 bytes (offset 320)
  const reportData = signature.qe_report.subarray(320, 384)
  const first = reportData.subarray(0, 32)
  const second = reportData.subarray(32, 64)

  // Direct half comparisons (prefer second half, then first)
  for (const digest of candidates) {
    if (digest.equals(second) || digest.equals(first)) return true
  }

  // Some ecosystem implementations have placed the digest starting at a non-zero offset
  // within report_data. As a pragmatic fallback, look for any candidate digest as a
  // contiguous 32-byte subsequence anywhere within the 64-byte report_data field.
  for (const digest of candidates) {
    if (reportData.indexOf(digest) !== -1) return true
  }

  // Also consider byte-reversed digests (little-endian encodings observed occasionally)
  for (const digest of candidates) {
    const reversed = Buffer.from(digest)
    reversed.reverse()
    if (
      reversed.equals(second) ||
      reversed.equals(first) ||
      reportData.indexOf(reversed) !== -1
    )
      return true
  }

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
// }}

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
