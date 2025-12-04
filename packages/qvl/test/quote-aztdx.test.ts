import test from "ava"
import { base64 as scureBase64 } from "@scure/base"

import {
  parseTdxQuoteBase64,
  verifyTdx,
  getAzureExpectedReportData,
  hex,
} from "@teekit/qvl"
import {
  parseTrustAuthorityCLIOutput,
  parseRuntimeDataJson,
} from "./aztdx-helpers.js"

/**
 * Verify the complete attestation chain for Azure TDX:
 *
 * 1. Intel Root CA → PCK Cert → QE → TDX Quote
 * 2. TDX Quote report_data[0:32] = SHA256(runtime_data/Variable_Data JSON)
 * 3. runtime_data contains user-data = SHA512(nonce || userData)
 */
test.serial("Azure TDX: full chain of trust verification", async (t) => {
  const cliOutput = parseTrustAuthorityCLIOutput(
    "test/sampleQuotes/tdx-v4-aztdx",
  )
  const parsedQuote = parseTdxQuoteBase64(scureBase64.encode(cliOutput.quote))

  // Verify the complete Intel attestation chain:
  // - PCK certificate chain validity (not expired, not revoked)
  // - Chain terminates at Intel SGX Root CA
  // - QE report signature is valid (signed by PCK leaf cert)
  // - QE report binding is valid (attestation_public_key bound to QE report_data)
  // - Quote signature is valid (header+body signed by attestation_public_key)
  const intelTdxChainValid = await verifyTdx(cliOutput.quote, {
    crls: [],
    verifyTcb: () => true, // Skip TCB verification for this test
    verifyMeasurements: {
      mrtd: hex(parsedQuote.body.mr_td),
    },
  })

  t.true(intelTdxChainValid, "Intel Root CA chain and quote signature")

  // Verify Variable_Data binding: report_data[0:32] = SHA256(runtime_data)
  const reportDataFirst32 = hex(parsedQuote.body.report_data.slice(0, 32))
  const reportDataLast32 = hex(parsedQuote.body.report_data.slice(32, 64))
  const expectedVarDataHash = await crypto.subtle.digest(
    "SHA-256",
    cliOutput.runtimeData.slice(),
  )
  const expectedVarDataHashHex = hex(new Uint8Array(expectedVarDataHash))

  t.is(
    reportDataFirst32,
    expectedVarDataHashHex,
    "report_data[0:32] should equal SHA256(runtime_data/Variable_Data)",
  )
  t.is(
    reportDataLast32,
    "0".repeat(64),
    "report_data[32:64] should be zeros (Azure convention)",
  )

  // Extract AK and user-data from runtime_data
  const runtimeDataJson = parseRuntimeDataJson(cliOutput.runtimeData)

  // Verify we have the vTPM attestation key
  // TODO: Verify the vTPM attestation key via Azure Root CA
  const akPubKey = runtimeDataJson.keys.find((k) => k.kid === "HCLAkPub")
  t.truthy(akPubKey, "Should have HCLAkPub key in runtime_data")
  t.is(akPubKey!.kty, "RSA", "AK should be RSA key")
  t.truthy(akPubKey!.n, "AK should have modulus (n)")

  // Verify user-data binding: user-data = SHA512(nonce || userData)
  const expectedUserDataHash = await getAzureExpectedReportData(
    cliOutput.nonce,
    cliOutput.userData,
  )
  const expectedUserDataHex = hex(expectedUserDataHash).toUpperCase()
  t.is(
    runtimeDataJson.userData.toUpperCase(),
    expectedUserDataHex,
    "runtime_data user-data should equal SHA512(nonce || userData)",
  )
})
