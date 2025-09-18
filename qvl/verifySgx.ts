import { Crypto } from "@peculiar/webcrypto"
import { cryptoProvider } from "@peculiar/x509"

const crypto = new Crypto()
cryptoProvider.set(crypto)
import { getSgxSignedRegion, parseSgxQuote } from "./structs.js"
import {
  computeCertSha256Hex,
  encodeEcdsaSignatureToDer,
  extractPemCertificates,
  toBase64Url,
} from "./utils.js"
import {
  DEFAULT_PINNED_ROOT_CERTS,
  VerifyConfig,
  verifyPCKChain,
} from "./verifyTdx.js"

export async function verifySgx(quote: Buffer, config?: VerifyConfig) {
  console.log("verifySgx called with quote length:", quote.length)
  if (
    config !== undefined &&
    (typeof config !== "object" || Array.isArray(config))
  ) {
    throw new Error("verifySgx: invalid config argument provided")
  }

  const pinnedRootCerts = config?.pinnedRootCerts ?? DEFAULT_PINNED_ROOT_CERTS
  const date = config?.date
  const extraCertdata = config?.extraCertdata
  const crls = config?.crls
  const { signature, header } = parseSgxQuote(quote)
  console.log("Parsed SGX quote, header version:", header.version)
  const certs = extractPemCertificates(signature.cert_data)
  console.log("Extracted certificates:", certs.length)
  let { status, root } = await verifyPCKChain(certs, date ?? +new Date(), crls)
  console.log("PCK chain verification status:", status)

  // Use fallback certs, only if certdata is not provided
  if (!root && certs.length === 0) {
    console.log("Using fallback certificates, extraCertdata length:", extraCertdata?.length)
    if (!extraCertdata) {
      throw new Error("verifySgx: missing certdata")
    }
    const fallback = await verifyPCKChain(extraCertdata, date ?? +new Date(), crls)
    console.log("Fallback PCK chain verification status:", fallback.status)
    status = fallback.status
    root = fallback.root
  }
  console.log("Checking certificate chain status...")
  if (status === "expired") {
    console.log("Certificate chain expired")
    throw new Error("verifySgx: expired cert chain, or not yet valid")
  }
  if (status === "revoked") {
    console.log("Certificate chain revoked")
    throw new Error("verifySgx: revoked certificate in cert chain")
  }
  if (status !== "valid") {
    console.log("Certificate chain invalid, status:", status)
    throw new Error("verifySgx: invalid cert chain")
  }
  if (!root) {
    console.log("No root certificate found")
    throw new Error("verifySgx: invalid cert chain")
  }
  console.log("Certificate chain validation passed")

  // Check against the pinned root certificates
  console.log("Checking pinned root certificates...")
  const candidateRootHash = await computeCertSha256Hex(root)
  console.log("Candidate root hash:", candidateRootHash)
  const knownRootHashes = new Set(await Promise.all(pinnedRootCerts.map(computeCertSha256Hex)))
  console.log("Known root hashes:", Array.from(knownRootHashes))
  const rootIsValid = knownRootHashes.has(candidateRootHash)
  console.log("Root is valid:", rootIsValid)
  if (!rootIsValid) {
    throw new Error("verifySgx: invalid root")
  }

  console.log("Checking quote format...")
  console.log("tee_type:", header.tee_type)
  console.log("att_key_type:", header.att_key_type)
  console.log("cert_data_type:", signature.cert_data_type)
  if (header.tee_type !== 0) {
    throw new Error("verifySgx: only sgx is supported")
  }
  if (header.att_key_type !== 2) {
    throw new Error("verifySgx: only ECDSA att_key_type is supported")
  }
  if (signature.cert_data_type !== 5) {
    throw new Error("verifySgx: only PCK cert_data is supported")
  }
  console.log("Quote format validation passed")
  const qeReportSigValid = await verifySgxQeReportSignature(quote, extraCertdata)
  console.log("SGX QE report signature valid:", qeReportSigValid)
  if (!qeReportSigValid) {
    throw new Error("verifySgx: invalid qe report signature")
  }
  const qeReportBindingValid = await verifySgxQeReportBinding(quote)
  console.log("SGX QE report binding valid:", qeReportBindingValid)
  if (!qeReportBindingValid) {
    throw new Error("verifySgx: invalid qe report binding")
  }
  const quoteSigValid = await verifySgxQuoteSignature(quote)
  console.log("SGX quote signature valid:", quoteSigValid)
  if (!quoteSigValid) {
    throw new Error("verifySgx: invalid signature over quote")
  }

  console.log("verifySgx returning true")
  return true
}

/**
 * Verify that the cert chain appropriately signed the quoting enclave report.
 * This verifies the PCK leaf certificate public key signed the SGX quote body
 * (qe_report_body, 384 bytes) in qe_report_signature.
 */
export async function verifySgxQeReportSignature(
  quoteInput: string | Buffer,
  extraCerts?: string[],
): Promise<boolean> {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseSgxQuote(quoteBytes)
  if (header.version !== 3) throw new Error("Unsupported quote version")

  // Must have a QE report to verify
  if (!signature.qe_report_present || !signature.qe_report) {
    return false
  }

  // Prefer certdata; otherwise use extraCerts
  let certs: string[] = extractPemCertificates(signature.cert_data)
  if (certs.length === 0) {
    certs = extraCerts ?? []
  }
  if (certs.length === 0) return false

  const { chain } = verifyPCKChain(certs, null)

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
      ["verify"]
    )
    
    // Verify the signature - webcrypto handles hashing internally
    const result = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      rawSignature,
      signature.qe_report
    )
    return result
  } catch (error) {
    console.error("QE report signature verification error:", error)
    return false
  }
}

/**
 * Verify that the attestation_public_key in a quote matches its quoting enclave's
 * report_data (QE binding):
 *
 * qe_report.report_data[0..32) == SHA256(attestation_public_key || qe_auth_data)
 */
export async function verifySgxQeReportBinding(quoteInput: string | Buffer): Promise<boolean> {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseSgxQuote(quoteBytes)
  if (header.version !== 3) throw new Error("Unsupported quote version")
  if (!signature.qe_report_present) throw new Error("Missing QE report")

  const combinedData = Buffer.concat([signature.attestation_public_key, signature.qe_auth_data])
  const hashedPubkey = await crypto.subtle.digest("SHA-256", combinedData)
  
  const uncompressedData = Buffer.concat([Buffer.from([0x04]), signature.attestation_public_key, signature.qe_auth_data])
  const hashedUncompressedPubkey = await crypto.subtle.digest("SHA-256", uncompressedData)

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
 * Verify the attestation_public_key in an SGX quote signed the embedded quote.
 * Does not validate the certificate chain, QE report, CRLs, TCBs, etc.
 */
export async function verifySgxQuoteSignature(quoteInput: string | Buffer): Promise<boolean> {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseSgxQuote(quoteBytes)
  if (header.version !== 3) throw new Error(`Unsupported quote version`)

  const message = getSgxSignedRegion(quoteBytes)
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
    ["verify"]
  )

  // Verify the signature
  return await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    rawSig,
    message
  )
}

export async function verifySgxBase64(quote: string, config?: VerifyConfig) {
  return await verifySgx(Buffer.from(quote, "base64"), config)
}
