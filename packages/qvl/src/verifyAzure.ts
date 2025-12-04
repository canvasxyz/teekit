import type { TdxQuote } from "./verifyTdx.js"
import {
  parseHclReport,
  parseHclReportBase64,
  getAkPub,
  getUserData,
  verifyVariableDataBinding,
  type HclReport,
} from "@teekit/azure-vtpm-hcl"

// Re-export HCL types for convenience
export { parseHclReport, parseHclReportBase64, getAkPub, getUserData }
export type { HclReport }

/**
 * Verify that an Azure TDX quote has the expected Azure vTPM structure.
 *
 * IMPORTANT: Azure vTPM TDX quotes have a different structure than standard TDX quotes:
 *
 * - report_data[0:32] = SHA256(HCL_Variable_Data)
 *   - HCL_Variable_Data is a structure containing the vTPM Attestation Key (AK) public key
 *   - This is NOT directly hashable from the quote - it requires the HCL Report from runtime_data
 * - report_data[32:64] = zeros
 *
 * The vTPM AK public key is embedded in the HCL Report, which is part of the runtime_data
 * returned by trustauthority-cli. The AK is used to sign TPM quotes, establishing a chain:
 *
 *   Intel TDX Quote → HCL Report (contains AK) → vTPM Quote (signed by AK)
 *
 * Full verification requires:
 * 1. Parse the HCL Report from runtime_data
 * 2. Extract the Variable_Data and compute SHA256
 * 3. Verify SHA256(Variable_Data) == report_data[0:32]
 * 4. Extract the vTPM AK public key from Variable_Data
 * 5. Verify vTPM quotes are signed by this AK
 *
 * This function performs a basic structural check to verify the quote follows
 * Azure's convention (zeros in report_data[32:64]).
 *
 * @param quote - Parsed TDX quote
 * @returns true if the quote follows Azure vTPM structure (report_data[32:64] is zeros)
 */
export function isAzureVtpmQuoteStructure(quote: TdxQuote): boolean {
  const reportData = quote.body.report_data

  // Azure vTPM quotes have zeros in the last 32 bytes of report_data
  const reportDataLast32 = reportData.slice(32, 64)
  for (let i = 0; i < reportDataLast32.length; i++) {
    if (reportDataLast32[i] !== 0) {
      return false
    }
  }

  return true
}

/**
 * Verify that an HCL Report's Variable_Data hash matches the quote's report_data.
 *
 * This validates the chain of trust: the HCL Report (containing the vTPM AK)
 * is bound to the TDX quote via its hash in report_data[0:32].
 *
 * @param quote - Parsed TDX quote
 * @param hclVariableData - The Variable_Data bytes extracted from the HCL Report
 * @returns true if SHA256(hclVariableData) matches report_data[0:32]
 */
export async function verifyAzureHclBinding(
  quote: TdxQuote,
  hclVariableData: Uint8Array,
): Promise<boolean> {
  const reportData = quote.body.report_data

  // Compute SHA256 of the HCL Variable_Data
  // .slice() creates a clean copy to satisfy TypeScript's BufferSource type
  const varDataHash = await crypto.subtle.digest(
    "SHA-256",
    hclVariableData.slice(),
  )
  const varDataHashBytes = new Uint8Array(varDataHash)

  // Compare with first 32 bytes of report_data
  const reportDataFirst32 = reportData.slice(0, 32)

  if (varDataHashBytes.length !== reportDataFirst32.length) {
    return false
  }

  for (let i = 0; i < varDataHashBytes.length; i++) {
    if (varDataHashBytes[i] !== reportDataFirst32[i]) {
      return false
    }
  }

  return true
}

/**
 * Compute expected report_data for Azure TDX.
 *
 * Azure uses: report_data = SHA512(nonce || user_data)
 *
 * When using trustauthority-cli quote --aztdx:
 * - nonce is passed via --nonce
 * - user_data is passed via --user-data
 */
export async function getAzureExpectedReportData(
  nonce: Uint8Array,
  userData: Uint8Array,
): Promise<Uint8Array> {
  const combined = new Uint8Array(nonce.length + userData.length)
  combined.set(nonce, 0)
  combined.set(userData, nonce.length)

  const hash = await crypto.subtle.digest("SHA-512", combined)
  return new Uint8Array(hash)
}

/**
 * Check if a raw TDX quote's report_data matches the Azure binding formula.
 *
 * Azure uses: report_data = SHA512(nonce || user_data)
 * For our use case, both nonce and user_data are the x25519 public key.
 *
 * @param reportData - The 64-byte report_data from a TDX quote body
 * @param nonce - Nonce used in quote generation
 * @param userData - User data (e.g., x25519 public key)
 */
export async function isAzureQuoteReportDataBound(
  reportData: Uint8Array,
  nonce: Uint8Array,
  userData: Uint8Array,
): Promise<boolean> {
  const expected = await getAzureExpectedReportData(nonce, userData)

  if (reportData.length !== expected.length) {
    return false
  }

  for (let i = 0; i < reportData.length; i++) {
    if (reportData[i] !== expected[i]) {
      return false
    }
  }

  return true
}

/**
 * Result of Azure vTPM chain of trust verification.
 */
export interface AzureChainOfTrustResult {
  /** Whether the verification was successful */
  valid: boolean
  /** The parsed HCL report */
  hclReport: HclReport
  /** The vTPM Attestation Key public key (RSA modulus for JWK format) */
  akPub: Uint8Array | null
  /** The user-data hex string from runtime claims */
  userData: string | null
  /** Error message if verification failed */
  error?: string
}

/**
 * Verify the Azure vTPM chain of trust.
 *
 * This function performs the complete verification:
 * 1. Parses the HCL Report from runtime_data
 * 2. Verifies SHA256(Variable_Data) == report_data[0:32]
 * 3. Extracts the vTPM AK public key
 *
 * Chain of trust:
 *   Intel Root CA → PCK Cert → QE → TDX Quote → HCL Report → vTPM AK
 *
 * @param quote - Parsed TDX quote (from @teekit/qvl)
 * @param hclReportData - The HCL report bytes (from trustauthority-cli runtime_data)
 * @returns Verification result with parsed HCL report and AK public key
 */
export async function verifyAzureChainOfTrust(
  quote: TdxQuote,
  hclReportData: Uint8Array,
): Promise<AzureChainOfTrustResult> {
  // Parse the HCL report
  let hclReport: HclReport
  try {
    hclReport = parseHclReport(hclReportData)
  } catch (e) {
    return {
      valid: false,
      hclReport: null as unknown as HclReport,
      akPub: null,
      userData: null,
      error: `Failed to parse HCL report: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // Verify the HCL Variable_Data hash matches the quote's report_data[0:32]
  const bindingValid = await verifyVariableDataBinding(
    hclReport,
    quote.body.report_data,
  )

  if (!bindingValid) {
    return {
      valid: false,
      hclReport,
      akPub: getAkPub(hclReport),
      userData: getUserData(hclReport),
      error: "HCL Variable_Data hash does not match quote report_data[0:32]",
    }
  }

  // Extract the AK public key
  const akPub = getAkPub(hclReport)

  return {
    valid: true,
    hclReport,
    akPub,
    userData: getUserData(hclReport),
  }
}

/**
 * Verify the Azure vTPM chain of trust from base64-encoded HCL report.
 *
 * Convenience wrapper for verifyAzureChainOfTrust that accepts base64 input.
 *
 * @param quote - Parsed TDX quote
 * @param hclReportBase64 - Base64-encoded HCL report
 * @returns Verification result
 */
export async function verifyAzureChainOfTrustBase64(
  quote: TdxQuote,
  hclReportBase64: string,
): Promise<AzureChainOfTrustResult> {
  let hclReportData: Uint8Array
  try {
    hclReportData = parseHclReportBase64(hclReportBase64).raw
  } catch (e) {
    return {
      valid: false,
      hclReport: null as unknown as HclReport,
      akPub: null,
      userData: null,
      error: `Failed to decode base64 HCL report: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  return verifyAzureChainOfTrust(quote, hclReportData)
}
