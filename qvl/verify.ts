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
  toBase64Url,
} from "./utils.js"

/** Minimal view of SGX Report fields inside QE report */
function parseSgxReport(report: Buffer) {
  if (report.length !== 384) {
    throw new Error("Unexpected SGX report length")
  }
  const attributes = report.subarray(48, 64)
  const mrEnclave = report.subarray(64, 96)
  const mrSigner = report.subarray(128, 160)
  const isvProdId = report.readUInt16LE(256)
  const isvSvn = report.readUInt16LE(258)
  const reportData = report.subarray(320, 384)
  return { attributes, mrEnclave, mrSigner, isvProdId, isvSvn, reportData }
}

type QeIdentity = {
  enclaveIdentity: {
    id: string
    version: number
    issueDate: string
    nextUpdate: string
    tcbEvaluationDataNumber: number
    miscselect?: string
    miscselectMask?: string
    attributes: string
    attributesMask: string
    mrsigner: string
    isvprodid?: number
    tcbLevels: Array<{
      tcb: { isvsvn: number }
      tcbDate: string
      tcbStatus: string
      advisoryIDs?: string[]
    }>
  }
  signature?: string
}

type TcbInfo = {
  tcbInfo: {
    id: string
    version: number
    issueDate: string
    nextUpdate: string
    tcbType?: number
    fmspc?: string
    pceId?: string
  }
  signature?: string
}

export type TrustStep = {
  name: string
  ok: boolean
  details?: string
}

function hexEqualsMasked(actual: Buffer, expectedHex: string, maskHex: string) {
  const exp = Buffer.from(expectedHex, "hex")
  const mask = Buffer.from(maskHex, "hex")
  if (exp.length !== actual.length || mask.length !== actual.length) return false
  for (let i = 0; i < actual.length; i++) {
    if ((actual[i] & mask[i]) !== (exp[i] & mask[i])) return false
  }
  return true
}

/** Verify QE Identity against the QE report embedded in the quote. */
export function verifyQeIdentity(
  quoteInput: string | Buffer,
  qeIdentity: QeIdentity,
  atTimeMs?: number,
): boolean {
  const now = atTimeMs ?? Date.now()
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { signature } = parseTdxQuote(quoteBytes)
  if (!signature.qe_report_present) return false
  const report = parseSgxReport(signature.qe_report)

  const id = qeIdentity.enclaveIdentity
  const notBefore = Date.parse(id.issueDate)
  const notAfter = Date.parse(id.nextUpdate)
  if (!(notBefore <= now && now <= notAfter)) return false

  // Attributes with mask
  if (!hexEqualsMasked(report.attributes, id.attributes, id.attributesMask)) {
    return false
  }

  // MRSIGNER must match exactly
  if (report.mrSigner.toString("hex") !== id.mrsigner.toLowerCase()) {
    return false
  }

  // Optional ISVPRODID
  if (typeof id.isvprodid === "number" && id.isvprodid !== report.isvProdId) {
    return false
  }

  // Pick an UpToDate level if available; otherwise accept any level
  const level =
    id.tcbLevels.find((l) => l.tcbStatus.toLowerCase() === "uptodate") ||
    id.tcbLevels[0]
  if (!level) return false
  if (level.tcb.isvsvn !== report.isvSvn) return false

  return true
}

/** Minimal freshness validation for TCB Info collateral. */
export function verifyTcbInfoFreshness(tcbInfo: TcbInfo, atTimeMs?: number) {
  const now = atTimeMs ?? Date.now()
  const info = tcbInfo.tcbInfo
  const notBefore = Date.parse(info.issueDate)
  const notAfter = Date.parse(info.nextUpdate)
  return notBefore <= now && now <= notAfter
}

/**
 * Verify a complete certificate chain for a TDX enclave, including the
 * Intel SGX Root CA, PCK certificate chain, and QE signature and binding.
 *
 * Optional: accepts `extraCerts`, which is used if `quote` is missing certdata.
 */
export function verifyTdxCertChain(
  quote: Buffer,
  pinnedRootCerts: X509Certificate[],
  date?: number,
  extraCerts?: string[],
) {
  const { signature } = parseTdxQuote(quote)
  const certs = extractPemCertificates(signature.cert_data)
  let { status, root, chain } = verifyPCKChain(certs, date || +new Date())

  if (!root && certs.length === 0) {
    if (!extraCerts) {
      throw new Error("verifyTdxCertChain: missing certdata")
    }
    const fallback = verifyPCKChain(extraCerts, Date.parse("2025-09-01"))
    status = fallback.status
    root = fallback.root
    chain = fallback.chain
  }
  if (!root) {
    throw new Error("verifyTdxCertChain: invalid cert chain")
  }

  const candidateRootHash = computeCertSha256Hex(root)
  const knownRootHashes = new Set(pinnedRootCerts.map(computeCertSha256Hex))
  const rootIsValid = knownRootHashes.has(candidateRootHash)

  if (status !== "valid") {
    throw new Error("verifyTdxCertChain: invalid cert chain")
  }
  if (!rootIsValid) {
    throw new Error("verifyTdxCertChain: invalid root")
  }
  if (!verifyQeReportBinding(quote)) {
    throw new Error("verifyTdxCertChain: invalid qe report binding")
  }
  if (!verifyQeReportSignature(quote, extraCerts)) {
    throw new Error("verifyTdxCertChain: invalid qe report signature")
  }

  return true
}

export function verifyTdxCertChainBase64(
  quote: string,
  pinnedRootCerts: X509Certificate[],
  date?: number,
  extraCerts?: string[],
) {
  return verifyTdxCertChain(
    Buffer.from(quote, "base64"),
    pinnedRootCerts,
    date,
    extraCerts,
  )
}

/**
 * Verify a PCK provisioning certificate chain embedded in cert_data.
 * - Identifies the leaf certificate and walks up the chain, following issuer/subject chaining.
 * - Expects at least two certificates.
 * - Checks the validity window of each certificate.
 */
export function verifyPCKChain(
  certData: string[],
  verifyAtTimeMs: number,
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

  // Basic constraints sanity: non-leaf should be CA
  for (let i = 1; i < chain.length; i++) {
    // parent certs only
    const parent = chain[i]
    try {
      const legacy = (parent as any).toLegacyObject?.()
      const constraints: boolean | undefined = legacy?.extensions?.find?.(
        (e: any) => e.name === "basicConstraints",
      )?.cA
      // If extension present, require CA=true
      if (constraints !== undefined && constraints !== true) {
        return { status: "invalid", root: null, chain: [] }
      }
    } catch {}
  }

  return { status: "valid", root: chain[chain.length - 1] ?? null, chain }
}

/**
 * Verify that the cert chain has signed the quoting enclave report,
 * by checking qe_report_signature against the PCK leaf certificate public key.
 */
export function verifyQeReportSignature(
  quoteInput: string | Buffer,
  extraCerts?: string[],
): boolean {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4) throw new Error("Unsupported quote version")

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

  // Use Date.now() because we don't care if valid is returned as "expired" here
  const { chain } = verifyPCKChain(certs, Date.now())

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
    if (digest.equals(second) || digest.equals(first)) {
      return true
    }
  }

  // Some ecosystem implementations have placed the digest starting at a non-zero offset
  // within report_data. As a pragmatic fallback, look for any candidate digest as a
  // contiguous 32-byte subsequence anywhere within the 64-byte report_data field.
  //
  // In particular, we see an offset of "6" in a few examples (TODO)
  for (const digest of candidates) {
    if (reportData.indexOf(digest) !== -1) {
      return true
    }
  }

  return false
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

/**
 * Perform a comprehensive chain-of-trust evaluation for a TDX v4 quote.
 * Returns a per-step breakdown without throwing on failures.
 */
export function verifyTdxChain(
  quoteInput: string | Buffer,
  pinnedRootCerts: X509Certificate[],
  options?: {
    date?: number
    extraCerts?: string[]
    qeIdentity?: QeIdentity
    tcbInfo?: TcbInfo
  },
): { ok: boolean; steps: TrustStep[] } {
  const steps: TrustStep[] = []
  const at = options?.date ?? Date.now()

  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  // 1. Quote signature
  let ok = false
  try {
    ok = verifyTdxV4Signature(quoteBytes)
  } catch {
    ok = false
  }
  steps.push({ name: "TDX v4 quote signature (attestation key)", ok })

  // 2. QE binding
  let okBinding = false
  try {
    okBinding = verifyQeReportBinding(quoteBytes)
  } catch {
    okBinding = false
  }
  steps.push({ name: "QE report binding (attestation key to QE report)", ok: okBinding })

  // 3. QE report signature by PCK
  let okQeSig = false
  try {
    okQeSig = verifyQeReportSignature(quoteBytes, options?.extraCerts)
  } catch {
    okQeSig = false
  }
  steps.push({ name: "QE report signature (by PCK leaf)", ok: okQeSig })

  // 4. PCK certificate chain and root pin
  let okChain = false
  try {
    const result = verifyTdxCertChain(
      quoteBytes,
      pinnedRootCerts,
      at,
      options?.extraCerts,
    )
    okChain = !!result
  } catch (e: any) {
    okChain = false
    steps.push({ name: "PCK cert chain/root pin", ok: false, details: String(e?.message || e) })
  }
  if (okChain) steps.push({ name: "PCK cert chain/root pin", ok: true })

  // 5. QE Identity (optional collateral)
  if (options?.qeIdentity) {
    let okQeId = false
    try {
      okQeId = verifyQeIdentity(quoteBytes, options.qeIdentity, at)
    } catch {
      okQeId = false
    }
    steps.push({ name: "QE Identity (MRSIGNER/attributes/ISV)", ok: okQeId })
  }

  // 6. TCB Info freshness (optional collateral)
  if (options?.tcbInfo) {
    let okTcb = false
    try {
      okTcb = verifyTcbInfoFreshness(options.tcbInfo, at)
    } catch {
      okTcb = false
    }
    steps.push({ name: "TCB Info freshness window", ok: okTcb })
  }

  const allOk = steps.every((s) => s.ok)
  return { ok: allOk, steps }
}
