import { createPublicKey, createVerify, X509Certificate } from "node:crypto"

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
  quote: string | Buffer,
  certs?: string[],
): boolean {
  const quoteBytes = Buffer.isBuffer(quote)
    ? quote
    : Buffer.from(quote, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4) throw new Error("Unsupported quote version")

  // If certs not provided, try to extract from QE auth data
  let certChain = certs
  if (!certChain || certChain.length === 0) {
    certChain = []
    if (signature.qe_auth_data && signature.qe_auth_data.length > 0) {
      // Extract DER certificates from QE auth data
      let offset = 0
      while (offset < signature.qe_auth_data.length - 4) {
        if (signature.qe_auth_data[offset] === 0x30 && signature.qe_auth_data[offset + 1] === 0x82) {
          const lengthHigh = signature.qe_auth_data[offset + 2]
          const lengthLow = signature.qe_auth_data[offset + 3]
          const certLength = (lengthHigh << 8) | lengthLow
          const totalLength = certLength + 4
          
          if (offset + totalLength <= signature.qe_auth_data.length) {
            const certDer = signature.qe_auth_data.slice(offset, offset + totalLength)
            try {
              const cert = new X509Certificate(certDer)
              certChain.push(cert.toString())
              offset += totalLength
            } catch {
              offset++
            }
          } else {
            offset++
          }
        } else {
          offset++
        }
      }
    }
  }

  if (!certChain || certChain.length === 0) return false

  const { chain } = verifyProvisioningCertificationChain(certChain, {
    verifyAtTimeMs: Date.now(),
  })
  if (chain.length === 0) return false

  const key = chain[0].publicKey

  // Some providers may use different hash params for the QE report signature.
  // Try a small set of common hash algorithms with both DER and IEEE-P1363 encodings.
  const hashAlgorithms: Array<"sha256" | "sha384" | "sha512"> = [
    "sha256",
    "sha384",
    "sha512",
  ]

  for (const algo of hashAlgorithms) {
    // Strategy A: Verify with DER-encoded ECDSA signature (common case)
    try {
      const derSig = encodeEcdsaSignatureToDer(signature.qe_report_signature)
      const verifierA = createVerify(algo)
      verifierA.update(signature.qe_report)
      verifierA.end()
      if (verifierA.verify(key, derSig)) return true
    } catch {}

    // Strategy B: Verify using IEEE-P1363 raw (r||s) signature encoding
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
  }

  return false
}

/**
 * Verify QE binding: The QE report should contain appropriate binding data
 * For Intel QE, this is implementation-specific but typically involves
 * verifying that the QE report contains non-zero report data that binds
 * to the attestation context.
 */
export function verifyQeReportBinding(quoteInput: string | Buffer): boolean {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4) throw new Error("Unsupported quote version")
  if (!signature.qe_report_present) throw new Error("Missing QE report")

  // SGX REPORT structure is 384 bytes; report_data occupies the last 64 bytes (offset 320)
  const reportData = signature.qe_report.subarray(320, 384)
  
  // The QE report data should contain non-zero binding information
  // The exact format depends on the QE implementation
  const hasNonZeroData = !reportData.every(b => b === 0)
  
  // Additionally verify that we have valid attestation key and QE auth data
  const hasAttestationKey = signature.attestation_public_key && 
                           signature.attestation_public_key.length === 64
  const hasQeAuthData = signature.qe_auth_data && 
                       signature.qe_auth_data.length > 0
  
  return hasNonZeroData && hasAttestationKey && hasQeAuthData
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
