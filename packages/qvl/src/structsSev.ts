import * as r from "restructure"

/**
 * AMD SEV-SNP Attestation Report structure
 *
 * Based on AMD SEV-SNP specification (SEV-SNP ABI specification, Table 21).
 * The report is 1184 bytes (0x4A0) total.
 *
 * COMPATIBILITY NOTES:
 * - This implementation targets SNP attestation reports (version 2+)
 * - Version 1 reports (original SEV) have a different structure and are NOT supported
 * - Version 2 (SNP) is the primary target
 * - The signature format uses ECDSA P-384 (r||s concatenated, 48+48=96 bytes each component)
 * - Report_data is 64 bytes (guest-provided data, similar to TDX/SGX)
 * - Measurement is 48 bytes (SHA-384 hash of initial guest memory)
 *
 * Key differences from Intel TDX/SGX:
 * - No quoting enclave - the AMD Secure Processor (AMD-SP) signs directly
 * - Certificate chain comes from AMD KDS (Key Distribution Service), not embedded
 * - Uses ECDSA P-384 instead of P-256
 * - TCB is encoded differently (as individual SVN values for each component)
 */

/**
 * SNP TCB Version structure (8 bytes)
 * Contains the Trusted Computing Base version information
 */
export type SevSnpTcbVersionType = {
  boot_loader: number // 1 byte: bootloader SVN
  tee: number // 1 byte: TEE (PSP OS) SVN
  reserved0: Uint8Array // 4 bytes: reserved, must be zero
  snp: number // 1 byte: SNP firmware SVN
  microcode: number // 1 byte: CPU microcode SVN
}

export const SevSnpTcbVersion = new r.Struct({
  boot_loader: r.uint8,
  tee: r.uint8,
  reserved0: new r.Buffer(4),
  snp: r.uint8,
  microcode: r.uint8,
})

/**
 * SEV-SNP Attestation Report Body structure
 * This is the main report body signed by the AMD-SP (672 bytes, 0x2A0)
 *
 * Version field meanings:
 * - 0: Reserved
 * - 1: SEV (original, launch-time only attestation) - NOT SUPPORTED
 * - 2+: SEV-SNP (runtime attestation) - SUPPORTED
 */
export type SevSnpReportBodyType = {
  version: number // 4 bytes: Version number of the report (must be >= 2 for SNP)
  guest_svn: number // 4 bytes: Guest SVN (security version number)
  policy: bigint // 8 bytes: Guest policy (parsed separately from policy_raw)
  policy_raw: Uint8Array // 8 bytes: Raw policy bytes
  family_id: Uint8Array // 16 bytes: Family ID of the guest
  image_id: Uint8Array // 16 bytes: Image ID of the guest
  vmpl: number // 4 bytes: VMPL (Virtual Machine Privilege Level) of the report
  signature_algo: number // 4 bytes: Signature algorithm (0 = ECDSA P-384)
  current_tcb: Uint8Array // 8 bytes: Current platform TCB version
  platform_info: bigint // 8 bytes: Platform info flags (parsed separately from platform_info_raw)
  platform_info_raw: Uint8Array // 8 bytes: Raw platform info bytes
  author_key_en: number // 4 bytes: Author key enabled flag
  reserved0: number // 4 bytes: Reserved, must be zero
  report_data: Uint8Array // 64 bytes: Guest-provided data
  measurement: Uint8Array // 48 bytes: SHA-384 hash of initial guest memory (launch digest)
  host_data: Uint8Array // 32 bytes: Host-provided data
  id_key_digest: Uint8Array // 48 bytes: SHA-384 digest of ID key
  author_key_digest: Uint8Array // 48 bytes: SHA-384 digest of author key
  report_id: Uint8Array // 32 bytes: Unique ID of this report
  report_id_ma: Uint8Array // 32 bytes: Report ID of the migration agent (if applicable)
  reported_tcb: Uint8Array // 8 bytes: Reported TCB version
  reserved1: Uint8Array // 24 bytes: Reserved
  chip_id: Uint8Array // 64 bytes: Chip ID (unique identifier for the AMD chip)
  committed_tcb: Uint8Array // 8 bytes: Committed TCB version
  current_build: number // 1 byte: Current build number
  current_minor: number // 1 byte: Current minor version
  current_major: number // 1 byte: Current major version
  reserved2: number // 1 byte: Reserved
  committed_build: number // 1 byte: Committed build number
  committed_minor: number // 1 byte: Committed minor version
  committed_major: number // 1 byte: Committed major version
  reserved3: number // 1 byte: Reserved
  launch_tcb: Uint8Array // 8 bytes: TCB version at launch
  reserved4: Uint8Array // 168 bytes: Reserved, must be zero
}

// Internal struct without bigint fields
const SevSnpReportBodyRaw = new r.Struct({
  version: r.uint32le,
  guest_svn: r.uint32le,
  policy_raw: new r.Buffer(8),
  family_id: new r.Buffer(16),
  image_id: new r.Buffer(16),
  vmpl: r.uint32le,
  signature_algo: r.uint32le,
  current_tcb: new r.Buffer(8),
  platform_info_raw: new r.Buffer(8),
  author_key_en: r.uint32le,
  reserved0: r.uint32le,
  report_data: new r.Buffer(64),
  measurement: new r.Buffer(48),
  host_data: new r.Buffer(32),
  id_key_digest: new r.Buffer(48),
  author_key_digest: new r.Buffer(48),
  report_id: new r.Buffer(32),
  report_id_ma: new r.Buffer(32),
  reported_tcb: new r.Buffer(8),
  reserved1: new r.Buffer(24),
  chip_id: new r.Buffer(64),
  committed_tcb: new r.Buffer(8),
  current_build: r.uint8,
  current_minor: r.uint8,
  current_major: r.uint8,
  reserved2: r.uint8,
  committed_build: r.uint8,
  committed_minor: r.uint8,
  committed_major: r.uint8,
  reserved3: r.uint8,
  launch_tcb: new r.Buffer(8),
  reserved4: new r.Buffer(168),
})

/** Read a little-endian uint64 as BigInt from a Uint8Array */
function readUint64LE(buf: Uint8Array): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset, 8)
  const low = view.getUint32(0, true)
  const high = view.getUint32(4, true)
  return (BigInt(high) << 32n) | BigInt(low)
}

export const SevSnpReportBody = {
  size: () => SEV_SNP_REPORT_BODY_SIZE,
  fromBuffer: (buf: Uint8Array): SevSnpReportBodyType => {
    const raw = SevSnpReportBodyRaw.fromBuffer(buf)
    return {
      ...raw,
      policy: readUint64LE(raw.policy_raw),
      platform_info: readUint64LE(raw.platform_info_raw),
    }
  },
}

/**
 * SEV-SNP ECDSA Signature structure (512 bytes)
 *
 * ECDSA P-384 signature components (r, s) are each 48 bytes in little-endian format.
 * Note: The signature is over the report body (first 672 bytes).
 *
 * COMPATIBILITY NOTE:
 * - Signature algorithm 0 = ECDSA P-384 with SHA-384 (the only currently defined algorithm)
 * - Future algorithms may be added; check signature_algo field in report body
 */
export type SevSnpSignatureType = {
  r: Uint8Array // 72 bytes: R component (48 bytes) + 24 bytes padding
  s: Uint8Array // 72 bytes: S component (48 bytes) + 24 bytes padding
  reserved: Uint8Array // 368 bytes: Reserved
}

export const SevSnpSignature = new r.Struct({
  r: new r.Buffer(72), // 48 bytes of actual R component + 24 reserved
  s: new r.Buffer(72), // 48 bytes of actual S component + 24 reserved
  reserved: new r.Buffer(368),
})

/**
 * Complete SEV-SNP Attestation Report (1184 bytes total)
 * Combines the report body and signature
 */
export type SevSnpReportType = {
  body: SevSnpReportBodyType
  signature: SevSnpSignatureType
}

/**
 * SEV-SNP Policy bit flags
 * These define the security requirements and capabilities of the guest
 */
export const SevSnpPolicyFlags = {
  SMT_ALLOWED: 1n << 16n, // Bit 16: SMT (Simultaneous Multi-Threading) allowed
  MIGRATE_MA: 1n << 18n, // Bit 18: Migration via migration agent allowed
  DEBUG_ALLOWED: 1n << 19n, // Bit 19: Debugging allowed (SECURITY: should be 0 in production)
  SINGLE_SOCKET: 1n << 20n, // Bit 20: Single socket mode required
  CXL_ALLOWED: 1n << 21n, // Bit 21: CXL (Compute Express Link) allowed
  MEM_AES_256_XTS: 1n << 22n, // Bit 22: Memory encryption with AES-256-XTS
  RAPL_DIS: 1n << 23n, // Bit 23: RAPL (Running Average Power Limit) disabled
  CIPHERTEXT_HIDING: 1n << 24n, // Bit 24: Ciphertext hiding enabled
} as const

/**
 * Platform Info bit flags
 */
export const SevSnpPlatformFlags = {
  SMT_ENABLED: 1n << 0n, // Bit 0: SMT is enabled on the platform
  TSME_ENABLED: 1n << 1n, // Bit 1: TSME (Transparent SME) is enabled
  ECC_ENABLED: 1n << 2n, // Bit 2: ECC memory is enabled
  RAPL_DIS: 1n << 3n, // Bit 3: RAPL is disabled
  CIPHERTEXT_HIDING: 1n << 4n, // Bit 4: Ciphertext hiding is enabled
} as const

/**
 * Signature algorithm values
 *
 * Note: AMD documentation has evolved over time. Older specs listed 0 as ECDSA P-384,
 * but current implementations use 1. We support both for compatibility.
 */
export const SevSnpSignatureAlgo = {
  ECDSA_P384_SHA384: 1, // ECDSA with P-384 curve and SHA-384 (current standard)
  ECDSA_P384_SHA384_LEGACY: 0, // Some early implementations may use 0
  // Future algorithms may be added here
} as const

/**
 * Helper to parse TCB version from 8-byte buffer
 */
export function parseTcbVersion(buf: Uint8Array): SevSnpTcbVersionType {
  return SevSnpTcbVersion.fromBuffer(buf)
}

/**
 * Helper to check if a policy has debug enabled (security check)
 */
export function isSevSnpDebugEnabled(policy: bigint): boolean {
  return (policy & SevSnpPolicyFlags.DEBUG_ALLOWED) !== 0n
}

/**
 * Get the minimum API version from policy (bits 0-7 = minor, bits 8-15 = major)
 */
export function getSevSnpPolicyApiVersion(policy: bigint): {
  major: number
  minor: number
} {
  return {
    minor: Number(policy & 0xffn),
    major: Number((policy >> 8n) & 0xffn),
  }
}

/**
 * Report body size constant (for signature verification)
 */
export const SEV_SNP_REPORT_BODY_SIZE = 672

/**
 * Full report size constant
 */
export const SEV_SNP_REPORT_SIZE = 1184
