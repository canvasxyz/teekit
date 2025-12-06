import { base64 as scureBase64 } from "@scure/base"
import {
  SevSnpReportBody,
  SevSnpSignature,
  SevSnpReportBodyType,
  SevSnpSignatureType,
  SEV_SNP_REPORT_BODY_SIZE,
  SEV_SNP_REPORT_SIZE,
} from "./structsSev.js"

/**
 * Parsed SEV-SNP attestation report
 */
export interface SevSnpReport {
  body: SevSnpReportBodyType
  signature: SevSnpSignatureType
  /** Raw report data for signature verification */
  rawReport: Uint8Array
}

/**
 * Parse a SEV-SNP attestation report from binary format.
 *
 * The report is 1184 bytes total:
 * - Bytes 0-671: Report body (signed portion)
 * - Bytes 672-1183: Signature (ECDSA P-384)
 *
 * COMPATIBILITY NOTES:
 * - Only SNP reports (version >= 2) are supported
 * - Version 1 (original SEV) uses a completely different format
 * - Version 0 is invalid/reserved
 *
 * @param report - Raw attestation report bytes (1184 bytes)
 * @returns Parsed report structure
 * @throws Error if report is too small or has invalid version
 */
export function parseSevSnpReport(report: Uint8Array): SevSnpReport {
  if (report.length < SEV_SNP_REPORT_SIZE) {
    throw new Error(
      `parseSevSnpReport: Report too small. Expected ${SEV_SNP_REPORT_SIZE} bytes, got ${report.length}`,
    )
  }

  // Read version from first 4 bytes (little-endian)
  const version = new DataView(report.buffer, report.byteOffset, 4).getUint32(
    0,
    true,
  )

  // Version check: SNP uses version >= 2
  // Version 0 is reserved/invalid
  // Version 1 was used by original SEV (not SNP) which has a different format
  if (version < 2) {
    throw new Error(
      `parseSevSnpReport: Unsupported report version ${version}. Only SNP reports (version >= 2) are supported. ` +
        `Version 1 (original SEV) and version 0 (invalid) are not compatible with this parser.`,
    )
  }

  // Parse report body (first 672 bytes)
  const body = SevSnpReportBody.fromBuffer(
    report.subarray(0, SEV_SNP_REPORT_BODY_SIZE),
  ) as SevSnpReportBodyType

  // Parse signature (remaining 512 bytes)
  const signature = SevSnpSignature.fromBuffer(
    report.subarray(SEV_SNP_REPORT_BODY_SIZE),
  ) as SevSnpSignatureType

  return {
    body,
    signature,
    rawReport: report.slice(0, SEV_SNP_REPORT_SIZE),
  }
}

/**
 * Parse a SEV-SNP attestation report from base64-encoded string.
 *
 * @param reportBase64 - Base64-encoded attestation report
 * @returns Parsed report structure
 */
export function parseSevSnpReportBase64(reportBase64: string): SevSnpReport {
  return parseSevSnpReport(scureBase64.decode(reportBase64))
}

/**
 * Parse a SEV-SNP attestation report from hex-encoded string.
 *
 * @param reportHex - Hex-encoded attestation report (with or without 0x prefix)
 * @returns Parsed report structure
 */
export function parseSevSnpReportHex(reportHex: string): SevSnpReport {
  const hex = reportHex.replace(/^0x/i, "").replace(/\s+/g, "")
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return parseSevSnpReport(bytes)
}

/**
 * Get the signed region of a SEV-SNP report (the report body).
 * This is the data that the AMD-SP signs with the VCEK.
 *
 * @param report - Raw attestation report bytes
 * @returns The signed portion (first 672 bytes)
 */
export function getSevSnpSignedRegion(report: Uint8Array): Uint8Array {
  return report.subarray(0, SEV_SNP_REPORT_BODY_SIZE)
}

/**
 * Convert a little-endian AMD signature component to big-endian format.
 * AMD stores R and S in little-endian with zero padding at the end.
 *
 * @param component - 72-byte padded component from AMD report
 * @returns 48-byte big-endian component for WebCrypto
 */
function convertSignatureComponent(component: Uint8Array): Uint8Array {
  // Find the actual end of the component (trim trailing zeros)
  let end = component.length
  while (end > 0 && component[end - 1] === 0x00) end--

  // Get the little-endian bytes
  const littleEndian = component.subarray(0, end)

  // Reverse to big-endian
  const reversed = new Uint8Array(littleEndian.length)
  for (let i = 0; i < littleEndian.length; i++) {
    reversed[i] = littleEndian[littleEndian.length - 1 - i]
  }

  // Pad or trim to 48 bytes
  const out = new Uint8Array(48)
  if (reversed.length > 48) {
    // If larger than 48 bytes, take the last 48 bytes
    out.set(reversed.subarray(reversed.length - 48))
  } else {
    // If smaller, right-align (pad with zeros on the left)
    out.set(reversed, 48 - reversed.length)
  }
  return out
}

/**
 * Extract the raw ECDSA P-384 signature components (r, s) from the report.
 * Each component is 48 bytes (384 bits).
 *
 * Note: The signature in the report is stored as 72-byte padded values
 * in little-endian format. This function converts to big-endian.
 *
 * @param signature - Parsed signature structure
 * @returns Object with r and s components as 48-byte big-endian arrays
 */
export function getSevSnpSignatureComponents(signature: SevSnpSignatureType): {
  r: Uint8Array
  s: Uint8Array
} {
  return {
    r: convertSignatureComponent(signature.r),
    s: convertSignatureComponent(signature.s),
  }
}

/**
 * Get the raw 96-byte ECDSA signature (r || s concatenated).
 * This is the format expected by webcrypto for verification.
 *
 * @param signature - Parsed signature structure
 * @returns 96-byte signature (r || s) in big-endian format
 */
export function getSevSnpRawSignature(
  signature: SevSnpSignatureType,
): Uint8Array {
  const { r, s } = getSevSnpSignatureComponents(signature)
  const result = new Uint8Array(96)
  result.set(r, 0)
  result.set(s, 48)
  return result
}
