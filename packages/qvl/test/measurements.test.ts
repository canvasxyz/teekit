import test from "ava"
import fs from "node:fs"
import { base64 as scureBase64 } from "@scure/base"

import {
  parseTdxQuote,
  hex,
  verifyTdx,
  verifyTdxBase64,
  verifyTdxMeasurements,
  type TdxMeasurements,
} from "@teekit/qvl"

const BASE_TIME = Date.parse("2025-09-01")

// Get a test quote and its measurements
function getTestQuote(): { quote: Uint8Array; measurements: TdxMeasurements } {
  const quoteHex = fs.readFileSync(
    "test/sampleQuotes/tdx-v4-tappd.hex",
    "utf-8",
  )
  const quote = Buffer.from(quoteHex.replace(/^0x/, ""), "hex")
  const { body } = parseTdxQuote(quote)

  return {
    quote,
    measurements: {
      mrtd: hex(body.mr_td),
      rtmr0: hex(body.rtmr0),
      rtmr1: hex(body.rtmr1),
      rtmr2: hex(body.rtmr2),
      rtmr3: hex(body.rtmr3),
      reportData: hex(body.report_data),
    },
  }
}

// ============================================================================
// verifyTdxMeasurements unit tests
// ============================================================================

test.serial("verifyTdxMeasurements: MRTD only - match", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {
    mrtd: measurements.mrtd,
  })
  t.true(result)
})

test.serial("verifyTdxMeasurements: MRTD only - mismatch", async (t) => {
  const { quote } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {
    mrtd: "0".repeat(96), // wrong MRTD
  })
  t.false(result)
})

test.serial("verifyTdxMeasurements: RTMR1 only - match", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {
    rtmr1: measurements.rtmr1,
  })
  t.true(result)
})

test.serial("verifyTdxMeasurements: RTMR2 only - match", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {
    rtmr2: measurements.rtmr2,
  })
  t.true(result)
})

test.serial("verifyTdxMeasurements: RTMR1 only - mismatch", async (t) => {
  const { quote } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {
    rtmr1: "f".repeat(96), // wrong RTMR1
  })
  t.false(result)
})

test.serial("verifyTdxMeasurements: MRTD + RTMR1 + RTMR2 - all match", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {
    mrtd: measurements.mrtd,
    rtmr1: measurements.rtmr1,
    rtmr2: measurements.rtmr2,
  })
  t.true(result)
})

test.serial("verifyTdxMeasurements: MRTD + RTMR2 - MRTD matches, RTMR2 fails", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {
    mrtd: measurements.mrtd,
    rtmr2: "1".repeat(96), // wrong RTMR2
  })
  t.false(result)
})

test.serial("verifyTdxMeasurements: all RTMRs - match", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {
    rtmr0: measurements.rtmr0,
    rtmr1: measurements.rtmr1,
    rtmr2: measurements.rtmr2,
    rtmr3: measurements.rtmr3,
  })
  t.true(result)
})

test.serial("verifyTdxMeasurements: empty config passes (no constraints)", async (t) => {
  const { quote } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {})
  t.true(result)
})

test.serial("verifyTdxMeasurements: case-insensitive hex comparison", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  // Use uppercase MRTD
  const result = await verifyTdxMeasurements(parsedQuote, {
    mrtd: measurements.mrtd!.toUpperCase(),
  })
  t.true(result)
})

// ============================================================================
// Array config (OR logic) tests
// ============================================================================

test.serial("verifyTdxMeasurements: array - first config matches", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, [
    { mrtd: measurements.mrtd }, // matches
    { mrtd: "0".repeat(96) }, // doesn't match
  ])
  t.true(result)
})

test.serial("verifyTdxMeasurements: array - second config matches", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, [
    { mrtd: "0".repeat(96) }, // doesn't match
    { mrtd: measurements.mrtd }, // matches
  ])
  t.true(result)
})

test.serial("verifyTdxMeasurements: array - no config matches", async (t) => {
  const { quote } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, [
    { mrtd: "0".repeat(96) }, // doesn't match
    { mrtd: "1".repeat(96) }, // doesn't match
    { mrtd: "2".repeat(96) }, // doesn't match
  ])
  t.false(result)
})

test.serial("verifyTdxMeasurements: array - complex OR conditions", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  // Simulate multiple valid deployment configurations
  const result = await verifyTdxMeasurements(parsedQuote, [
    // Version 1.0 (different MRTD)
    { mrtd: "0".repeat(96), rtmr2: "a".repeat(96) },
    // Version 1.1 (different MRTD)
    { mrtd: "1".repeat(96), rtmr2: "b".repeat(96) },
    // Current version (matches)
    { mrtd: measurements.mrtd, rtmr2: measurements.rtmr2 },
  ])
  t.true(result)
})

// ============================================================================
// Custom verifier tests
// ============================================================================

test.serial("verifyTdxMeasurements: custom verifier - returns true", async (t) => {
  const { quote } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, () => true)
  t.true(result)
})

test.serial("verifyTdxMeasurements: custom verifier - returns false", async (t) => {
  const { quote } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, () => false)
  t.false(result)
})

test.serial("verifyTdxMeasurements: async custom verifier", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, async (q) => {
    // Simulate async lookup
    await new Promise((resolve) => setTimeout(resolve, 10))
    return hex(q.body.mr_td) === measurements.mrtd
  })
  t.true(result)
})

test.serial("verifyTdxMeasurements: custom verifier receives quote", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  let receivedMrtd: string | undefined

  await verifyTdxMeasurements(parsedQuote, (q) => {
    receivedMrtd = hex(q.body.mr_td)
    return true
  })

  t.is(receivedMrtd, measurements.mrtd)
})

// ============================================================================
// Mixed array (static configs + custom verifiers) tests
// ============================================================================

test.serial("verifyTdxMeasurements: mixed array - static config matches", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, [
    { mrtd: measurements.mrtd }, // matches
    () => false, // custom verifier fails
  ])
  t.true(result)
})

test.serial("verifyTdxMeasurements: mixed array - custom verifier matches", async (t) => {
  const { quote } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, [
    { mrtd: "0".repeat(96) }, // doesn't match
    () => true, // custom verifier succeeds
  ])
  t.true(result)
})

test.serial("verifyTdxMeasurements: mixed array - none match", async (t) => {
  const { quote } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, [
    { mrtd: "0".repeat(96) }, // doesn't match
    () => false, // custom verifier fails
    { rtmr2: "1".repeat(96) }, // doesn't match
  ])
  t.false(result)
})

// ============================================================================
// Integration with verifyTdx tests
// ============================================================================

test.serial("verifyTdx with verifyMeasurements: MRTD match", async (t) => {
  const { quote, measurements } = getTestQuote()

  const result = await verifyTdx(quote, {
    date: BASE_TIME,
    crls: [],
    verifyTcb: () => true,
    verifyMeasurements: {
      mrtd: measurements.mrtd,
    },
  })
  t.true(result)
})

test.serial("verifyTdx with verifyMeasurements: MRTD mismatch throws", async (t) => {
  const { quote } = getTestQuote()

  const err = await t.throwsAsync(async () =>
    await verifyTdx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
      verifyMeasurements: {
        mrtd: "0".repeat(96),
      },
    }),
  )
  t.truthy(err)
  t.regex(err!.message, /measurement verification failed/i)
})

test.serial("verifyTdx with verifyMeasurements: RTMR1 + RTMR2 match", async (t) => {
  const { quote, measurements } = getTestQuote()

  const result = await verifyTdx(quote, {
    date: BASE_TIME,
    crls: [],
    verifyTcb: () => true,
    verifyMeasurements: {
      rtmr1: measurements.rtmr1,
      rtmr2: measurements.rtmr2,
    },
  })
  t.true(result)
})

test.serial("verifyTdx with verifyMeasurements: array config", async (t) => {
  const { quote, measurements } = getTestQuote()

  const result = await verifyTdx(quote, {
    date: BASE_TIME,
    crls: [],
    verifyTcb: () => true,
    verifyMeasurements: [
      { mrtd: "wrong" + "0".repeat(91) },
      { mrtd: measurements.mrtd }, // matches
    ],
  })
  t.true(result)
})

test.serial("verifyTdx with verifyMeasurements: custom verifier", async (t) => {
  const { quote, measurements } = getTestQuote()

  const result = await verifyTdx(quote, {
    date: BASE_TIME,
    crls: [],
    verifyTcb: () => true,
    verifyMeasurements: (q) => hex(q.body.mr_td) === measurements.mrtd,
  })
  t.true(result)
})

test.serial("verifyTdx without verifyMeasurements: no measurement check", async (t) => {
  const { quote } = getTestQuote()

  // Should pass even though we're not checking measurements
  const result = await verifyTdx(quote, {
    date: BASE_TIME,
    crls: [],
    verifyTcb: () => true,
  })
  t.true(result)
})

test.serial("verifyTdxBase64 with verifyMeasurements", async (t) => {
  const { quote, measurements } = getTestQuote()
  const quoteBase64 = scureBase64.encode(quote)

  const result = await verifyTdxBase64(quoteBase64, {
    date: BASE_TIME,
    crls: [],
    verifyTcb: () => true,
    verifyMeasurements: {
      mrtd: measurements.mrtd,
      rtmr1: measurements.rtmr1,
    },
  })
  t.true(result)
})

// ============================================================================
// Edge cases
// ============================================================================

test.serial("verifyTdxMeasurements: empty array fails", async (t) => {
  const { quote } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  // Empty array means no config matches (OR of nothing = false)
  const result = await verifyTdxMeasurements(parsedQuote, [])
  t.false(result)
})

// ============================================================================
// reportData verification tests
// ============================================================================

test.serial("verifyTdxMeasurements: reportData only - match", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {
    reportData: measurements.reportData,
  })
  t.true(result)
})

test.serial("verifyTdxMeasurements: reportData only - mismatch", async (t) => {
  const { quote } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {
    reportData: "0".repeat(128), // wrong reportData (64 bytes = 128 hex chars)
  })
  t.false(result)
})

test.serial("verifyTdxMeasurements: MRTD + reportData - both match", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {
    mrtd: measurements.mrtd,
    reportData: measurements.reportData,
  })
  t.true(result)
})

test.serial("verifyTdxMeasurements: MRTD + reportData - reportData fails", async (t) => {
  const { quote, measurements } = getTestQuote()
  const parsedQuote = parseTdxQuote(quote)

  const result = await verifyTdxMeasurements(parsedQuote, {
    mrtd: measurements.mrtd,
    reportData: "f".repeat(128), // wrong reportData
  })
  t.false(result)
})

test.serial("verifyTdx with verifyMeasurements: MRTD + reportData", async (t) => {
  const { quote, measurements } = getTestQuote()

  const result = await verifyTdx(quote, {
    date: BASE_TIME,
    crls: [],
    verifyTcb: () => true,
    verifyMeasurements: {
      mrtd: measurements.mrtd,
      reportData: measurements.reportData,
    },
  })
  t.true(result)
})
