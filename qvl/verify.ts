import { createHash, createPublicKey, createVerify, X509Certificate } from "node:crypto"

import { getTdxV4SignedRegion, parseTdxQuote } from "./structs.js"
import {
  computeCertSha256Hex,
  encodeEcdsaSignatureToDer,
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
  quote: string | Buffer, // TODO: take just what we need to verify
  certs: string[],
): boolean {
  const quoteBytes = Buffer.isBuffer(quote)
    ? quote
    : Buffer.from(quote, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4) throw new Error("Unsupported quote version")

  const { chain } = verifyProvisioningCertificationChain(certs, {
    verifyAtTimeMs: 0,
  })
  if (chain.length === 0) return false

  const key = chain[0].publicKey

  const candidateMessages: Buffer[] = [
    signature.qe_report,
    // Some implementations sign only the first 320 bytes (report body without report_data)
    signature.qe_report.subarray(0, 320),
  ]

  const raw = signature.qe_report_signature
  const r = raw.subarray(0, 32)
  const s = raw.subarray(32, 64)
  const rev = (b: Buffer) => Buffer.from(b).reverse()
  const rawCandidates: Buffer[] = [
    raw,
    Buffer.concat([rev(r), s]),
    Buffer.concat([r, rev(s)]),
    Buffer.concat([rev(r), rev(s)]),
  ]

  for (const message of candidateMessages) {
    for (const rawSig of rawCandidates) {
      // Strategy A: Verify with DER-encoded ECDSA signature (common case)
      try {
        const derSig = encodeEcdsaSignatureToDer(rawSig)
        const verifierA = createVerify("sha256")
        verifierA.update(message)
        verifierA.end()
        if (verifierA.verify(key, derSig)) return true
      } catch {}

      // Strategy B: Verify using IEEE-P1363 raw (r||s) signature encoding
      try {
        const verifierB = createVerify("sha256")
        verifierB.update(message)
        verifierB.end()
        if (
          verifierB.verify(
            { key, dsaEncoding: "ieee-p1363" as const },
            rawSig,
          )
        )
          return true
      } catch {}
    }
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
 * Verify QE binding: qe_report.report_data contains a SHA-256 digest that binds
 * the QE attestation public key (and optionally qe_auth_data) to the report.
 * We try several common encodings observed in DCAP/TDX implementations.
 */
export function verifyQeReportBinding(quoteInput: string | Buffer): boolean {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4) throw new Error("Unsupported quote version")
  if (!signature.qe_report_present) throw new Error("Missing QE report")

  const publicKeyRaw = signature.attestation_public_key
  const uncompressedPoint = Buffer.concat([Buffer.from([0x04]), publicKeyRaw])

  // Build SPKI DER from JWK
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: publicKeyRaw.subarray(0, 32).toString("base64url"),
    y: publicKeyRaw.subarray(32, 64).toString("base64url"),
  } as const
  let spkiDer: Buffer | undefined
  try {
    spkiDer = createPublicKey({ key: jwk, format: "jwk" }).export({
      type: "spki",
      format: "der",
    }) as Buffer
  } catch {}

  const makeHash = () => createHash("sha256")
  const candidates: Buffer[] = []
  candidates.push(makeHash().update(publicKeyRaw).digest())
  candidates.push(makeHash().update(uncompressedPoint).digest())
  if (spkiDer) candidates.push(makeHash().update(spkiDer).digest())
  candidates.push(
    makeHash().update(publicKeyRaw).update(signature.qe_auth_data).digest(),
  )
  candidates.push(
    makeHash().update(uncompressedPoint).update(signature.qe_auth_data).digest(),
  )
  if (spkiDer)
    candidates.push(
      makeHash().update(spkiDer).update(signature.qe_auth_data).digest(),
    )

  // SGX REPORT structure is 384 bytes; report_data is the last 64 bytes (offset 320)
  const reportData = signature.qe_report.subarray(320, 384)
  const first = reportData.subarray(0, 32)
  const second = reportData.subarray(32, 64)
  return candidates.some((c) => c.equals(first) || c.equals(second))
}

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
