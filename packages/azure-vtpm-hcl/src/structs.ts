/**
 * Azure vTPM HCL (Host Compatibility Layer) Report Structure Definitions
 *
 * The HCL report is a binary structure returned by Azure's vTPM that contains:
 * - An attestation header with metadata
 * - A hardware report (TDX TD Report in our case)
 * - HCL data including the vTPM Attestation Key (AK)
 *
 * Structure based on:
 * https://github.com/kinvolk/azure-cvm-tooling/blob/main/az-cvm-vtpm/src/hcl/mod.rs
 */

// ============================================================================
// Constants
// ============================================================================

/** Report type identifier for Intel TDX */
export const TDX_REPORT_TYPE = 4

/** Report type identifier for AMD SEV-SNP (not supported in this package) */
export const SNP_REPORT_TYPE = 2

/**
 * Size of hardware report in bytes.
 * In the HCL report, both SNP and TDX use 1184 bytes for the hw_report field.
 * The actual TDX TD Report is 1024 bytes, but the HCL structure pads it.
 */
export const HW_REPORT_SIZE = 1184

/** Size of the actual TDX TD Report structure (1024 bytes) */
export const TD_REPORT_SIZE = 1024

/** Key ID for the vTPM Attestation Key in runtime claims */
export const HCL_AKPUB_KEY_ID = "HCLAkPub"

// ============================================================================
// Attestation Header (28 bytes)
// ============================================================================

export interface AttestationHeader {
  /** Magic signature identifying this as an attestation report */
  signature: number // u32, 4 bytes
  /** Version of the attestation report format */
  version: number // u32, 4 bytes
  /** Size of the report in bytes */
  reportSize: number // u32, 4 bytes
  /** Type of attestation request */
  requestType: number // u32, 4 bytes
  /** Status code */
  status: number // u32, 4 bytes
  /** Reserved bytes */
  reserved: Uint8Array // [u32; 3], 12 bytes
}

export const ATTESTATION_HEADER_SIZE = 32

export function parseAttestationHeader(
  data: Uint8Array,
  offset: number = 0,
): AttestationHeader {
  const view = new DataView(data.buffer, data.byteOffset + offset)

  return {
    signature: view.getUint32(0, true),
    version: view.getUint32(4, true),
    reportSize: view.getUint32(8, true),
    requestType: view.getUint32(12, true),
    status: view.getUint32(16, true),
    reserved: data.slice(offset + 20, offset + 32),
  }
}

// ============================================================================
// IGVM Request Data (variable size, 20 bytes fixed + variable_data)
// ============================================================================

/** Hash algorithm types for IGVM */
export enum IgvmHashType {
  Invalid = 0,
  Sha256 = 1,
  Sha384 = 2,
  Sha512 = 3,
}

export interface IgvmRequestData {
  /** Size of the data section */
  dataSize: number // u32, 4 bytes
  /** Version of the IGVM request format */
  version: number // u32, 4 bytes
  /** Type of report (4 = TDX, 2 = SNP) */
  reportType: number // u32, 4 bytes
  /** Hash algorithm used for report data */
  reportDataHashType: IgvmHashType // u32, 4 bytes
  /** Size of the variable data section */
  variableDataSize: number // u32, 4 bytes
  /** Variable data (contains runtime claims with AK) */
  variableData: Uint8Array
}

export const IGVM_REQUEST_DATA_FIXED_SIZE = 20

export function parseIgvmRequestData(
  data: Uint8Array,
  offset: number = 0,
): IgvmRequestData {
  const view = new DataView(data.buffer, data.byteOffset + offset)

  const dataSize = view.getUint32(0, true)
  const version = view.getUint32(4, true)
  const reportType = view.getUint32(8, true)
  const reportDataHashType = view.getUint32(12, true) as IgvmHashType
  const variableDataSize = view.getUint32(16, true)

  const variableDataStart = offset + IGVM_REQUEST_DATA_FIXED_SIZE
  const variableData = data.slice(
    variableDataStart,
    variableDataStart + variableDataSize,
  )

  return {
    dataSize,
    version,
    reportType,
    reportDataHashType,
    variableDataSize,
    variableData,
  }
}

// ============================================================================
// TDX TD Report (1024 bytes)
// ============================================================================

/**
 * TD Report structure as defined by Intel TDX.
 *
 * The TD Report contains:
 * - REPORTMACSTRUCT (256 bytes): Header with report_data
 * - TEE_TCB_INFO (240 bytes): TCB information
 * - TD_INFO (512 bytes): TD-specific measurements
 */
export interface TdReport {
  /** Full 1024-byte TD Report */
  raw: Uint8Array

  // REPORTMACSTRUCT fields (first 256 bytes)
  /** Report type (0x81 for TDX) */
  reportType: Uint8Array // 8 bytes, offset 0
  /** Reserved */
  reserved0: Uint8Array // 8 bytes, offset 8
  /** CPU SVN */
  cpuSvn: Uint8Array // 16 bytes, offset 16
  /** TEE TCB info hash */
  teeTcbInfoHash: Uint8Array // 48 bytes, offset 32
  /** TEE info hash */
  teeInfoHash: Uint8Array // 48 bytes, offset 80
  /** User-provided report data (64 bytes) */
  reportData: Uint8Array // 64 bytes, offset 128
  /** Reserved */
  reserved1: Uint8Array // 32 bytes, offset 192
  /** MAC protecting the report */
  mac: Uint8Array // 32 bytes, offset 224

  // TEE_TCB_INFO fields (next 240 bytes, offset 256)
  /** Valid fields indicator */
  teeTcbValid: Uint8Array // 8 bytes, offset 256
  /** TEE TCB SVN */
  teeTcbSvn: Uint8Array // 16 bytes, offset 264
  /** MRSEAM - Measurement of SEAM module */
  mrSeam: Uint8Array // 48 bytes, offset 280
  /** MRSIGNERSEAM - Signer of SEAM module */
  mrSignerSeam: Uint8Array // 48 bytes, offset 328
  /** SEAM attributes */
  seamAttributes: Uint8Array // 8 bytes, offset 376
  /** Reserved in TEE_TCB_INFO */
  teeTcbReserved: Uint8Array // 112 bytes, offset 384

  // TD_INFO fields (last 512 bytes, offset 496)
  /** TD attributes */
  tdAttributes: Uint8Array // 8 bytes, offset 496
  /** XFAM */
  xfam: Uint8Array // 8 bytes, offset 504
  /** MRTD - Measurement of initial TD contents */
  mrTd: Uint8Array // 48 bytes, offset 512
  /** MRCONFIGID - Software-defined configuration ID */
  mrConfigId: Uint8Array // 48 bytes, offset 560
  /** MROWNER - Software-defined owner ID */
  mrOwner: Uint8Array // 48 bytes, offset 608
  /** MROWNERCONFIG - Software-defined owner config */
  mrOwnerConfig: Uint8Array // 48 bytes, offset 656
  /** RTMR0 - Runtime measurement register 0 */
  rtmr0: Uint8Array // 48 bytes, offset 704
  /** RTMR1 - Runtime measurement register 1 */
  rtmr1: Uint8Array // 48 bytes, offset 752
  /** RTMR2 - Runtime measurement register 2 */
  rtmr2: Uint8Array // 48 bytes, offset 800
  /** RTMR3 - Runtime measurement register 3 */
  rtmr3: Uint8Array // 48 bytes, offset 848
  /** Reserved in TD_INFO */
  tdInfoReserved: Uint8Array // 128 bytes, offset 896
}

export function parseTdReport(data: Uint8Array, offset: number = 0): TdReport {
  const raw = data.slice(offset, offset + TD_REPORT_SIZE)

  return {
    raw,

    // REPORTMACSTRUCT (256 bytes)
    reportType: raw.slice(0, 8),
    reserved0: raw.slice(8, 16),
    cpuSvn: raw.slice(16, 32),
    teeTcbInfoHash: raw.slice(32, 80),
    teeInfoHash: raw.slice(80, 128),
    reportData: raw.slice(128, 192),
    reserved1: raw.slice(192, 224),
    mac: raw.slice(224, 256),

    // TEE_TCB_INFO (240 bytes)
    teeTcbValid: raw.slice(256, 264),
    teeTcbSvn: raw.slice(264, 280),
    mrSeam: raw.slice(280, 328),
    mrSignerSeam: raw.slice(328, 376),
    seamAttributes: raw.slice(376, 384),
    teeTcbReserved: raw.slice(384, 496),

    // TD_INFO (512 bytes)
    tdAttributes: raw.slice(496, 504),
    xfam: raw.slice(504, 512),
    mrTd: raw.slice(512, 560),
    mrConfigId: raw.slice(560, 608),
    mrOwner: raw.slice(608, 656),
    mrOwnerConfig: raw.slice(656, 704),
    rtmr0: raw.slice(704, 752),
    rtmr1: raw.slice(752, 800),
    rtmr2: raw.slice(800, 848),
    rtmr3: raw.slice(848, 896),
    tdInfoReserved: raw.slice(896, 1024),
  }
}

// ============================================================================
// Runtime Claims (JSON in variable_data)
// ============================================================================

/**
 * A single runtime claim key-value pair.
 * Note: The key identifier can be either "key_id" or "kid" depending on the source.
 */
export interface RuntimeClaim {
  /** Claim identifier (e.g., "HCLAkPub") - legacy format */
  key_id?: string
  /** Claim identifier (e.g., "HCLAkPub") - JWK format */
  kid?: string
  /** Claim value (typically base64-encoded for binary data) - legacy format */
  value?: string
  /** Key type for JWK format (e.g., "RSA") */
  kty?: string
  /** RSA public exponent (base64url) */
  e?: string
  /** RSA modulus (base64url) */
  n?: string
  /** Key operations */
  key_ops?: string[]
}

/**
 * Runtime claims structure embedded in variable_data.
 * This is a JSON object containing an array of claims.
 */
export interface RuntimeClaims {
  /** Array of key-value claims */
  keys: RuntimeClaim[]
  /** Optional user data (hex-encoded SHA512 hash) */
  "user-data"?: string
}

export function parseRuntimeClaims(variableData: Uint8Array): RuntimeClaims {
  const jsonStr = new TextDecoder().decode(variableData)
  return JSON.parse(jsonStr) as RuntimeClaims
}

// ============================================================================
// Full HCL Report
// ============================================================================

export interface HclReport {
  /** Original raw bytes of the HCL report */
  raw: Uint8Array
  /** Parsed attestation header */
  header: AttestationHeader
  /** Raw hardware report bytes (TD Report for TDX) */
  hwReportRaw: Uint8Array
  /** Parsed TDX TD Report */
  tdReport: TdReport
  /** Parsed IGVM/HCL data section */
  hclData: IgvmRequestData
  /** Variable data as raw bytes */
  variableData: Uint8Array
  /** Parsed runtime claims from variable data */
  runtimeClaims: RuntimeClaims
}

/**
 * Offset to the hardware report within the HCL attestation report.
 * This is immediately after the attestation header.
 */
export const HW_REPORT_OFFSET = ATTESTATION_HEADER_SIZE

/**
 * Offset to the HCL data section.
 * This is after the header and the hardware report (1184 bytes).
 */
export const HCL_DATA_OFFSET = HW_REPORT_OFFSET + HW_REPORT_SIZE

export function parseHclReport(data: Uint8Array): HclReport {
  if (data.length < HCL_DATA_OFFSET + IGVM_REQUEST_DATA_FIXED_SIZE) {
    throw new Error(
      `HCL report too short: ${data.length} bytes, expected at least ${HCL_DATA_OFFSET + IGVM_REQUEST_DATA_FIXED_SIZE}`,
    )
  }

  const header = parseAttestationHeader(data, 0)

  // Extract hardware report (TD Report for TDX)
  // The HCL structure uses 1184 bytes for hw_report, but TD Report is only 1024 bytes
  const hwReportRaw = data.slice(HW_REPORT_OFFSET, HW_REPORT_OFFSET + HW_REPORT_SIZE)
  const tdReport = parseTdReport(data, HW_REPORT_OFFSET)

  // Parse HCL/IGVM data section
  const hclData = parseIgvmRequestData(data, HCL_DATA_OFFSET)

  // Verify this is a TDX report
  if (hclData.reportType !== TDX_REPORT_TYPE) {
    throw new Error(
      `Unsupported report type: ${hclData.reportType}, expected TDX (${TDX_REPORT_TYPE})`,
    )
  }

  // Parse runtime claims from variable data
  let runtimeClaims: RuntimeClaims
  try {
    runtimeClaims = parseRuntimeClaims(hclData.variableData)
  } catch (e) {
    throw new Error(
      `Failed to parse runtime claims: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  return {
    raw: data,
    header,
    hwReportRaw,
    tdReport,
    hclData,
    variableData: hclData.variableData,
    runtimeClaims,
  }
}
