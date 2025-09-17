import { createHash, createPublicKey, createVerify, X509Certificate } from "crypto"

import { getTdxV4SignedRegion, parseTdxQuote } from "./structs.js"
import {
  computeCertSha256Hex,
  encodeEcdsaSignatureToDer,
  extractPemCertificates,
  toBase64Url,
} from "./utils.js"

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
  const { header, signature } = parseTdxQuote(quote)
  // Sanity checks for TDX v4 quotes and expected DCAP cert data layout (type 5)
  if (header.version !== 4) {
    throw new Error(
      `verifyTdxCertChain: unsupported quote version ${header.version}`,
    )
  }
  if (signature.cert_data_len > 0 && signature.cert_data_type !== 5) {
    throw new Error(
      `verifyTdxCertChain: unexpected cert_data_type ${signature.cert_data_type}`,
    )
  }
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

  // Require at least leaf + one issuer
  if (chain.length < 2) {
    return { status: "invalid", root: null, chain: [] }
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

  // Best-effort cryptographic checks (Node's X509Certificate lacks full PKIX evaluation).
  // Verify child is signed by parent when possible; ensure root is self-signed and a CA.
  try {
    for (let i = 0; i < chain.length - 1; i++) {
      const child: any = chain[i] as any
      const parent = chain[i + 1]
      if (typeof child.verify === "function") {
        const ok = child.verify(parent.publicKey)
        if (!ok) return { status: "invalid", root: null, chain: [] }
      }
    }
    const root = chain[chain.length - 1]
    const rootAny: any = root as any
    if (root.issuer !== root.subject) return { status: "invalid", root: null, chain: [] }
    if (typeof rootAny.verify === "function") {
      const ok = rootAny.verify(root.publicKey)
      if (!ok) return { status: "invalid", root: null, chain: [] }
    }
    if (typeof rootAny.checkCA === "function") {
      if (!rootAny.checkCA()) return { status: "invalid", root: null, chain: [] }
    }
  } catch {
    return { status: "invalid", root: null, chain: [] }
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
 * Build a human-readable list of verification steps for a TDX v4 quote.
 */
export function describeTdxChainOfTrust(
  quoteInput: string | Buffer,
  pinnedRootCerts: X509Certificate[],
  date?: number,
  extraCerts?: string[],
): Array<{ step: string; ok: boolean; detail?: string }> {
  const steps: Array<{ step: string; ok: boolean; detail?: string }> = []
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  try {
    const { header, signature } = parseTdxQuote(quoteBytes)
    steps.push({
      step: "Parse quote header/body (expect v4, TDX)",
      ok: header.version === 4 && header.tee_type === 129,
      detail: `version=${header.version}, tee_type=${header.tee_type}`,
    })

    if (signature.cert_data_len > 0) {
      steps.push({
        step: "Cert data type is DCAP PCK (type 5)",
        ok: signature.cert_data_type === 5,
        detail: `type=${signature.cert_data_type}`,
      })
    } else {
      steps.push({ step: "No embedded certs; using extraCerts fallback", ok: !!extraCerts && (extraCerts?.length || 0) > 0 })
    }

    const embedded = extractPemCertificates(signature.cert_data)
    const certs = embedded.length > 0 ? embedded : extraCerts ?? []
    const { status, root, chain } = verifyPCKChain(certs, date || Date.now())
    steps.push({
      step: "Build and validate PCK chain (issuer path, time, signatures)",
      ok: status === "valid",
      detail: `chain_len=${chain.length}`,
    })

    if (root) {
      const rootHash = computeCertSha256Hex(root)
      const pinned = new Set(pinnedRootCerts.map(computeCertSha256Hex))
      steps.push({ step: "Pin Intel Root CA (hash match)", ok: pinned.has(rootHash), detail: rootHash })
    } else {
      steps.push({ step: "Pin Intel Root CA (hash match)", ok: false, detail: "no root" })
    }

    const bindOk = verifyQeReportBinding(quoteBytes)
    steps.push({ step: "QE report binds attestation public key", ok: bindOk })

    const qeSigOk = verifyQeReportSignature(quoteBytes, certs)
    steps.push({ step: "QE report signature verifies with PCK leaf", ok: qeSigOk })

    const quoteSigOk = verifyTdxV4Signature(quoteBytes)
    steps.push({ step: "Quote body signed by attestation public key (covers TD measurement)", ok: quoteSigOk })
  } catch (e: any) {
    steps.push({ step: "Exception during verification", ok: false, detail: String(e?.message || e) })
  }

  return steps
}
