import test from "ava"
import fs from "node:fs"

import {
  parseSevSnpReport,
  parseSevSnpReportHex,
  hex,
  verifySevSnp,
  _verifySevSnp,
  getSevSnpTcbInfo,
  isSevSnpDebugEnabled,
  getSevSnpPolicyApiVersion,
  SevSnpPolicyFlags,
  SevSnpPlatformFlags,
  SEV_SNP_REPORT_SIZE,
  SEV_SNP_REPORT_BODY_SIZE,
  DEFAULT_AMD_ASK_CERT,
  getSevSnpRawSignature,
  getSevSnpSignedRegion,
} from "@teekit/qvl"

// Test certificate paths
const VCEK_CERT_PATH = "test/sampleQuotes/sev-gcp-vcek.pem"
const CERT_CHAIN_PATH = "test/sampleQuotes/sev-gcp-cert-chain.pem"

// Load certificates
const VCEK_PEM = fs.readFileSync(VCEK_CERT_PATH, "utf-8")
const CERT_CHAIN_PEM = fs.readFileSync(CERT_CHAIN_PATH, "utf-8")

// Parse the cert chain to extract ASK and ARK
function parseCertChain(chainPem: string): { askPem: string; arkPem: string } {
  const certs = chainPem
    .split(/(?=-----BEGIN CERTIFICATE-----)/)
    .filter(Boolean)
  if (certs.length < 2) {
    throw new Error("Certificate chain must contain at least ASK and ARK")
  }
  return {
    askPem: certs[0].trim(),
    arkPem: certs[1].trim(),
  }
}

const { askPem: ASK_PEM, arkPem: ARK_PEM } = parseCertChain(CERT_CHAIN_PEM)

// Expected values from the GCP sample report (sev-gcp-reportdata.bin)
const EXPECTED_MEASUREMENT =
  "b747d55452e0b9e9079770a49e397c5e6d9573581e246da7baac4f28b5cdc5b1b6d19251b8ee600fd16a3708f58406f3"
const EXPECTED_REPORT_DATA =
  "32fc4f6c1971cbf91566231f8d6153eeb9d093aa94306cb48d39bcc4861a3d395f149876a37bc91332fe493f46294fd135d5b95d363ae96352b8c45f906079f5"

// Main sample report file (version 5 SNP report with non-zero report_data)
const SAMPLE_REPORT_PATH = "test/sampleQuotes/sev-gcp-reportdata.bin"

/**
 * SEV-SNP Test Cases
 *
 * COMPATIBILITY NOTES:
 * - The sev-gcp.bin sample is a version 5 SNP report from Google Cloud
 * - This implementation supports SNP reports (version >= 2)
 * - Version 1 (original SEV) uses a different format and is NOT supported
 * - Version 0 is invalid/reserved
 *
 * SIGNATURE VERIFICATION:
 * - Uses real VCEK certificate from AMD KDS (sev-gcp-vcek.pem)
 * - Certificate chain (ASK + ARK) from AMD (sev-gcp-cert-chain.pem)
 * - Also tests with default embedded Milan certificates
 *
 * DIFFERENCES FROM INTEL TDX/SGX:
 * - No embedded certificate chain (must fetch from AMD KDS)
 * - Uses ECDSA P-384 instead of P-256
 * - Measurement is 48 bytes (SHA-384)
 * - No quoting enclave - AMD-SP signs directly
 */

test.serial("Parse a SEV-SNP report from GCP (binary format)", async (t) => {
  const report = new Uint8Array(fs.readFileSync(SAMPLE_REPORT_PATH))

  // Verify report size
  t.is(report.length, SEV_SNP_REPORT_SIZE, "Report should be 1184 bytes")

  const parsed = parseSevSnpReport(report)

  // Check version (should be 5 for this sample)
  t.is(parsed.body.version, 5, "Report version should be 5")

  // Verify guest_svn
  t.is(parsed.body.guest_svn, 0, "Guest SVN should be 0")

  // Verify VMPL (this sample has VMPL 1)
  t.is(parsed.body.vmpl, 1, "VMPL should be 1")

  // Verify signature algorithm
  // Algorithm 0 = invalid/reserved, 1 = ECDSA P-384 with SHA-384
  // Note: The AMD documentation has been updated; newer specs use 1 for ECDSA P-384
  t.is(
    parsed.body.signature_algo,
    1,
    "Signature algorithm should be 1 (ECDSA P-384)",
  )

  // Check policy - debug should not be enabled for production
  const debugEnabled = isSevSnpDebugEnabled(parsed.body.policy)
  t.is(debugEnabled, false, "Debug should not be enabled")

  // Get policy API version (this sample has API version 0.0)
  const apiVersion = getSevSnpPolicyApiVersion(parsed.body.policy)
  t.is(apiVersion.minor, 0, "API minor version")
  t.is(apiVersion.major, 0, "API major version")

  // Verify measurement is present and correct length
  t.is(parsed.body.measurement.length, 48, "Measurement should be 48 bytes")
  t.is(
    hex(parsed.body.measurement),
    EXPECTED_MEASUREMENT,
    "Measurement should match",
  )

  // Verify report_data is present and correct length
  t.is(parsed.body.report_data.length, 64, "Report data should be 64 bytes")
  t.is(
    hex(parsed.body.report_data),
    EXPECTED_REPORT_DATA,
    "Report data should match",
  )

  // Verify host_data
  t.is(parsed.body.host_data.length, 32, "Host data should be 32 bytes")
  const hostDataHex = hex(parsed.body.host_data)
  t.is(hostDataHex.length, 64, "Host data hex should be 64 chars")

  // Verify chip_id is present
  t.is(parsed.body.chip_id.length, 64, "Chip ID should be 64 bytes")

  // Get TCB info
  const tcbInfo = getSevSnpTcbInfo(parsed)
  t.truthy(tcbInfo.currentTcb, "Should have current TCB info")
  t.truthy(tcbInfo.reportedTcb, "Should have reported TCB info")

  // Verify signature components are present
  t.is(
    parsed.signature.r.length,
    72,
    "Signature R should be 72 bytes (48 + padding)",
  )
  t.is(
    parsed.signature.s.length,
    72,
    "Signature S should be 72 bytes (48 + padding)",
  )
})

test.serial("Parse a SEV-SNP report from GCP (hex format)", async (t) => {
  // Use hexdump of the main sample report
  const report = fs.readFileSync(SAMPLE_REPORT_PATH)
  const reportHex = report.toString("hex")
  const parsed = parseSevSnpReportHex(reportHex)

  // Same checks as binary format
  t.is(parsed.body.version, 5, "Report version should be 5")
  t.is(parsed.body.vmpl, 1, "VMPL should be 1")
  t.is(
    hex(parsed.body.measurement),
    EXPECTED_MEASUREMENT,
    "Measurement should match",
  )
  t.is(
    hex(parsed.body.report_data),
    EXPECTED_REPORT_DATA,
    "Report data should match",
  )
})

test.serial(
  "Verify certificate chain validation (ASK signed by ARK)",
  async (t) => {
    // This test verifies the certificate chain validation logic works
    // by checking that the ASK cert is properly signed by the ARK cert
    const { QV_X509Certificate } = await import("@teekit/qvl")

    const ask = new QV_X509Certificate(ASK_PEM)
    const ark = new QV_X509Certificate(ARK_PEM)

    // Verify ASK is signed by ARK (RSA-PSS signature)
    t.true(await ask.verify(ark), "ASK should be signed by ARK")

    // Verify ARK is self-signed
    t.true(await ark.verify(ark), "ARK should be self-signed")
  },
)

test.serial("Verify VCEK is signed by ASK", async (t) => {
  // This test verifies that the VCEK certificate chain is valid
  const { QV_X509Certificate } = await import("@teekit/qvl")

  const vcek = new QV_X509Certificate(VCEK_PEM)
  const ask = new QV_X509Certificate(ASK_PEM)

  // Verify VCEK is signed by ASK (RSA-PSS signature)
  t.true(await vcek.verify(ask), "VCEK should be signed by ASK")
})

test.serial("Verify default Milan certificates match cert chain", async (t) => {
  // This test confirms the embedded default Milan ASK matches the cert chain ASK
  const { QV_X509Certificate } = await import("@teekit/qvl")

  const chainAsk = new QV_X509Certificate(ASK_PEM)

  // The default ASK should have the same subject as the chain ASK
  t.is(
    DEFAULT_AMD_ASK_CERT.subject,
    chainAsk.subject,
    "Default ASK subject should match cert chain ASK",
  )
})

test.serial(
  "Verify SEV-SNP report signature with VCEK (sev-gcp-reportdata.bin)",
  async (t) => {
    // This test performs full signature verification:
    // 1. Parses the attestation report
    // 2. Verifies the report signature using the VCEK public key
    // 3. Uses the correct VCEK that was fetched from AMD KDS with matching TCB values
    const { QV_X509Certificate } = await import("@teekit/qvl")

    const report = new Uint8Array(fs.readFileSync(SAMPLE_REPORT_PATH))
    const parsed = parseSevSnpReport(report)

    // Get the VCEK certificate
    const vcek = new QV_X509Certificate(VCEK_PEM)

    // Get the signed region (first 672 bytes) and signature
    const signedRegion = getSevSnpSignedRegion(report)
    const signature = getSevSnpRawSignature(parsed.signature)

    t.is(
      signedRegion.length,
      SEV_SNP_REPORT_BODY_SIZE,
      "Signed region should be 672 bytes",
    )
    t.is(signature.length, 96, "Raw signature should be 96 bytes (R + S)")

    // Verify signature using WebCrypto
    const spki = vcek.publicKey.rawData
    const publicKey = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-384" },
      true,
      ["verify"],
    )

    const isValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-384" },
      publicKey,
      signature.slice(),
      signedRegion.slice(),
    )

    t.true(isValid, "Report signature should verify with VCEK")
  },
)

test.serial(
  "Verify SEV-SNP report signature with VCEK (sev-gcp.bin)",
  async (t) => {
    // Both sev-gcp.bin and sev-gcp-reportdata.bin are from the same chip with the same TCB,
    // so they should both verify with the same VCEK certificate.
    const { QV_X509Certificate } = await import("@teekit/qvl")

    const report = new Uint8Array(
      fs.readFileSync("test/sampleQuotes/sev-gcp.bin"),
    )
    const parsed = parseSevSnpReport(report)

    // Get the VCEK certificate
    const vcek = new QV_X509Certificate(VCEK_PEM)

    // Get the signed region (first 672 bytes) and signature
    const signedRegion = getSevSnpSignedRegion(report)
    const signature = getSevSnpRawSignature(parsed.signature)

    t.is(
      signedRegion.length,
      SEV_SNP_REPORT_BODY_SIZE,
      "Signed region should be 672 bytes",
    )
    t.is(signature.length, 96, "Raw signature should be 96 bytes (R + S)")

    // Verify signature using WebCrypto
    const spki = vcek.publicKey.rawData
    const publicKey = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-384" },
      true,
      ["verify"],
    )

    const isValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-384" },
      publicKey,
      signature.slice(),
      signedRegion.slice(),
    )

    t.true(isValid, "Report signature should verify with VCEK")
  },
)

test.serial("Verify SEV-SNP report with measurement check", async (t) => {
  const report = new Uint8Array(fs.readFileSync(SAMPLE_REPORT_PATH))

  // Should pass with correct measurements
  t.true(
    await verifySevSnp(report, {
      verifyMeasurements: {
        measurement: EXPECTED_MEASUREMENT,
        reportData: EXPECTED_REPORT_DATA,
      },
    }),
    "Should pass with correct measurements",
  )

  // Should pass with partial measurements (only measurement)
  t.true(
    await verifySevSnp(report, {
      verifyMeasurements: {
        measurement: EXPECTED_MEASUREMENT,
      },
    }),
    "Should pass with only measurement specified",
  )
})

test.serial("Reject SEV-SNP report with wrong measurement", async (t) => {
  const report = new Uint8Array(fs.readFileSync(SAMPLE_REPORT_PATH))

  const wrongMeasurement =
    "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

  const err = await t.throwsAsync(
    async () =>
      await verifySevSnp(report, {
        verifyMeasurements: {
          measurement: wrongMeasurement,
        },
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /measurement verification failed/i)
})

test.serial("Verify SEV-SNP report VMPL check", async (t) => {
  const report = new Uint8Array(fs.readFileSync(SAMPLE_REPORT_PATH))

  // The sample has VMPL 1, so any maxVmpl >= 1 should pass
  t.true(
    await verifySevSnp(report, {
      maxVmpl: 1,
    }),
    "Should pass with maxVmpl 1 since report has VMPL 1",
  )

  t.true(
    await verifySevSnp(report, {
      maxVmpl: 3,
    }),
    "Should pass with maxVmpl 3",
  )
})

test.serial("Reject SEV-SNP report with VMPL exceeding maximum", async (t) => {
  // The sample report has VMPL = 1, so maxVmpl: 0 should fail
  const report = new Uint8Array(fs.readFileSync(SAMPLE_REPORT_PATH))

  const err = await t.throwsAsync(
    async () =>
      await verifySevSnp(report, {
        maxVmpl: 0,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /VMPL.*exceeds maximum/i)
})

test.serial("Verify SEV-SNP report TCB extraction", async (t) => {
  const report = new Uint8Array(fs.readFileSync(SAMPLE_REPORT_PATH))
  const parsed = parseSevSnpReport(report)

  const tcbInfo = getSevSnpTcbInfo(parsed)

  // Verify current TCB structure
  t.is(
    typeof tcbInfo.currentTcb.bootLoader,
    "number",
    "Boot loader SVN should be a number",
  )
  t.is(typeof tcbInfo.currentTcb.tee, "number", "TEE SVN should be a number")
  t.is(typeof tcbInfo.currentTcb.snp, "number", "SNP SVN should be a number")
  t.is(
    typeof tcbInfo.currentTcb.microcode,
    "number",
    "Microcode SVN should be a number",
  )

  // Verify version info
  t.is(
    typeof tcbInfo.currentVersion.major,
    "number",
    "Current major version should be a number",
  )
  t.is(
    typeof tcbInfo.currentVersion.minor,
    "number",
    "Current minor version should be a number",
  )
  t.is(
    typeof tcbInfo.currentVersion.build,
    "number",
    "Current build should be a number",
  )
})

test.serial("Verify SEV-SNP policy flags", async (t) => {
  const report = new Uint8Array(fs.readFileSync(SAMPLE_REPORT_PATH))
  const parsed = parseSevSnpReport(report)

  const policy = parsed.body.policy

  // Check various policy flags
  const smtAllowed = (policy & SevSnpPolicyFlags.SMT_ALLOWED) !== 0n
  const debugAllowed = (policy & SevSnpPolicyFlags.DEBUG_ALLOWED) !== 0n
  const migrateAllowed = (policy & SevSnpPolicyFlags.MIGRATE_MA) !== 0n
  const singleSocket = (policy & SevSnpPolicyFlags.SINGLE_SOCKET) !== 0n

  // Log policy for debugging
  t.log(`Policy: 0x${policy.toString(16)}`)
  t.log(`SMT Allowed: ${smtAllowed}`)
  t.log(`Debug Allowed: ${debugAllowed}`)
  t.log(`Migrate Allowed: ${migrateAllowed}`)
  t.log(`Single Socket: ${singleSocket}`)

  // Basic sanity checks
  t.is(typeof smtAllowed, "boolean", "SMT allowed should be boolean")
  t.is(typeof debugAllowed, "boolean", "Debug allowed should be boolean")
})

test.serial("Verify SEV-SNP platform info", async (t) => {
  const report = new Uint8Array(fs.readFileSync(SAMPLE_REPORT_PATH))
  const parsed = parseSevSnpReport(report)

  const platformInfo = parsed.body.platform_info

  // Check platform flags
  const smtEnabled = (platformInfo & SevSnpPlatformFlags.SMT_ENABLED) !== 0n
  const tsmeEnabled = (platformInfo & SevSnpPlatformFlags.TSME_ENABLED) !== 0n

  t.log(`Platform Info: 0x${platformInfo.toString(16)}`)
  t.log(`SMT Enabled: ${smtEnabled}`)
  t.log(`TSME Enabled: ${tsmeEnabled}`)

  t.is(typeof smtEnabled, "boolean", "SMT enabled should be boolean")
})

test.serial("Reject report with unsupported version", async (t) => {
  const report = Buffer.from(fs.readFileSync(SAMPLE_REPORT_PATH))

  // Modify version to 1 (original SEV, not SNP)
  report.writeUInt32LE(1, 0)

  const err = await t.throwsAsync(async () => await verifySevSnp(report))
  t.truthy(err)
  t.regex(err!.message, /Unsupported report version/i)
})

test.serial("Reject report with version 0", async (t) => {
  const report = Buffer.from(fs.readFileSync(SAMPLE_REPORT_PATH))

  // Modify version to 0 (invalid)
  report.writeUInt32LE(0, 0)

  const err = await t.throwsAsync(async () => await verifySevSnp(report))
  t.truthy(err)
  t.regex(err!.message, /Unsupported report version/i)
})

test.serial("Reject truncated report", async (t) => {
  const report = fs.readFileSync(SAMPLE_REPORT_PATH)

  // Truncate to less than 1184 bytes
  const truncated = report.subarray(0, 500)

  const err = await t.throwsAsync(async () => await verifySevSnp(truncated))
  t.truthy(err)
  t.regex(err!.message, /Report too small/i)
})

test.serial("Verify multiple measurement configs (OR logic)", async (t) => {
  const report = new Uint8Array(fs.readFileSync(SAMPLE_REPORT_PATH))

  const wrongMeasurement =
    "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

  // Should pass with array where at least one matches
  t.true(
    await verifySevSnp(report, {
      verifyMeasurements: [
        { measurement: wrongMeasurement },
        { measurement: EXPECTED_MEASUREMENT }, // This one matches
      ],
    }),
    "Should pass when at least one measurement config matches",
  )

  // Should fail when none match
  const err = await t.throwsAsync(
    async () =>
      await verifySevSnp(report, {
        verifyMeasurements: [
          { measurement: wrongMeasurement },
          { measurement: wrongMeasurement },
        ],
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /measurement verification failed/i)
})

test.serial("Verify custom measurement verifier function", async (t) => {
  const report = new Uint8Array(fs.readFileSync(SAMPLE_REPORT_PATH))

  // Custom verifier that checks measurement prefix
  t.true(
    await verifySevSnp(report, {
      verifyMeasurements: (parsed) => {
        const measurementHex = hex(parsed.body.measurement)
        return measurementHex.startsWith("b747d554")
      },
    }),
    "Custom verifier should pass",
  )

  // Custom verifier that fails
  const err = await t.throwsAsync(
    async () =>
      await verifySevSnp(report, {
        verifyMeasurements: () => false,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /measurement verification failed/i)
})

test.serial("Verify _verifySevSnp returns result object", async (t) => {
  const report = new Uint8Array(fs.readFileSync(SAMPLE_REPORT_PATH))

  const result = await _verifySevSnp(report)

  t.true(result.valid, "Result should be valid")
  t.truthy(result.report, "Result should include parsed report")
  t.is(result.report.body.version, 5, "Parsed report version should be 5")
  t.is(result.error, undefined, "No error for valid report")
})

test.serial(
  "Verify _verifySevSnp returns error for invalid report",
  async (t) => {
    const report = Buffer.from(fs.readFileSync(SAMPLE_REPORT_PATH))
    report.writeUInt32LE(0, 0) // Invalid version

    const result = await _verifySevSnp(report)

    t.false(result.valid, "Result should be invalid")
    t.truthy(result.error, "Should have error message")
    t.regex(result.error!, /Unsupported report version|Failed to parse/i)
  },
)

/**
 * COMPATIBILITY DOCUMENTATION
 *
 * This implementation is designed for AMD SEV-SNP attestation reports.
 *
 * SUPPORTED:
 * - SNP attestation reports (version >= 2)
 * - Report version 5 (tested with GCP sample)
 * - ECDSA P-384 signatures (signature_algo = 0 or 1)
 * - Full certificate chain verification (ARK -> ASK -> VCEK)
 * - Default embedded Milan ARK/ASK certificates
 * - All standard policy and platform flags
 *
 * NOT SUPPORTED:
 * - Original SEV reports (version 1) - completely different format
 * - SEV-ES reports - use SEV launch attestation, not SNP runtime attestation
 * - Version 0 reports - invalid/reserved
 *
 * SIGNATURE VERIFICATION:
 * - Requires VCEK certificate from AMD KDS (chip_id + TCB specific)
 * - Certificate chain (ARK -> ASK -> VCEK) validated automatically
 * - Default Milan ARK/ASK certificates are embedded for convenience
 * - Custom ARK/ASK can be provided for other processor generations
 *
 * TCB EVALUATION:
 * - TCB info is extracted but not automatically evaluated
 * - AMD publishes TCB status info that should be checked in production
 * - Use verifyTcb callback for custom TCB validation
 *
 * CLOUD PROVIDERS:
 * - GCP: Tested with sev-gcp.bin sample (with real VCEK/cert chain)
 * - AWS: Should work with EC2 SEV-SNP instances (not tested)
 * - Azure: Should work with confidential VMs (not tested)
 *
 * DIFFERENCES FROM INTEL:
 * - No embedded certificate chain in report (must fetch from AMD KDS)
 * - Uses P-384 instead of P-256
 * - 48-byte measurement (SHA-384)
 * - AMD-SP signs directly (no quoting enclave)
 * - TCB encoded as individual SVN values
 */
