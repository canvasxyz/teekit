import { getSgxSignedRegion } from "./structs.js"
import { parseSgxQuote } from "./parse.js"
import {
  computeCertSha256Hex,
  extractPemCertificates,
  toBase64Url,
} from "./utils.js"
import {
  DEFAULT_PINNED_ROOT_CERTS,
  TdxQuote,
  VerifyConfig,
  verifyPCKChain,
} from "./verifyTdx.js"
import { concatBytes, bytesEqual } from "./utils.js"
import { base64 as scureBase64 } from "@scure/base"

/**
 * Verify that the cert chain appropriately signed the quoting enclave report.
 * This verifies the PCK leaf certificate public key signed the SGX quote body
 * (qe_report_body, 384 bytes) in qe_report_signature.
 */
export async function verifySgxQeReportSignature(
  quoteInput: string | Uint8Array,
  extraCerts?: string[],
): Promise<boolean> {
  const quoteBytes =
    typeof quoteInput === "string" ? scureBase64.decode(quoteInput) : quoteInput

  const { header, signature } = parseSgxQuote(quoteBytes)
  if (header.version !== 3) throw new Error("Unsupported quote version")

  if (!signature.qe_report_present || !signature.qe_report) {
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
    const publicKey = await crypto.subtle.importKey(
      "spki",
      pckLeafKey.rawData,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    const result = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature.qe_report_signature,
      signature.qe_report,
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
export async function verifySgxQeReportBinding(
  quoteInput: string | Uint8Array,
): Promise<boolean> {
  const quoteBytes =
    typeof quoteInput === "string" ? scureBase64.decode(quoteInput) : quoteInput

  const { header, signature } = parseSgxQuote(quoteBytes)
  if (header.version !== 3) throw new Error("Unsupported quote version")
  if (!signature.qe_report_present) throw new Error("Missing QE report")

  const combinedData = concatBytes([
    signature.attestation_public_key,
    signature.qe_auth_data,
  ]).slice()
  const hashedPubkey = await crypto.subtle.digest("SHA-256", combinedData)

  const uncompressedData = concatBytes([
    new Uint8Array([0x04]),
    signature.attestation_public_key,
    signature.qe_auth_data,
  ]).slice()
  const hashedUncompressedPubkey = await crypto.subtle.digest(
    "SHA-256",
    uncompressedData,
  )

  // QE report is 384 bytes; report_data occupies the last 64 bytes (offset 320).
  // The attestation_public_key should be embedded in the first half.
  const reportData = signature.qe_report.subarray(320, 384)
  const reportDataEmbed = reportData.subarray(0, 32)

  return (
    bytesEqual(new Uint8Array(hashedPubkey), reportDataEmbed) ||
    bytesEqual(new Uint8Array(hashedUncompressedPubkey), reportDataEmbed)
  )
}

/**
 * Verify the attestation_public_key in an SGX quote signed the embedded quote.
 * Does not validate the certificate chain, QE report, CRLs, TCBs, etc.
 */
export async function verifySgxQuoteSignature(
  quoteInput: string | Uint8Array,
): Promise<boolean> {
  const quoteBytes =
    typeof quoteInput === "string" ? scureBase64.decode(quoteInput) : quoteInput

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
    ["verify"],
  )

  // Verify the signature
  return await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    rawSig,
    message.slice(),
  )
}

export async function _verifySgx(quote: Uint8Array, config?: VerifyConfig) {
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
  const parsedQuote = parseSgxQuote(quote)
  const { signature, header } = parsedQuote
  const certs = extractPemCertificates(signature.cert_data)
  let { status, root, fmspc, pcesvn } = await verifyPCKChain(
    certs,
    date ?? +new Date(),
    crls,
  )

  // Use fallback certs, only if certdata is not provided
  if (!root && certs.length === 0) {
    if (!extraCertdata) {
      throw new Error("verifySgx: missing certdata")
    }
    const fallback = await verifyPCKChain(
      extraCertdata,
      date ?? +new Date(),
      crls,
    )
    status = fallback.status
    root = fallback.root
    fmspc = fallback.fmspc
    pcesvn = fallback.pcesvn
  }

  return {
    status,
    root,
    fmspc,
    pcesvn,
    signature,
    header,
    extraCertdata,
    parsedQuote,
    pinnedRootCerts,
  }
}

/**
 * Verify a complete chain of trust for an SGX enclave, including the
 * Intel SGX Root CA, PCK certificate chain, and QE signature and binding.
 *
 * Optional: accepts `extraCertdata`, which is used if `quote` is missing certdata.
 */
export async function verifySgx(quote: Uint8Array, config?: VerifyConfig) {
  const {
    status,
    root,
    fmspc,
    pcesvn,
    signature,
    header,
    extraCertdata,
    parsedQuote,
    pinnedRootCerts,
  } = await _verifySgx(quote, config)

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
  const candidateRootHash = await computeCertSha256Hex(root)
  const knownRootHashes = new Set(
    await Promise.all(pinnedRootCerts.map(computeCertSha256Hex)),
  )
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
  if (signature.cert_data_type !== 5 && signature.cert_data_type !== 1) {
    throw new Error("verifySgx: only PCK cert_data is supported")
  }

  if (!(await verifySgxQeReportSignature(quote, extraCertdata))) {
    throw new Error("verifySgx: invalid qe report signature")
  }
  if (!(await verifySgxQeReportBinding(quote))) {
    throw new Error("verifySgx: invalid qe report binding")
  }
  if (!(await verifySgxQuoteSignature(quote))) {
    throw new Error("verifySgx: invalid signature over quote")
  }

  if (fmspc === null) {
    throw new Error("verifySgx: TCB missing fmspc")
  }

  // Log PCESVN from certificate extension
  if (pcesvn !== null) {
    console.log(`[verifySgx] PCK Certificate PCESVN: ${pcesvn}`)
  }

  if (
    config?.verifyTcb &&
    !(await config.verifyTcb({
      quote: parsedQuote,
      fmspc,
      cpuSvn: Array.from(parsedQuote.body.cpu_svn),
      pceSvn: parsedQuote.header.pce_svn,
    }))
  ) {
    // throw new Error("verifySgx: TCB invalid fmspc")
    return false
  }
  return true
}

export async function verifySgxBase64(quote: string, config?: VerifyConfig) {
  return await verifySgx(scureBase64.decode(quote), config)
}

export type SgxQuote = ReturnType<typeof parseSgxQuote>

export function isSgxQuote(quote: SgxQuote | TdxQuote): quote is SgxQuote {
  return quote.header.tee_type === 0
}
