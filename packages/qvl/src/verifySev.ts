import {
  SevSnpPolicyFlags,
  SevSnpSignatureAlgo,
  isSevSnpDebugEnabled,
  parseTcbVersion,
} from "./structsSev.js"
import {
  parseSevSnpReport,
  getSevSnpSignedRegion,
  getSevSnpRawSignature,
  SevSnpReport,
} from "./parseSev.js"
import {
  hex,
  computeCertSha256Hex,
  normalizeSerialHex,
  parseCrlRevokedSerials,
} from "./utils.js"
import { QV_X509Certificate, BasicConstraintsExtension } from "./x509.js"
import { DEFAULT_AMD_ARK_CERTS } from "./rootCaSev.js"
import { base64 as scureBase64 } from "@scure/base"
import type { Awaitable } from "./utils.js"

/**
 * Configuration for verifying SEV-SNP measurements.
 * All specified fields must match (AND logic).
 * Fields set to undefined are not verified.
 */
export interface SevSnpMeasurements {
  /** Launch measurement - SHA-384 hash of initial guest memory (48 bytes hex) */
  measurement?: string
  /** Guest-provided report data (64 bytes hex) */
  reportData?: string
  /** Host-provided data (32 bytes hex) */
  hostData?: string
  /** Family ID (16 bytes hex) */
  familyId?: string
  /** Image ID (16 bytes hex) */
  imageId?: string
}

export type SevSnpMeasurementVerifier = (
  report: SevSnpReport,
) => Awaitable<boolean>

/**
 * Measurement verification configuration.
 * - Single SevSnpMeasurements: all specified fields must match
 * - Array of SevSnpMeasurements: ANY set can match
 * - SevSnpMeasurementVerifier: custom callback
 * - Array mixing both: ANY can match
 */
export type SevSnpMeasurementConfig =
  | SevSnpMeasurements
  | SevSnpMeasurements[]
  | SevSnpMeasurementVerifier
  | (SevSnpMeasurements | SevSnpMeasurementVerifier)[]

/**
 * Configuration for SEV-SNP verification.
 *
 * COMPATIBILITY NOTE:
 * Unlike Intel TDX/SGX, SEV-SNP does not embed certificates in the report.
 * The certificate chain (ARK -> ASK -> VCEK) must be obtained separately
 * from AMD's Key Distribution Service (KDS) using the chip_id from the report.
 *
 * For full verification, you need:
 * 1. The attestation report (parsed here)
 * 2. The VCEK certificate (from AMD KDS, keyed by chip_id + TCB)
 * 3. The certificate chain (ARK -> ASK) from AMD
 *
 * This implementation provides:
 * - Report parsing and field extraction
 * - Measurement verification
 * - Policy validation
 * - Signature verification (if VCEK public key is provided)
 *
 * It does NOT handle:
 * - Fetching certificates from AMD KDS (must be done externally)
 * - Certificate chain validation (must be done externally)
 * - TCB evaluation against AMD's TCB info (must be done externally)
 */
export interface SevSnpVerifyConfig {
  /**
   * VCEK certificate for signature verification.
   * Can be a QV_X509Certificate instance or PEM string.
   *
   * The VCEK can be obtained from AMD KDS at:
   * https://kdsintf.amd.com/vcek/v1/{product_name}/{chip_id}?blSPL={bl}&teeSPL={tee}&snpSPL={snp}&ucodeSPL={ucode}
   *
   * The chip_id and TCB values are in the report body.
   */
  vcekCert?: QV_X509Certificate | string

  /**
   * ASK (AMD SEV Key) certificate in the chain.
   * Can be a QV_X509Certificate instance or PEM string.
   * Required for full certificate chain verification.
   */
  askCert?: QV_X509Certificate | string

  /**
   * ARK (AMD Root Key) certificate.
   * Can be a QV_X509Certificate instance or PEM string.
   * If not provided, will attempt to use pinnedArkCerts.
   */
  arkCert?: QV_X509Certificate | string

  /**
   * Pinned AMD root certificates for validation.
   * If provided, the ARK certificate must match one of these.
   * Defaults to DEFAULT_AMD_ARK_CERTS.
   */
  pinnedArkCerts?: QV_X509Certificate[]

  /**
   * Certificate Revocation Lists (CRLs) for chain validation.
   * DER-encoded CRL bytes.
   */
  crls?: Uint8Array[]

  /**
   * Verification time in milliseconds since epoch.
   * Defaults to current time. Set to null to skip time validation.
   */
  date?: number | null

  /**
   * VCEK public key in SPKI format for signature verification.
   * @deprecated Use vcekCert instead for full chain verification.
   * If vcekCert is provided, this is ignored.
   */
  vcekPublicKey?: CryptoKey | Uint8Array

  /** Optional measurement verification */
  verifyMeasurements?: SevSnpMeasurementConfig

  /**
   * Allow debug-enabled guests (policy.DEBUG_ALLOWED = 1).
   * Default: false (reject debug-enabled guests)
   *
   * SECURITY WARNING: Debug-enabled guests can have their memory inspected
   * by the hypervisor. Never allow this in production attestation.
   */
  allowDebug?: boolean

  /**
   * Minimum required VMPL level. Default: undefined (no check)
   * VMPL 0 is most privileged, VMPL 3 is least privileged.
   * Reports should typically come from VMPL 0 for maximum security.
   */
  maxVmpl?: number

  /**
   * Verify that SMT is not enabled if policy forbids it.
   * Default: true
   */
  enforceSmtPolicy?: boolean

  /**
   * Custom TCB verification callback.
   * If provided, called with the report for custom TCB checks.
   */
  verifyTcb?: (report: SevSnpReport) => Awaitable<boolean>
}

/**
 * Result of SEV-SNP report verification
 */
export interface SevSnpVerifyResult {
  /** Whether verification passed */
  valid: boolean
  /** The parsed report */
  report: SevSnpReport
  /** Error message if verification failed */
  error?: string
}

/**
 * Check if a measurement config item is a function
 */
function isMeasurementVerifier(
  item: SevSnpMeasurements | SevSnpMeasurementVerifier,
): item is SevSnpMeasurementVerifier {
  return typeof item === "function"
}

/**
 * Verify that a single SevSnpMeasurements config matches the report.
 */
function matchesMeasurements(
  report: SevSnpReport,
  config: SevSnpMeasurements,
): boolean {
  const body = report.body

  if (config.measurement !== undefined) {
    if (hex(body.measurement) !== config.measurement.toLowerCase()) return false
  }
  if (config.reportData !== undefined) {
    if (hex(body.report_data) !== config.reportData.toLowerCase()) return false
  }
  if (config.hostData !== undefined) {
    if (hex(body.host_data) !== config.hostData.toLowerCase()) return false
  }
  if (config.familyId !== undefined) {
    if (hex(body.family_id) !== config.familyId.toLowerCase()) return false
  }
  if (config.imageId !== undefined) {
    if (hex(body.image_id) !== config.imageId.toLowerCase()) return false
  }

  return true
}

/**
 * Verify SEV-SNP measurements according to configuration.
 */
export async function verifySevSnpMeasurements(
  report: SevSnpReport,
  config: SevSnpMeasurementConfig,
): Promise<boolean> {
  // Handle single object or function
  if (!Array.isArray(config)) {
    if (isMeasurementVerifier(config)) {
      return await config(report)
    }
    return matchesMeasurements(report, config)
  }

  // Handle array: OR logic - any must match
  for (const item of config) {
    if (isMeasurementVerifier(item)) {
      if (await item(report)) return true
    } else {
      if (matchesMeasurements(report, item)) return true
    }
  }

  return false
}

/**
 * Result of certificate chain verification
 */
export interface SevSnpCertChainResult {
  /** Whether the chain is valid */
  status: "valid" | "invalid" | "expired" | "revoked"
  /** The verified ARK certificate (if found) */
  ark: QV_X509Certificate | null
  /** The complete verified chain */
  chain: QV_X509Certificate[]
}

/**
 * Verify the SEV-SNP certificate chain (ARK -> ASK -> VCEK).
 *
 * This verifies:
 * 1. Certificate chain integrity (VCEK signed by ASK, ASK signed by ARK)
 * 2. Certificate validity periods
 * 3. BasicConstraints CA flags
 * 4. CRL revocation status (if CRLs provided)
 *
 * @param vcekCert - VCEK certificate
 * @param askCert - ASK (AMD SEV Key) certificate
 * @param arkCert - ARK (AMD Root Key) certificate (optional)
 * @param verifyAtTimeMs - Time to verify validity at (ms since epoch), null to skip
 * @param crls - Optional CRLs to check for revocation
 * @returns Chain verification result
 */
export async function verifySevSnpCertChain(
  vcekCert: QV_X509Certificate,
  askCert: QV_X509Certificate,
  arkCert?: QV_X509Certificate,
  verifyAtTimeMs?: number | null,
  crls?: Uint8Array[],
): Promise<SevSnpCertChainResult> {
  const chain: QV_X509Certificate[] = [vcekCert, askCert]
  if (arkCert) {
    chain.push(arkCert)
  }

  // Verify chaining: VCEK issued by ASK
  if (vcekCert.issuer !== askCert.subject) {
    return {
      status: "invalid",
      ark: null,
      chain: [],
    }
  }

  // Verify chaining: ASK issued by ARK (if ARK provided)
  if (arkCert && askCert.issuer !== arkCert.subject) {
    return {
      status: "invalid",
      ark: null,
      chain: [],
    }
  }

  // Check validity windows
  if (verifyAtTimeMs !== null && verifyAtTimeMs !== undefined) {
    for (const cert of chain) {
      const notBefore = cert.notBefore.getTime()
      const notAfter = cert.notAfter.getTime()
      if (!(notBefore <= verifyAtTimeMs && verifyAtTimeMs <= notAfter)) {
        return {
          status: "expired",
          ark: arkCert ?? null,
          chain,
        }
      }
    }
  }

  // Verify signatures
  try {
    // VCEK signed by ASK
    const vcekValid = await vcekCert.verify(askCert)
    if (!vcekValid) {
      return {
        status: "invalid",
        ark: null,
        chain: [],
      }
    }

    // ASK signed by ARK (if ARK provided)
    if (arkCert) {
      const askValid = await askCert.verify(arkCert)
      if (!askValid) {
        return {
          status: "invalid",
          ark: null,
          chain: [],
        }
      }

      // ARK should be self-signed
      const arkValid = await arkCert.verify(arkCert)
      if (!arkValid) {
        return {
          status: "invalid",
          ark: null,
          chain: [],
        }
      }
    }
  } catch {
    return {
      status: "invalid",
      ark: null,
      chain: [],
    }
  }

  // Check BasicConstraints - ASK should be a CA
  const askBc = askCert.getExtension(BasicConstraintsExtension)
  if (!askBc || !askBc.ca) {
    return {
      status: "invalid",
      ark: null,
      chain: [],
    }
  }

  // Check BasicConstraints - ARK should be a CA (if provided)
  if (arkCert) {
    const arkBc = arkCert.getExtension(BasicConstraintsExtension)
    if (!arkBc || !arkBc.ca) {
      return {
        status: "invalid",
        ark: null,
        chain: [],
      }
    }
  }

  // CRL checking
  if (crls && crls.length > 0) {
    const revoked = new Set<string>()
    for (const crl of crls) {
      const serials = parseCrlRevokedSerials(crl)
      for (const s of serials) revoked.add(s)
    }
    if (revoked.size > 0) {
      for (const cert of chain) {
        const serial = normalizeSerialHex(cert.serialNumber)
        if (revoked.has(serial)) {
          return {
            status: "revoked",
            ark: arkCert ?? null,
            chain: [],
          }
        }
      }
    }
  }

  return {
    status: "valid",
    ark: arkCert ?? null,
    chain,
  }
}

/**
 * Verify the ECDSA P-384 signature on a SEV-SNP report.
 *
 * @param report - The raw report bytes
 * @param parsedReport - The parsed report (for signature extraction)
 * @param vcekPublicKey - VCEK public key (CryptoKey or SPKI bytes)
 * @returns true if signature is valid
 */
export async function verifySevSnpSignature(
  report: Uint8Array,
  parsedReport: SevSnpReport,
  vcekPublicKey: CryptoKey | Uint8Array,
): Promise<boolean> {
  // Check signature algorithm
  // Accept both 0 (legacy) and 1 (current) for ECDSA P-384 with SHA-384
  const algo = parsedReport.body.signature_algo
  if (
    algo !== SevSnpSignatureAlgo.ECDSA_P384_SHA384 &&
    algo !== SevSnpSignatureAlgo.ECDSA_P384_SHA384_LEGACY
  ) {
    throw new Error(
      `verifySevSnpSignature: Unsupported signature algorithm ${algo}. ` +
        `Only ECDSA P-384 with SHA-384 (algo=0 or 1) is supported.`,
    )
  }

  // Import key if needed
  let publicKey: CryptoKey
  if (vcekPublicKey instanceof Uint8Array) {
    publicKey = await crypto.subtle.importKey(
      "spki",
      vcekPublicKey.slice(),
      { name: "ECDSA", namedCurve: "P-384" },
      false,
      ["verify"],
    )
  } else {
    publicKey = vcekPublicKey
  }

  // Get the signed region (report body) and signature
  const signedData = getSevSnpSignedRegion(report)
  const signature = getSevSnpRawSignature(parsedReport.signature)

  // Verify with SHA-384
  return await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-384" },
    publicKey,
    signature.slice(),
    signedData.slice(),
  )
}

/**
 * Parse and perform basic validation on a SEV-SNP attestation report.
 * This does NOT verify the signature (VCEK required) or fetch certificates.
 *
 * @param report - Raw attestation report bytes
 * @param config - Verification configuration
 * @returns Verification result
 */
export async function _verifySevSnp(
  report: Uint8Array,
  config?: SevSnpVerifyConfig,
): Promise<SevSnpVerifyResult> {
  // Parse the report
  let parsedReport: SevSnpReport
  try {
    parsedReport = parseSevSnpReport(report)
  } catch (e) {
    return {
      valid: false,
      report: null as unknown as SevSnpReport,
      error: `Failed to parse report: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const body = parsedReport.body

  // Check debug policy
  if (!config?.allowDebug && isSevSnpDebugEnabled(body.policy)) {
    return {
      valid: false,
      report: parsedReport,
      error:
        "verifySevSnp: Debug-enabled guest detected. Debug guests are insecure and rejected by default.",
    }
  }

  // Check VMPL level
  if (config?.maxVmpl !== undefined && body.vmpl > config.maxVmpl) {
    return {
      valid: false,
      report: parsedReport,
      error: `verifySevSnp: VMPL ${body.vmpl} exceeds maximum allowed ${config.maxVmpl}`,
    }
  }

  // Check SMT policy enforcement
  if (config?.enforceSmtPolicy !== false) {
    const smtAllowedByPolicy =
      (body.policy & SevSnpPolicyFlags.SMT_ALLOWED) !== 0n
    // Platform info bit 0 indicates if SMT is enabled
    const smtEnabledOnPlatform = (body.platform_info & 1n) !== 0n

    if (!smtAllowedByPolicy && smtEnabledOnPlatform) {
      return {
        valid: false,
        report: parsedReport,
        error:
          "verifySevSnp: SMT is enabled on platform but policy forbids it",
      }
    }
  }

  // Certificate chain and signature verification
  if (config?.vcekCert) {
    // Parse certificates
    const vcekCert =
      typeof config.vcekCert === "string"
        ? new QV_X509Certificate(config.vcekCert)
        : config.vcekCert

    const askCert = config.askCert
      ? typeof config.askCert === "string"
        ? new QV_X509Certificate(config.askCert)
        : config.askCert
      : null

    const arkCert = config.arkCert
      ? typeof config.arkCert === "string"
        ? new QV_X509Certificate(config.arkCert)
        : config.arkCert
      : null

    // Verify certificate chain if ASK provided
    if (askCert) {
      const chainResult = await verifySevSnpCertChain(
        vcekCert,
        askCert,
        arkCert ?? undefined,
        config.date ?? Date.now(),
        config.crls,
      )

      if (chainResult.status === "expired") {
        return {
          valid: false,
          report: parsedReport,
          error: "verifySevSnp: Certificate chain expired or not yet valid",
        }
      }
      if (chainResult.status === "revoked") {
        return {
          valid: false,
          report: parsedReport,
          error: "verifySevSnp: Certificate in chain has been revoked",
        }
      }
      if (chainResult.status !== "valid") {
        return {
          valid: false,
          report: parsedReport,
          error: "verifySevSnp: Invalid certificate chain",
        }
      }

      // Check against pinned ARK certificates
      const pinnedArkCerts = config.pinnedArkCerts ?? DEFAULT_AMD_ARK_CERTS
      if (pinnedArkCerts.length > 0 && chainResult.ark) {
        const candidateArkHash = await computeCertSha256Hex(chainResult.ark)
        const knownArkHashes = new Set(
          await Promise.all(pinnedArkCerts.map(computeCertSha256Hex)),
        )
        if (!knownArkHashes.has(candidateArkHash)) {
          return {
            valid: false,
            report: parsedReport,
            error: "verifySevSnp: ARK certificate does not match any pinned root",
          }
        }
      }
    }

    // Verify report signature using VCEK public key
    try {
      const sigValid = await verifySevSnpSignature(
        report,
        parsedReport,
        new Uint8Array(vcekCert.publicKey.rawData),
      )
      if (!sigValid) {
        return {
          valid: false,
          report: parsedReport,
          error: "verifySevSnp: Invalid report signature",
        }
      }
    } catch (e) {
      return {
        valid: false,
        report: parsedReport,
        error: `verifySevSnp: Signature verification failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  } else if (config?.vcekPublicKey) {
    // Legacy: direct public key verification (deprecated)
    try {
      const sigValid = await verifySevSnpSignature(
        report,
        parsedReport,
        config.vcekPublicKey,
      )
      if (!sigValid) {
        return {
          valid: false,
          report: parsedReport,
          error: "verifySevSnp: Invalid signature",
        }
      }
    } catch (e) {
      return {
        valid: false,
        report: parsedReport,
        error: `verifySevSnp: Signature verification failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  // Verify measurements if configured
  if (config?.verifyMeasurements !== undefined) {
    const measurementsValid = await verifySevSnpMeasurements(
      parsedReport,
      config.verifyMeasurements,
    )
    if (!measurementsValid) {
      return {
        valid: false,
        report: parsedReport,
        error: "verifySevSnp: Measurement verification failed",
      }
    }
  }

  // Custom TCB verification
  if (config?.verifyTcb) {
    const tcbValid = await config.verifyTcb(parsedReport)
    if (!tcbValid) {
      return {
        valid: false,
        report: parsedReport,
        error: "verifySevSnp: TCB verification failed",
      }
    }
  }

  return {
    valid: true,
    report: parsedReport,
  }
}

/**
 * Verify a SEV-SNP attestation report.
 *
 * This function:
 * 1. Parses the attestation report
 * 2. Validates security policies (debug, VMPL, SMT)
 * 3. Verifies the signature (if VCEK provided)
 * 4. Checks measurements (if configured)
 *
 * IMPORTANT: For production use, you should:
 * 1. Obtain the VCEK certificate from AMD KDS using chip_id + TCB from report
 * 2. Validate the certificate chain (ARK -> ASK -> VCEK)
 * 3. Provide the VCEK public key to this function
 * 4. Implement custom TCB verification against AMD's published TCB info
 *
 * @param report - Raw attestation report bytes
 * @param config - Verification configuration
 * @throws Error if verification fails
 * @returns true if verification passes
 */
export async function verifySevSnp(
  report: Uint8Array,
  config?: SevSnpVerifyConfig,
): Promise<boolean> {
  const result = await _verifySevSnp(report, config)
  if (!result.valid) {
    throw new Error(result.error ?? "verifySevSnp: Verification failed")
  }
  return true
}

/**
 * Verify a SEV-SNP attestation report from base64.
 */
export async function verifySevSnpBase64(
  reportBase64: string,
  config?: SevSnpVerifyConfig,
): Promise<boolean> {
  return verifySevSnp(scureBase64.decode(reportBase64), config)
}

/**
 * Type alias for parsed SEV-SNP report
 */
export type { SevSnpReport }

/**
 * Helper to check if a policy requires single socket mode
 */
export function isSingleSocketRequired(policy: bigint): boolean {
  return (policy & SevSnpPolicyFlags.SINGLE_SOCKET) !== 0n
}

/**
 * Helper to check if migration is allowed
 */
export function isMigrationAllowed(policy: bigint): boolean {
  return (policy & SevSnpPolicyFlags.MIGRATE_MA) !== 0n
}

/**
 * Extract human-readable TCB info from report
 */
export function getSevSnpTcbInfo(report: SevSnpReport): {
  currentTcb: {
    bootLoader: number
    tee: number
    snp: number
    microcode: number
  }
  reportedTcb: {
    bootLoader: number
    tee: number
    snp: number
    microcode: number
  }
  launchTcb: {
    bootLoader: number
    tee: number
    snp: number
    microcode: number
  }
  committedTcb: {
    bootLoader: number
    tee: number
    snp: number
    microcode: number
  }
  currentVersion: {
    major: number
    minor: number
    build: number
  }
  committedVersion: {
    major: number
    minor: number
    build: number
  }
} {
  const body = report.body

  const parseTcb = (buf: Uint8Array) => {
    const tcb = parseTcbVersion(buf)
    return {
      bootLoader: tcb.boot_loader,
      tee: tcb.tee,
      snp: tcb.snp,
      microcode: tcb.microcode,
    }
  }

  return {
    currentTcb: parseTcb(body.current_tcb),
    reportedTcb: parseTcb(body.reported_tcb),
    launchTcb: parseTcb(body.launch_tcb),
    committedTcb: parseTcb(body.committed_tcb),
    currentVersion: {
      major: body.current_major,
      minor: body.current_minor,
      build: body.current_build,
    },
    committedVersion: {
      major: body.committed_major,
      minor: body.committed_minor,
      build: body.committed_build,
    },
  }
}

