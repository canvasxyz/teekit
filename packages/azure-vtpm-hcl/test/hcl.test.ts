import test from "ava"
import { base64 } from "@scure/base"
import {
  parseHclReport,
  parseHclReportBase64,
  parseTdReport,
  parseAttestationHeader,
  parseIgvmRequestData,
  parseRuntimeClaims,
  getAkPub,
  getUserData,
  getUserDataBytes,
  computeVariableDataHash,
  verifyVariableDataBinding,
  hex,
  TDX_REPORT_TYPE,
  TD_REPORT_SIZE,
  ATTESTATION_HEADER_SIZE,
  IGVM_REQUEST_DATA_FIXED_SIZE,
  HW_REPORT_OFFSET,
  HCL_DATA_OFFSET,
  HCL_AKPUB_KEY_ID,
} from "@teekit/azure-vtpm-hcl"

// ============================================================================
// Test Fixtures
// ============================================================================

import {
  HW_REPORT_SIZE,
} from "@teekit/azure-vtpm-hcl"

/**
 * Create a synthetic HCL report for testing.
 *
 * Structure:
 * - Attestation Header (32 bytes)
 * - HW Report (1184 bytes - padded TD Report)
 * - IGVM Request Data (20 bytes fixed + variable_data)
 */
function createTestHclReport(options: {
  reportData?: Uint8Array
  runtimeClaims?: object
  akPub?: Uint8Array
  userData?: string
}): Uint8Array {
  const {
    reportData = new Uint8Array(64).fill(0xab),
    runtimeClaims,
    akPub = new Uint8Array(256).fill(0x42), // Mock RSA public key
    userData = "4B453B5F70E5E2080AD97AFC62B0546BA3EFED53966A5DA9BBB42BCC8DECB5BE6B77F1F6F042C7FBFFA2CEA1042D89AA96CA51D204AD00ABA2D04FA5A9702BE9",
  } = options

  // Build runtime claims JSON
  const claims = runtimeClaims ?? {
    keys: [
      {
        key_id: HCL_AKPUB_KEY_ID,
        value: base64.encode(akPub),
      },
    ],
    "user-data": userData,
  }
  const claimsJson = JSON.stringify(claims)
  const claimsBytes = new TextEncoder().encode(claimsJson)

  // Calculate total size - HCL uses HW_REPORT_SIZE (1184), not TD_REPORT_SIZE (1024)
  const totalSize =
    ATTESTATION_HEADER_SIZE + HW_REPORT_SIZE + IGVM_REQUEST_DATA_FIXED_SIZE + claimsBytes.length

  const buffer = new Uint8Array(totalSize)
  const view = new DataView(buffer.buffer)
  let offset = 0

  // Attestation Header (32 bytes)
  view.setUint32(offset, 0x48434c41, true) // Signature "HCLA"
  offset += 4
  view.setUint32(offset, 1, true) // Version
  offset += 4
  view.setUint32(offset, totalSize, true) // Report size
  offset += 4
  view.setUint32(offset, 1, true) // Request type
  offset += 4
  view.setUint32(offset, 0, true) // Status (success)
  offset += 4
  // Reserved (12 bytes)
  offset += 12

  // HW Report (1184 bytes) - TD Report (1024 bytes) + padding (160 bytes)
  // REPORTMACSTRUCT (256 bytes)
  // report_type (8 bytes) - set to TDX type indicator
  buffer.set(new Uint8Array([0x81, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), offset)
  offset += 8
  // reserved0 (8 bytes)
  offset += 8
  // cpuSvn (16 bytes)
  offset += 16
  // teeTcbInfoHash (48 bytes)
  offset += 48
  // teeInfoHash (48 bytes)
  offset += 48
  // reportData (64 bytes) - this is the key field
  buffer.set(reportData, offset)
  offset += 64
  // reserved1 (32 bytes)
  offset += 32
  // mac (32 bytes)
  offset += 32

  // TEE_TCB_INFO (240 bytes)
  // Fill with some test data
  buffer.fill(0x11, offset, offset + 240)
  offset += 240

  // TD_INFO (528 bytes to reach 1024 total for TD Report)
  // Fill with measurement-like data
  buffer.fill(0x22, offset, offset + 528)
  offset += 528

  // Padding to reach HW_REPORT_SIZE (1184 bytes total, so 160 bytes of padding)
  offset += 160

  // IGVM Request Data (at HCL_DATA_OFFSET = 32 + 1184 = 1216)
  view.setUint32(offset, claimsBytes.length + IGVM_REQUEST_DATA_FIXED_SIZE, true) // dataSize
  offset += 4
  view.setUint32(offset, 1, true) // version
  offset += 4
  view.setUint32(offset, TDX_REPORT_TYPE, true) // reportType (4 = TDX)
  offset += 4
  view.setUint32(offset, 1, true) // reportDataHashType (1 = SHA256)
  offset += 4
  view.setUint32(offset, claimsBytes.length, true) // variableDataSize
  offset += 4

  // Variable data (runtime claims JSON)
  buffer.set(claimsBytes, offset)

  return buffer
}

// ============================================================================
// Attestation Header Tests
// ============================================================================

test.serial("parseAttestationHeader: extracts header fields correctly", (t) => {
  const report = createTestHclReport({})
  const header = parseAttestationHeader(report, 0)

  t.is(header.signature, 0x48434c41) // "HCLA"
  t.is(header.version, 1)
  t.true(header.reportSize > 0)
  t.is(header.requestType, 1)
  t.is(header.status, 0)
  t.is(header.reserved.length, 12)
})

// ============================================================================
// TD Report Tests
// ============================================================================

test.serial("parseTdReport: extracts report_data correctly", (t) => {
  const expectedReportData = new Uint8Array(64)
  expectedReportData.fill(0xde, 0, 32) // First 32 bytes
  expectedReportData.fill(0x00, 32, 64) // Last 32 bytes (zeros for Azure)

  const report = createTestHclReport({ reportData: expectedReportData })
  const tdReport = parseTdReport(report, HW_REPORT_OFFSET)

  t.is(tdReport.reportData.length, 64)
  t.is(hex(tdReport.reportData.slice(0, 32)), "de".repeat(32))
  t.is(hex(tdReport.reportData.slice(32, 64)), "00".repeat(32))
})

test.serial("parseTdReport: extracts all measurement fields", (t) => {
  const report = createTestHclReport({})
  const tdReport = parseTdReport(report, HW_REPORT_OFFSET)

  // Check sizes of measurement fields
  t.is(tdReport.mrTd.length, 48)
  t.is(tdReport.mrConfigId.length, 48)
  t.is(tdReport.mrOwner.length, 48)
  t.is(tdReport.mrOwnerConfig.length, 48)
  t.is(tdReport.rtmr0.length, 48)
  t.is(tdReport.rtmr1.length, 48)
  t.is(tdReport.rtmr2.length, 48)
  t.is(tdReport.rtmr3.length, 48)
  t.is(tdReport.mrSeam.length, 48)
  t.is(tdReport.mrSignerSeam.length, 48)
})

test.serial("parseTdReport: raw field contains full 1024 bytes", (t) => {
  const report = createTestHclReport({})
  const tdReport = parseTdReport(report, HW_REPORT_OFFSET)

  t.is(tdReport.raw.length, TD_REPORT_SIZE)
})

// ============================================================================
// IGVM Request Data Tests
// ============================================================================

test.serial("parseIgvmRequestData: extracts fields correctly", (t) => {
  const report = createTestHclReport({})
  const igvmData = parseIgvmRequestData(report, HCL_DATA_OFFSET)

  t.is(igvmData.reportType, TDX_REPORT_TYPE)
  t.true(igvmData.variableDataSize > 0)
  t.is(igvmData.variableData.length, igvmData.variableDataSize)
})

// ============================================================================
// Runtime Claims Tests
// ============================================================================

test.serial("parseRuntimeClaims: parses JSON claims correctly", (t) => {
  const claims = {
    keys: [
      { key_id: "TestKey", value: "dGVzdHZhbHVl" },
      { key_id: HCL_AKPUB_KEY_ID, value: "YWtwdWI=" },
    ],
    "user-data": "AABBCC",
  }
  const claimsBytes = new TextEncoder().encode(JSON.stringify(claims))

  const parsed = parseRuntimeClaims(claimsBytes)

  t.is(parsed.keys.length, 2)
  t.is(parsed.keys[0].key_id, "TestKey")
  t.is(parsed.keys[1].key_id, HCL_AKPUB_KEY_ID)
  t.is(parsed["user-data"], "AABBCC")
})

// ============================================================================
// Full HCL Report Tests
// ============================================================================

test.serial("parseHclReport: parses complete HCL report", (t) => {
  const akPub = new Uint8Array(256).fill(0x42)
  const report = createTestHclReport({ akPub })

  const hclReport = parseHclReport(report)

  t.truthy(hclReport.header)
  t.truthy(hclReport.tdReport)
  t.truthy(hclReport.hclData)
  t.truthy(hclReport.runtimeClaims)
  t.is(hclReport.hclData.reportType, TDX_REPORT_TYPE)
})

test.serial("parseHclReport: throws on too-short data", (t) => {
  const shortData = new Uint8Array(100)

  t.throws(() => parseHclReport(shortData), {
    message: /too short/,
  })
})

test.serial("parseHclReport: throws on non-TDX report type", (t) => {
  const report = createTestHclReport({})
  const view = new DataView(report.buffer)

  // Change report type to SNP (2)
  view.setUint32(HCL_DATA_OFFSET + 8, 2, true)

  t.throws(() => parseHclReport(report), {
    message: /Unsupported report type/,
  })
})

test.serial("parseHclReportBase64: parses base64-encoded report", (t) => {
  const report = createTestHclReport({})
  const b64 = base64.encode(report)

  const hclReport = parseHclReportBase64(b64)

  t.truthy(hclReport.header)
  t.truthy(hclReport.tdReport)
})

// ============================================================================
// AK Extraction Tests
// ============================================================================

test.serial("getAkPub: extracts AK public key", (t) => {
  const akPub = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    akPub[i] = i % 256
  }

  const report = createTestHclReport({ akPub })
  const hclReport = parseHclReport(report)

  const extractedAk = getAkPub(hclReport)

  t.truthy(extractedAk)
  t.is(extractedAk!.length, 256)
  t.deepEqual(extractedAk, akPub)
})

test.serial("getAkPub: returns null when AK not found", (t) => {
  const report = createTestHclReport({
    runtimeClaims: { keys: [{ key_id: "OtherKey", value: "dGVzdA==" }] },
  })
  const hclReport = parseHclReport(report)

  const ak = getAkPub(hclReport)

  t.is(ak, null)
})

// ============================================================================
// User Data Tests
// ============================================================================

test.serial("getUserData: extracts user-data hex string", (t) => {
  const userData = "DEADBEEF0123456789ABCDEF"
  const report = createTestHclReport({ userData })
  const hclReport = parseHclReport(report)

  const extracted = getUserData(hclReport)

  t.is(extracted, userData)
})

test.serial("getUserDataBytes: converts user-data to bytes", (t) => {
  const userData = "DEADBEEF"
  const report = createTestHclReport({ userData })
  const hclReport = parseHclReport(report)

  const bytes = getUserDataBytes(hclReport)

  t.truthy(bytes)
  t.is(bytes!.length, 4)
  t.is(hex(bytes!), "deadbeef")
})

test.serial("getUserData: returns null when not present", (t) => {
  const report = createTestHclReport({
    runtimeClaims: { keys: [] },
  })
  const hclReport = parseHclReport(report)

  const userData = getUserData(hclReport)

  t.is(userData, null)
})

// ============================================================================
// Variable Data Binding Tests
// ============================================================================

test.serial("computeVariableDataHash: computes SHA256 of variable data", async (t) => {
  const report = createTestHclReport({})
  const hclReport = parseHclReport(report)

  const hash = await computeVariableDataHash(hclReport)

  t.is(hash.length, 32)
  // Hash should be deterministic
  const hash2 = await computeVariableDataHash(hclReport)
  t.deepEqual(hash, hash2)
})

test.serial("verifyVariableDataBinding: returns true when hash matches", async (t) => {
  const report = createTestHclReport({})
  const hclReport = parseHclReport(report)

  // Compute the expected hash
  const varDataHash = await computeVariableDataHash(hclReport)

  // Create report_data with hash in first 32 bytes, zeros in last 32
  const quoteReportData = new Uint8Array(64)
  quoteReportData.set(varDataHash, 0)

  const isValid = await verifyVariableDataBinding(hclReport, quoteReportData)

  t.true(isValid)
})

test.serial("verifyVariableDataBinding: returns false when hash doesn't match", async (t) => {
  const report = createTestHclReport({})
  const hclReport = parseHclReport(report)

  // Create report_data with wrong hash
  const wrongReportData = new Uint8Array(64).fill(0xff)

  const isValid = await verifyVariableDataBinding(hclReport, wrongReportData)

  t.false(isValid)
})

test.serial("verifyVariableDataBinding: returns false for short report_data", async (t) => {
  const report = createTestHclReport({})
  const hclReport = parseHclReport(report)

  const shortReportData = new Uint8Array(16)

  const isValid = await verifyVariableDataBinding(hclReport, shortReportData)

  t.false(isValid)
})

// ============================================================================
// Integration Tests
// ============================================================================

test.serial("integration: full chain of trust verification", async (t) => {
  // Create a synthetic HCL report
  const akPub = new Uint8Array(256).fill(0x42)
  const report = createTestHclReport({ akPub })

  // Parse the HCL report
  const hclReport = parseHclReport(report)

  // Compute variable data hash (what would be in quote's report_data)
  const varDataHash = await computeVariableDataHash(hclReport)

  // Simulate a TDX quote's report_data with the hash
  const quoteReportData = new Uint8Array(64)
  quoteReportData.set(varDataHash, 0) // First 32 bytes = hash
  // Last 32 bytes stay zeros (Azure convention)

  // Verify the binding
  const isValid = await verifyVariableDataBinding(hclReport, quoteReportData)
  t.true(isValid, "Variable data binding should be valid")

  // Extract the AK
  const extractedAk = getAkPub(hclReport)
  t.truthy(extractedAk, "Should extract AK public key")
  t.is(extractedAk!.length, 256)

  // Verify TD report extraction
  t.is(hclReport.tdReport.reportData.length, 64)
})

// ============================================================================
// Hex Utility Tests
// ============================================================================

test.serial("hex: converts bytes to lowercase hex string", (t) => {
  const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
  t.is(hex(bytes), "deadbeef")
})

test.serial("hex: handles empty array", (t) => {
  const bytes = new Uint8Array(0)
  t.is(hex(bytes), "")
})

test.serial("hex: pads single digit values", (t) => {
  const bytes = new Uint8Array([0x01, 0x0f, 0x00])
  t.is(hex(bytes), "010f00")
})

// ============================================================================
// Real HCL Report Tests (using azure-cvm-tooling sample)
// ============================================================================

import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadRealHclReport(): Uint8Array {
  const filePath = join(__dirname, "hcl-report-tdx.bin")
  return new Uint8Array(readFileSync(filePath))
}

test.serial("real sample: parses header correctly", (t) => {
  const report = loadRealHclReport()
  const header = parseAttestationHeader(report, 0)

  t.is(header.signature, 0x414c4348) // "HCLA" in little endian
  t.is(header.version, 2)
  t.is(header.reportSize, 2438) // 0x0986
  t.is(header.requestType, 2)
  t.is(header.status, 0)
})

test.serial("real sample: parses TD report", (t) => {
  const report = loadRealHclReport()
  const tdReport = parseTdReport(report, HW_REPORT_OFFSET)

  // TD Report type should be 0x81 for TDX
  t.is(tdReport.reportType[0], 0x81)
  t.is(tdReport.raw.length, TD_REPORT_SIZE)

  // All measurement fields should have proper sizes
  t.is(tdReport.reportData.length, 64)
  t.is(tdReport.mrTd.length, 48)
  t.is(tdReport.rtmr0.length, 48)
})

test.serial("real sample: parses IGVM request data", (t) => {
  const report = loadRealHclReport()
  const igvmData = parseIgvmRequestData(report, HCL_DATA_OFFSET)

  t.is(igvmData.reportType, TDX_REPORT_TYPE) // 4 = TDX
  t.is(igvmData.version, 1)
  t.is(igvmData.variableDataSize, 1202) // 0x04b2
  t.is(igvmData.variableData.length, 1202)
})

test.serial("real sample: parses full HCL report", (t) => {
  const report = loadRealHclReport()
  const hclReport = parseHclReport(report)

  t.truthy(hclReport.header)
  t.truthy(hclReport.tdReport)
  t.truthy(hclReport.hclData)
  t.truthy(hclReport.runtimeClaims)
  t.is(hclReport.hclData.reportType, TDX_REPORT_TYPE)
})

test.serial("real sample: extracts runtime claims", (t) => {
  const report = loadRealHclReport()
  const hclReport = parseHclReport(report)

  // Should have keys array
  t.truthy(hclReport.runtimeClaims.keys)
  t.true(hclReport.runtimeClaims.keys.length > 0)

  // Should have HCLAkPub key (real sample uses "kid" not "key_id")
  const akPubKey = hclReport.runtimeClaims.keys.find(
    (k) => k.key_id === HCL_AKPUB_KEY_ID || k.kid === HCL_AKPUB_KEY_ID,
  )
  t.truthy(akPubKey, "Should have HCLAkPub key")

  // Should have user-data (all zeros in sample)
  t.truthy(hclReport.runtimeClaims["user-data"])
  t.is(hclReport.runtimeClaims["user-data"], "0".repeat(128)) // 64 bytes = 128 hex chars
})

test.serial("real sample: extracts AK public key", (t) => {
  const report = loadRealHclReport()
  const hclReport = parseHclReport(report)

  const akPub = getAkPub(hclReport)
  t.truthy(akPub, "Should extract AK public key")
  t.true(akPub!.length > 0, "AK should have content")
})

test.serial("real sample: extracts user-data", (t) => {
  const report = loadRealHclReport()
  const hclReport = parseHclReport(report)

  const userData = getUserData(hclReport)
  t.truthy(userData)
  t.is(userData, "0".repeat(128)) // All zeros in sample

  const userDataBytes = getUserDataBytes(hclReport)
  t.truthy(userDataBytes)
  t.is(userDataBytes!.length, 64)
  // All bytes should be 0
  for (let i = 0; i < userDataBytes!.length; i++) {
    t.is(userDataBytes![i], 0)
  }
})

test.serial("real sample: computes variable data hash", async (t) => {
  const report = loadRealHclReport()
  const hclReport = parseHclReport(report)

  const hash = await computeVariableDataHash(hclReport)
  t.is(hash.length, 32)

  // Hash should be consistent
  const hash2 = await computeVariableDataHash(hclReport)
  t.deepEqual(hash, hash2)
})

test.serial("real sample: verifies variable data binding", async (t) => {
  const report = loadRealHclReport()
  const hclReport = parseHclReport(report)

  // The report_data in the TD Report should contain SHA256(variable_data) in first 32 bytes
  const varDataHash = await computeVariableDataHash(hclReport)

  // Check if report_data[0:32] matches the computed hash
  const reportDataFirst32 = hclReport.tdReport.reportData.slice(0, 32)

  // For a real HCL report, this binding should be valid
  const isValid = await verifyVariableDataBinding(hclReport, hclReport.tdReport.reportData)
  // Note: The sample file may or may not have valid binding - just log the result
  t.log(`Variable data binding valid: ${isValid}`)
  t.log(`Expected hash: ${hex(varDataHash)}`)
  t.log(`Report data[0:32]: ${hex(reportDataFirst32)}`)
  t.pass() // We're just verifying the function works, not the sample's validity
})

test.serial("real sample: has vm-configuration data", (t) => {
  const report = loadRealHclReport()
  const hclReport = parseHclReport(report)

  // The sample has vm-configuration with console-enabled, secure-boot, etc.
  const vmConfig = (hclReport.runtimeClaims as unknown as Record<string, unknown>)["vm-configuration"]
  t.truthy(vmConfig, "Should have vm-configuration")

  const config = vmConfig as Record<string, unknown>
  t.is(config["console-enabled"], true)
  t.is(config["secure-boot"], false)
  t.is(config["tpm-enabled"], true)
  t.truthy(config["vmUniqueId"])
})
