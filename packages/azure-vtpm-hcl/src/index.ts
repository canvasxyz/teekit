/**
 * @teekit/azure-vtpm-hcl
 *
 * Parser for Azure vTPM HCL (Host Compatibility Layer) attestation reports.
 *
 * Azure Confidential VMs with Intel TDX use a vTPM for guest attestation.
 * The HCL report binds the vTPM's Attestation Key (AK) to the TDX hardware
 * measurement via the report_data field.
 *
 * Chain of Trust:
 * 1. TDX Quote contains report_data[0:32] = SHA256(Variable_Data)
 * 2. Variable_Data (in HCL Report) contains the vTPM AK public key
 * 3. vTPM quotes are signed by this AK
 *
 * Usage:
 * ```typescript
 * import { parseHclReport, getAkPub, verifyVariableDataBinding } from "@teekit/azure-vtpm-hcl"
 *
 * const hclReport = parseHclReport(hclReportBytes)
 * const akPub = getAkPub(hclReport)
 * const isValid = await verifyVariableDataBinding(hclReport, quoteReportData)
 * ```
 */

import { base64 } from "@scure/base"

export {
  // Types
  type AttestationHeader,
  type IgvmRequestData,
  type TdReport,
  type RuntimeClaim,
  type RuntimeClaims,
  type HclReport,
  // Enums
  IgvmHashType,
  // Constants
  TDX_REPORT_TYPE,
  SNP_REPORT_TYPE,
  TD_REPORT_SIZE,
  HW_REPORT_SIZE,
  HCL_AKPUB_KEY_ID,
  ATTESTATION_HEADER_SIZE,
  IGVM_REQUEST_DATA_FIXED_SIZE,
  HW_REPORT_OFFSET,
  HCL_DATA_OFFSET,
  // Parse functions
  parseAttestationHeader,
  parseIgvmRequestData,
  parseTdReport,
  parseRuntimeClaims,
  parseHclReport,
} from "./structs.js"

import {
  type HclReport,
  // type RuntimeClaims,
  HCL_AKPUB_KEY_ID,
  parseHclReport as parseHclReportFromBytes,
} from "./structs.js"

/**
 * Parse an HCL report from base64-encoded data.
 *
 * @param b64 - Base64-encoded HCL report
 * @returns Parsed HCL report
 */
export function parseHclReportBase64(b64: string): HclReport {
  const bytes = base64.decode(b64)
  return parseHclReportFromBytes(bytes)
}

/**
 * Extract the vTPM Attestation Key (AK) public key from an HCL report.
 *
 * The AK is stored in the runtime claims under the key "HCLAkPub".
 * It can be in two formats:
 * - Legacy: { key_id: "HCLAkPub", value: "<base64>" }
 * - JWK: { kid: "HCLAkPub", kty: "RSA", e: "...", n: "..." }
 *
 * For JWK format, this returns the raw modulus (n) bytes.
 *
 * @param report - Parsed HCL report
 * @returns The AK public key bytes (or modulus for JWK), or null if not found
 */
export function getAkPub(report: HclReport): Uint8Array | null {
  const akClaim = report.runtimeClaims.keys?.find(
    (k) => k.key_id === HCL_AKPUB_KEY_ID || k.kid === HCL_AKPUB_KEY_ID,
  )

  if (!akClaim) {
    return null
  }

  try {
    // Legacy format with base64-encoded value
    if (akClaim.value) {
      return base64.decode(akClaim.value)
    }

    // JWK format - return the modulus (n) as the key material
    if (akClaim.n) {
      // JWK uses base64url encoding - convert to base64 and add padding
      let b64 = akClaim.n.replace(/-/g, "+").replace(/_/g, "/")
      const padLen = (4 - (b64.length % 4)) % 4
      b64 = b64 + "=".repeat(padLen)
      return base64.decode(b64)
    }

    return null
  } catch {
    return null
  }
}

/**
 * Extract user-data from the runtime claims.
 *
 * The user-data field contains SHA512(nonce || user_data) as a hex string.
 *
 * @param report - Parsed HCL report
 * @returns The user-data hex string, or null if not found
 */
export function getUserData(report: HclReport): string | null {
  return report.runtimeClaims["user-data"] ?? null
}

/**
 * Extract user-data from the runtime claims as bytes.
 *
 * @param report - Parsed HCL report
 * @returns The user-data as bytes, or null if not found or invalid
 */
export function getUserDataBytes(report: HclReport): Uint8Array | null {
  const hexStr = getUserData(report)
  if (!hexStr) {
    return null
  }

  try {
    // Parse hex string to bytes
    const bytes = new Uint8Array(hexStr.length / 2)
    for (let i = 0; i < hexStr.length; i += 2) {
      bytes[i / 2] = parseInt(hexStr.substring(i, i + 2), 16)
    }
    return bytes
  } catch {
    return null
  }
}

/**
 * Compute SHA256 hash of the Variable_Data section.
 *
 * This hash should match report_data[0:32] in the TDX quote to verify
 * the binding between the HCL report and the TDX hardware attestation.
 *
 * @param report - Parsed HCL report
 * @returns SHA256 hash of variable data
 */
export async function computeVariableDataHash(
  report: HclReport,
): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    report.variableData.slice(),
  )
  return new Uint8Array(hash)
}

/**
 * Verify that the Variable_Data hash matches the quote's report_data.
 *
 * This validates the chain of trust: the HCL report (containing the vTPM AK)
 * is bound to the TDX quote via its hash in report_data[0:32].
 *
 * @param report - Parsed HCL report
 * @param quoteReportData - The 64-byte report_data from a TDX quote
 * @returns true if SHA256(variable_data) matches report_data[0:32]
 */
export async function verifyVariableDataBinding(
  report: HclReport,
  quoteReportData: Uint8Array,
): Promise<boolean> {
  if (quoteReportData.length < 32) {
    return false
  }

  const varDataHash = await computeVariableDataHash(report)
  const reportDataFirst32 = quoteReportData.slice(0, 32)

  if (varDataHash.length !== reportDataFirst32.length) {
    return false
  }

  for (let i = 0; i < varDataHash.length; i++) {
    if (varDataHash[i] !== reportDataFirst32[i]) {
      return false
    }
  }

  return true
}

/**
 * Convert bytes to hex string.
 *
 * @param bytes - Bytes to convert
 * @returns Lowercase hex string
 */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
