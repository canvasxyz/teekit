import { createHash, createPublicKey, createVerify } from "crypto"
import {
  getSgxSignedRegion,
  parseSgxQuote,
  QuoteHeader,
  SgxReportBody,
} from "./structs.js"
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

export function verifySgx(quote: Buffer, config?: VerifyConfig) {
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
  const certs = extractPemCertificates(signature.cert_data)
  let { status, root } = verifyPCKChain(certs, date ?? +new Date(), crls)

  // Use fallback certs, only if certdata is not provided
  if (!root && certs.length === 0) {
    if (!extraCertdata) {
      throw new Error("verifySgx: missing certdata")
    }
    const fallback = verifyPCKChain(extraCertdata, date ?? +new Date(), crls)
    status = fallback.status
    root = fallback.root
  }
  if (status === "expired") {
    throw new Error("verifySgx: expired cert chain, or not yet valid")
  }
  if (status === "revoked") {
    throw new Error("verifySgx: revoked certificate in cert chain")
  }
  if (status !== "valid") {
    throw new Error("verifySgx: invalid cert chain")
  }
  if (!root) {
    throw new Error("verifySgx: invalid cert chain")
  }

  // Check against the pinned root certificates
  const candidateRootHash = computeCertSha256Hex(root)
  const knownRootHashes = new Set(pinnedRootCerts.map(computeCertSha256Hex))
  const rootIsValid = knownRootHashes.has(candidateRootHash)
  if (!rootIsValid) {
    throw new Error("verifySgx: invalid root")
  }

  if (header.tee_type !== 0) {
    throw new Error("verifySgx: only sgx is supported")
  }
  if (header.att_key_type !== 2) {
    throw new Error("verifySgx: only ECDSA att_key_type is supported")
  }
  if (signature.cert_data_type !== 5) {
    throw new Error("verifySgx: only PCK cert_data is supported")
  }
  if (!verifySgxQeReportSignature(quote, extraCertdata)) {
    throw new Error("verifySgx: invalid qe report signature")
  }
  if (!verifySgxQeReportBinding(quote)) {
    throw new Error("verifySgx: invalid qe report binding")
  }
  if (!verifySgxQuoteSignature(quote)) {
    throw new Error("verifySgx: invalid signature over quote")
  }

  return true
}

/**
 * Verify that the cert chain appropriately signed the quoting enclave report.
 * This verifies the PCK leaf certificate public key signed the SGX quote body
 * (qe_report_body, 384 bytes) in qe_report_signature.
 */
export function verifySgxQeReportSignature(
  quoteInput: string | Buffer,
  extraCerts?: string[],
): boolean {
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
  // 1. Convert raw ECDSA signature (64 bytes: r||s) to DER format
  // 2. Verify with SHA-256 against the raw QE report blob (384 bytes)
  try {
    const derSignature = encodeEcdsaSignatureToDer(
      signature.qe_report_signature,
    )
    const verifier = createVerify("sha256")
    verifier.update(signature.qe_report)
    verifier.end()
    const result = verifier.verify(pckLeafKey, derSignature)
    return result
  } catch {
    return false
  }
}

/**
 * Verify that the attestation_public_key in a quote matches its quoting enclave's
 * report_data (QE binding):
 *
 * qe_report.report_data[0..32) == SHA256(attestation_public_key || qe_auth_data)
 */
export function verifySgxQeReportBinding(quoteInput: string | Buffer): boolean {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseSgxQuote(quoteBytes)
  if (header.version !== 3) throw new Error("Unsupported quote version")
  if (!signature.qe_report_present) throw new Error("Missing QE report")

  const hashedPubkey = createHash("sha256")
    .update(signature.attestation_public_key)
    .update(signature.qe_auth_data)
    .digest()
  const hashedUncompressedPubkey = createHash("sha256")
    .update(
      Buffer.concat([Buffer.from([0x04]), signature.attestation_public_key]),
    )
    .update(signature.qe_auth_data)
    .digest()

  // QE report is 384 bytes; report_data occupies the last 64 bytes (offset 320).
  // The attestation_public_key should be embedded in the first half.
  const reportData = signature.qe_report.subarray(320, 384)
  const reportDataEmbed = reportData.subarray(0, 32)

  return (
    hashedPubkey.equals(reportDataEmbed) ||
    hashedUncompressedPubkey.equals(reportDataEmbed)
  )
}

/**
 * Verify the attestation_public_key in an SGX quote signed the embedded quote.
 * Does not validate the certificate chain, QE report, CRLs, TCBs, etc.
 */
export function verifySgxQuoteSignature(quoteInput: string | Buffer): boolean {
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

  const makeDerSig = (reverse: boolean) => {
    if (!reverse) return encodeEcdsaSignatureToDer(rawSig)
    const rLE = rawSig.subarray(0, 32)
    const sLE = rawSig.subarray(32, 64)
    const rBE = Buffer.from(rLE).reverse()
    const sBE = Buffer.from(sLE).reverse()
    return encodeEcdsaSignatureToDer(Buffer.concat([rBE, sBE]))
  }

  const makePublicKey = () => {
    const xBytes = pub.subarray(0, 32)
    const yBytes = pub.subarray(32, 64)
    const jwk = {
      kty: "EC",
      crv: "P-256",
      x: toBase64Url(xBytes),
      y: toBase64Url(yBytes),
    } as const
    return createPublicKey({ key: jwk, format: "jwk" })
  }

  // Default attempt (big-endian coords and signature) — works for TDX and some SGX emitters
  const defaultKey = makePublicKey()
  const defaultSig = makeDerSig(false)
  let verifier = createVerify("sha256")
  verifier.update(message)
  verifier.end()
  if (verifier.verify(defaultKey, defaultSig)) return true

  // For SGX quotes, some implementations serialize r and s little-endian.
  // Retry with reversed r/s only.
  if (header.tee_type === 0) {
    const altSig = makeDerSig(true)
    verifier = createVerify("sha256")
    verifier.update(message)
    verifier.end()
    if (verifier.verify(defaultKey, altSig)) return true
  }

  return false
}

export function verifySgxBase64(quote: string, config?: VerifyConfig) {
  return verifySgx(Buffer.from(quote, "base64"), config)
}
