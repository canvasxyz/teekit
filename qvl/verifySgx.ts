import { ensureSubtle } from "./crypto.js"
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

const isNode = typeof process !== "undefined" && !!(process as any).versions?.node

export async function verifySgx(quote: Buffer, config?: VerifyConfig) {
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
  let { status, root } = await verifyPCKChain(certs, date ?? +new Date(), crls)

  // Use fallback certs, only if certdata is not provided
  if (!root && certs.length === 0) {
    if (!extraCertdata) {
      throw new Error("verifySgx: missing certdata")
    }
    const fallback = await verifyPCKChain(extraCertdata, date ?? +new Date(), crls)
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
  const candidateRootHash = await computeCertSha256Hex(root)
  const knownRootHashes = new Set(
    await Promise.all(pinnedRootCerts.map((c) => computeCertSha256Hex(c))),
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
  if (signature.cert_data_type !== 5) {
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

  return true
}

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

  const { chain } = await verifyPCKChain(certs, null)

  if (chain.length === 0) return false

  const pckLeafCert = chain[0]
  const derSignature = encodeEcdsaSignatureToDer(signature.qe_report_signature)

  try {
    const subtle = await ensureSubtle()
    const cryptoKey = await pckLeafCert.publicKey.export(
      { name: "ECDSA", namedCurve: "P-256" },
      ["verify"],
    )
    const ok = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      new Uint8Array(derSignature),
      new Uint8Array(signature.qe_report),
    )
    if (ok) return true
  } catch {
    // ignore
  }

  if (isNode) {
    try {
      const { createVerify } = await import("node:crypto")
      const v = createVerify("sha256")
      v.update(signature.qe_report)
      v.end()
      if (v.verify(pckLeafCert.publicKey.toString("pem"), derSignature)) return true
    } catch {
      // ignore
    }
  }

  return false
}

export async function verifySgxQeReportBinding(
  quoteInput: string | Buffer,
): Promise<boolean> {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseSgxQuote(quoteBytes)
  if (header.version !== 3) throw new Error("Unsupported quote version")
  if (!signature.qe_report_present) throw new Error("Missing QE report")

  const subtle = await ensureSubtle()
  const hashedPubkeyBuf = Buffer.concat([
    signature.attestation_public_key,
    signature.qe_auth_data,
  ])
  const hashedPubkey = Buffer.from(
    new Uint8Array(await subtle.digest("SHA-256", hashedPubkeyBuf)),
  )
  const hashedUncompressedInput = Buffer.concat([
    Buffer.from([0x04]),
    signature.attestation_public_key,
    signature.qe_auth_data,
  ])
  const hashedUncompressedPubkey = Buffer.from(
    new Uint8Array(await subtle.digest("SHA-256", hashedUncompressedInput)),
  )

  // QE report is 384 bytes; report_data occupies the last 64 bytes (offset 320).
  // The attestation_public_key should be embedded in the first half.
  const reportData = signature.qe_report.subarray(320, 384)
  const reportDataEmbed = reportData.subarray(0, 32)

  return (
    hashedPubkey.equals(reportDataEmbed) ||
    hashedUncompressedPubkey.equals(reportDataEmbed)
  )
}

export async function verifySgxQuoteSignature(
  quoteInput: string | Buffer,
): Promise<boolean> {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseSgxQuote(quoteBytes)
  if (header.version !== 3) throw new Error(`Unsupported quote version`)

  const message = getSgxSignedRegion(quoteBytes)
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

  const subtle = await ensureSubtle()
  const publicKey = await subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  )
  try {
    const ok = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      new Uint8Array(derSig),
      new Uint8Array(message),
    )
    if (ok) return true
  } catch {
    // ignore
  }

  if (isNode) {
    try {
      const { createPublicKey, createVerify } = await import("node:crypto")
      const nodePub = createPublicKey({ key: jwk as any, format: "jwk" as any })
      const v = createVerify("sha256")
      v.update(message)
      v.end()
      if (v.verify(nodePub, derSig)) return true
    } catch {
      // ignore
    }
  }

  return false
}

export function verifySgxBase64(quote: string, config?: VerifyConfig) {
  return verifySgx(Buffer.from(quote, "base64"), config)
}
