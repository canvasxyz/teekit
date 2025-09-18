import { Crypto } from "@peculiar/webcrypto"
import {
  X509Certificate,
  BasicConstraintsExtension,
  KeyUsagesExtension,
  KeyUsageFlags,
  cryptoProvider,
} from "@peculiar/x509"

// Set up crypto provider for browser compatibility
// Use @peculiar/webcrypto for better browser compatibility
const webCrypto = new Crypto()
cryptoProvider.set(webCrypto as any)

import {
  getTdx10SignedRegion,
  getTdx15SignedRegion,
  parseTdxQuote,
} from "./structs.js"
import {
  computeCertSha256Hex,
  encodeEcdsaSignatureToDer,
  extractPemCertificates,
  normalizeSerialHex,
  parseCrlRevokedSerials,
  toBase64Url,
} from "./utils.js"
import { intelSgxRootCaPem } from "./rootCa.js"

export interface VerifyConfig {
  crls: Buffer[]
  pinnedRootCerts?: X509Certificate[]
  date?: number
  extraCertdata?: string[]
}

export const DEFAULT_PINNED_ROOT_CERTS: X509Certificate[] = [
  new X509Certificate(intelSgxRootCaPem),
]

/**
 * Verify a complete chain of trust for a TDX enclave, including the
 * Intel SGX Root CA, PCK certificate chain, and QE signature and binding.
 *
 * Optional: accepts `extraCertdata`, which is used if `quote` is missing certdata.
 */
export async function verifyTdx(quote: Buffer, config?: VerifyConfig) {
  if (
    config !== undefined &&
    (typeof config !== "object" || Array.isArray(config))
  ) {
    throw new Error("verifyTdx: invalid config argument provided")
  }

  const pinnedRootCerts = config?.pinnedRootCerts ?? DEFAULT_PINNED_ROOT_CERTS
  const date = config?.date
  const extraCertdata = config?.extraCertdata
  const crls = config?.crls
  const { signature, header } = parseTdxQuote(quote)
  const certs = extractPemCertificates(signature.cert_data)
  let { status, root } = await verifyPCKChain(certs, date ?? +new Date(), crls)

  // Use fallback certs, only if certdata is not provided
  if (!root && certs.length === 0) {
    if (!extraCertdata) {
      throw new Error("verifyTdx: missing certdata")
    }
    const fallback = await verifyPCKChain(
      extraCertdata,
      date ?? +new Date(),
      crls,
    )
    status = fallback.status
    root = fallback.root
  }
  if (status === "expired") {
    throw new Error("verifyTdx: expired cert chain, or not yet valid")
  }
  if (status === "revoked") {
    throw new Error("verifyTdx: revoked certificate in cert chain")
  }
  if (status !== "valid") {
    throw new Error("verifyTdx: invalid cert chain")
  }
  if (!root) {
    throw new Error("verifyTdx: invalid cert chain")
  }

  // Check against the pinned root certificates
  const candidateRootHash = await computeCertSha256Hex(root)
  const knownRootHashes = new Set(
    await Promise.all(pinnedRootCerts.map(computeCertSha256Hex)),
  )
  const rootIsValid = knownRootHashes.has(candidateRootHash)
  if (!rootIsValid) {
    throw new Error("verifyTdx: invalid root")
  }

  if (header.tee_type !== 129) {
    throw new Error("verifyTdx: only tdx is supported")
  }
  if (header.att_key_type !== 2) {
    throw new Error("verifyTdx: only ECDSA att_key_type is supported")
  }
  if (signature.cert_data_type !== 5) {
    throw new Error("verifyTdx: only PCK cert_data is supported")
  }
  if (!(await verifyTdxQeReportSignature(quote, extraCertdata))) {
    throw new Error("verifyTdx: invalid qe report signature")
  }
  if (!(await verifyTdxQeReportBinding(quote))) {
    throw new Error("verifyTdx: invalid qe report binding")
  }
  if (!(await verifyTdxQuoteSignature(quote))) {
    throw new Error("verifyTdx: invalid signature over quote")
  }

  return true
}

export async function verifyTdxBase64(quote: string, config?: VerifyConfig) {
  return await verifyTdx(Buffer.from(quote, "base64"), config)
}

/**
 * Verify a PCK provisioning certificate chain embedded in cert_data.
 * - Identifies the leaf certificate and walks up the chain, following issuer/subject chaining.
 * - Expects at least two certificates.
 * - Checks the validity window of each certificate.
 */
export async function verifyPCKChain(
  certData: string[],
  verifyAtTimeMs: number | null,
  crls?: Buffer[],
): Promise<{
  status: "valid" | "invalid" | "expired" | "revoked"
  root: X509Certificate | null
  chain: X509Certificate[]
}> {
  if (certData.length === 0) return { status: "invalid", root: null, chain: [] }

  // Build certificate objects using @peculiar/x509
  const certs = certData.map((pem) => new X509Certificate(pem))

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
    const notBefore = c.notBefore.getTime()
    const notAfter = c.notAfter.getTime()
    if (
      verifyAtTimeMs !== null &&
      !(notBefore <= verifyAtTimeMs && verifyAtTimeMs <= notAfter)
    ) {
      return { status: "expired", root: chain[chain.length - 1] ?? null, chain }
    }
  }

  // Cryptographically verify signatures along the chain: each child signed by its parent
  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i]
    const parent = chain[i + 1]
    try {
      if (!(await child.verify(parent))) {
        return { status: "invalid", root: null, chain: [] }
      }
    } catch {
      return { status: "invalid", root: null, chain: [] }
    }
  }

  // If the terminal certificate is self-signed, verify its signature as well
  const terminal = chain[chain.length - 1]
  if (terminal && terminal.subject === terminal.issuer) {
    try {
      if (!(await terminal.verify(terminal))) {
        return { status: "invalid", root: null, chain: [] }
      }
    } catch {
      return { status: "invalid", root: null, chain: [] }
    }
  }

  // Additional certificate checks, based on a minimal version of RFC 5280 path extensions
  // - CA certs must assert basicConstraints.ca = true
  // - CA certs with keyUsage must include keyCertSign
  // - End-entity leaf must assert ca = false if basicConstraints present
  // - End-entity with keyUsage must include digitalSignature (used for ECDSA signing)
  // - Respect pathLenConstraint when present on CA certs

  // Determine CA flag of each cert in the path using BasicConstraints if present
  const isCAInChain: boolean[] = chain.map((node) => {
    const bc = node.getExtension(BasicConstraintsExtension)
    return bc ? !!bc.ca : false
  })

  // Leaf checks
  const leafNode = chain[0]
  const bc = leafNode.getExtension(BasicConstraintsExtension)
  if (bc && bc.ca) {
    return { status: "invalid", root: null, chain: [] }
  }
  const ku = leafNode.getExtension(KeyUsagesExtension)
  if (ku) {
    const hasDigitalSignature =
      (ku.usages & KeyUsageFlags.digitalSignature) !== 0
    if (!hasDigitalSignature) {
      return { status: "invalid", root: null, chain: [] }
    }
  }

  // CA and pathLen checks for all issuers in the chain
  for (let i = 1; i < chain.length; i++) {
    const issuerNode = chain[i]
    const bc = issuerNode.getExtension(BasicConstraintsExtension)
    // CA certs must assert CA=true
    if (!bc || !bc.ca) {
      return { status: "invalid", root: null, chain: [] }
    }

    // keyUsage, if present, must include keyCertSign
    const ku = issuerNode.getExtension(KeyUsagesExtension)
    if (ku) {
      const canSignCert = (ku.usages & KeyUsageFlags.keyCertSign) !== 0
      if (!canSignCert) {
        return { status: "invalid", root: null, chain: [] }
      }
    }

    // pathLenConstraint validation: number of subsequent non-self-issued CA certs
    if (typeof bc.pathLength === "number") {
      let subsequentCAs = 0
      for (let j = 0; j < i; j++) {
        if (isCAInChain[j]) subsequentCAs++
      }
      if (subsequentCAs > bc.pathLength) {
        return { status: "invalid", root: null, chain: [] }
      }
    }
  }

  // CRL: Check all certificates in the PCK chain against revocation lists
  if (crls && crls.length > 0) {
    const revoked = new Set<string>()
    for (const crl of crls) {
      const serials = parseCrlRevokedSerials(crl)
      for (const s of serials) revoked.add(s)
    }
    if (revoked.size > 0) {
      for (const cert of chain) {
        // Node returns colonless/colon-separated uppercase hex; normalize
        const serial = normalizeSerialHex(cert.serialNumber)
        if (revoked.has(serial)) {
          return { status: "revoked", root: null, chain: [] }
        }
      }
    }
  }

  return { status: "valid", root: chain[chain.length - 1] ?? null, chain }
}

/**
 * Verify that the cert chain appropriately signed the quoting enclave report.
 * This verifies the PCK leaf certificate public key, against qe_report_signature
 * and the qe_report body (384 bytes).
 */
export async function verifyTdxQeReportSignature(
  quoteInput: string | Buffer,
  extraCerts?: string[],
): Promise<boolean> {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4 && header.version !== 5)
    throw new Error("Unsupported quote version")

  // Must have a QE report to verify
  if (!signature.qe_report_present || signature.qe_report.length !== 384) {
    return false
  }

  // Prefer certdata; otherwise use extraCerts
  let certs: string[] = extractPemCertificates(signature.cert_data)
  if (certs.length === 0) {
    certs = extraCerts ?? []
  }
  if (certs.length === 0) return false

  const { chain } = await verifyPCKChain(certs, null)

  if (chain.length === 0) return false

  const pckLeafCert = chain[0]
  const pckLeafKey = pckLeafCert.publicKey

  // Following Intel's C++ implementation:
  // 1. Use raw ECDSA signature (64 bytes: r||s) directly
  // 2. Verify with SHA-256 against the raw QE report blob (384 bytes)
  try {
    // Use the raw signature directly - webcrypto expects raw format for ECDSA
    const rawSignature = signature.qe_report_signature

    // Import the public key for verification
    const publicKey = await crypto.subtle.importKey(
      "spki",
      pckLeafKey.rawData,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )

    // Verify the signature
    const result = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      rawSignature,
      signature.qe_report,
    )

    return result
  } catch (error) {
    console.error("TDX QE report signature verification error:", error)
    return false
  }
}

/**
 * Verify that the attestation_public_key in a quote matches its quoting enclave's
 * report_data (QE binding):
 *
 * qe_report.report_data[0..32) == SHA256(attestation_public_key || qe_auth_data)
 *
 * Accept several reasonable variants to accommodate ecosystem differences.
 */
export async function verifyTdxQeReportBinding(
  quoteInput: string | Buffer,
): Promise<boolean> {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4 && header.version !== 5)
    throw new Error("Unsupported quote version")
  if (!signature.qe_report_present) throw new Error("Missing QE report")

  const combinedData = Buffer.concat([
    signature.attestation_public_key,
    signature.qe_auth_data,
  ])
  const hashedPubkey = await crypto.subtle.digest("SHA-256", combinedData)

  const uncompressedData = Buffer.concat([
    Buffer.from([0x04]),
    signature.attestation_public_key,
    signature.qe_auth_data,
  ])
  const hashedUncompressedPubkey = await crypto.subtle.digest(
    "SHA-256",
    uncompressedData,
  )

  // QE report is 384 bytes; report_data occupies the last 64 bytes (offset 320).
  // The attestation_public_key should be embedded in the first half.
  const reportData = signature.qe_report.subarray(320, 384)
  const reportDataEmbed = reportData.subarray(0, 32)

  return (
    Buffer.from(hashedPubkey).equals(reportDataEmbed) ||
    Buffer.from(hashedUncompressedPubkey).equals(reportDataEmbed)
  )
}

/**
 * Verify the attestation_public_key in a TDX quote signed the embedded header/body
 * with a ECDSA-P256 signature. This checks only the quote signature itself and
 * does not validate the certificate chain, QE report, CRLs, TCBs, etc.
 */
export async function verifyTdxQuoteSignature(
  quoteInput: string | Buffer,
): Promise<boolean> {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)

  let message
  if (header.version === 4) {
    message = getTdx10SignedRegion(quoteBytes)
  } else if (header.version === 5) {
    message = getTdx15SignedRegion(quoteBytes)
  } else {
    throw new Error(`Unsupported TDX quote version: ${header.version}`)
  }

  const rawSig = signature.ecdsa_signature

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

  // Import the public key from JWK format
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  )

  // Verify the signature
  return await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    rawSig,
    message,
  )
}
