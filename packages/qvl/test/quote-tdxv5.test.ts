import test from "ava"
import fs from "node:fs"
import {
  hex,
  parseTdxQuote,
  verifyTdx,
  _verifyTdx,
  getTdx15SignedRegion,
  QV_X509Certificate,
} from "@teekit/qvl"
import { normalizeSerialHex } from "@teekit/qvl/utils"
import {
  rebuildTdxQuoteWithCertData,
  tamperPemSignature,
  buildCRL,
  getCertPemsFromQuote,
} from "./qvl-helpers.js"

const BASE_TIME = Date.parse("2025-09-01")

test.serial("Verify a V5 TDX quote from Trustee", async (t) => {
  const quote = fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat")
  const { header, body, signature } = parseTdxQuote(quote)
  const { fmspc, pcesvn } = await _verifyTdx(quote)

  const expectedMRTD =
    "dfba221b48a22af8511542ee796603f37382800840dcd978703909bf8e64d4c8a1e9de86e7c9638bfcba422f3886400a"
  const expectedReportData =
    "6d6ab13b046cff606ac0074be13981b07b6325dba10b5facc96febf551c0c3be2b75f92fe1f88f4bb996969ad0174b4b7a70261b7b85c844f4b33a4674fd049f"

  t.is(header.version, 5)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.is(hex(body.tee_tcb_svn), "05010200000000000000000000000000")
  t.is(fmspc, "90c06f000000")
  t.is(pcesvn, 13)
  t.is(signature.body_type, 3) // 3 = TDX 1.5 body

  t.true(
    await verifyTdx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

async function getTrusteeCertPems(): Promise<{
  leaf: string
  intermediate: string
  root: string
  all: string[]
}> {
  const quote = fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat")
  return getCertPemsFromQuote(quote, { tdx: true })
}

test.serial("Reject a V5 TDX quote, missing root cert", async (t) => {
  const buf = fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat")
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(buf, {
        pinnedRootCerts: [],
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid root/i)
})

test.serial("Reject a V5 TDX quote, missing intermediate cert", async (t) => {
  const buf = fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat")
  const { leaf, root } = await getTrusteeCertPems()
  const noEmbedded = rebuildTdxQuoteWithCertData(buf, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [leaf, root],
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid root/i)
})

test.serial("Reject a V5 TDX quote, missing leaf cert", async (t) => {
  const buf = fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat")
  const { intermediate, root } = await getTrusteeCertPems()
  const noEmbedded = rebuildTdxQuoteWithCertData(buf, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [intermediate, root],
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid cert chain/i)
})

test.serial("Reject a V5 TDX quote, revoked root cert", async (t) => {
  const buf = fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat")
  const { root } = await getTrusteeCertPems()
  const rootSerial = normalizeSerialHex(
    new QV_X509Certificate(root).serialNumber,
  )
  const crl = buildCRL([rootSerial])
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(buf, {
        date: BASE_TIME,
        crls: [crl],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject a V5 TDX quote, invalid root self-signature", async (t) => {
  const buf = fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat")
  const { leaf, intermediate, root } = await getTrusteeCertPems()
  const tamperedRoot = tamperPemSignature(root)
  const noEmbedded = rebuildTdxQuoteWithCertData(buf, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [leaf, intermediate, tamperedRoot],
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid cert chain/i)
})

test.serial("Reject a V5 TDX quote, incorrect QE signature", async (t) => {
  const original = Buffer.from(
    fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat"),
  )
  const signedLen = getTdx15SignedRegion(original).length
  const sigLen = original.readUInt32LE(signedLen)
  const sigStart = signedLen + 4
  const sigData = Buffer.from(original.subarray(sigStart, sigStart + sigLen))
  const qeReportSigOffset = 64 + 64 + 6 + 384 // inside sig_data
  sigData[qeReportSigOffset + 10] ^= 0x01
  const mutated = Buffer.concat([
    original.subarray(0, signedLen),
    Buffer.from(
      new Uint8Array([
        sigData.length & 0xff,
        (sigData.length >> 8) & 0xff,
        (sigData.length >> 16) & 0xff,
        (sigData.length >> 24) & 0xff,
      ]),
    ),
    sigData,
  ])
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(mutated, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid qe report signature/i)
})

test.serial("Reject a V5 TDX quote, incorrect QE binding", async (t) => {
  const original = Buffer.from(
    fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat"),
  )
  const signedLen = getTdx15SignedRegion(original).length
  const sigLen = original.readUInt32LE(signedLen)
  const sigStart = signedLen + 4
  const sigData = Buffer.from(original.subarray(sigStart, sigStart + sigLen))
  const attPubKeyOffset = 64 // inside sig_data
  sigData[attPubKeyOffset + 0] ^= 0x01
  const mutated = Buffer.concat([
    original.subarray(0, signedLen),
    Buffer.from(
      new Uint8Array([
        sigData.length & 0xff,
        (sigData.length >> 8) & 0xff,
        (sigData.length >> 16) & 0xff,
        (sigData.length >> 24) & 0xff,
      ]),
    ),
    sigData,
  ])
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(mutated, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid qe report binding/i)
})

test.serial("Reject a V5 TDX quote, incorrect TD signature", async (t) => {
  const original = Buffer.from(
    fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat"),
  )
  const signedLen = getTdx15SignedRegion(original).length
  const sigLen = original.readUInt32LE(signedLen)
  const sigStart = signedLen + 4
  const sigData = Buffer.from(original.subarray(sigStart, sigStart + sigLen))
  const ecdsaSigOffset = 0 // inside sig_data
  sigData[ecdsaSigOffset + 3] ^= 0x01
  const mutated = Buffer.concat([
    original.subarray(0, signedLen),
    Buffer.from(
      new Uint8Array([
        sigData.length & 0xff,
        (sigData.length >> 8) & 0xff,
        (sigData.length >> 16) & 0xff,
        (sigData.length >> 24) & 0xff,
      ]),
    ),
    sigData,
  ])
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(mutated, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid signature over quote/i)
})

test.serial("Reject a V5 TDX quote, unsupported cert_data_type", async (t) => {
  const original = Buffer.from(
    fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat"),
  )
  const signedLen = getTdx15SignedRegion(original).length
  const sigLen = original.readUInt32LE(signedLen)
  const sigStart = signedLen + 4
  const sigData = Buffer.from(original.subarray(sigStart, sigStart + sigLen))

  const fixedOffset = 64 + 64 + 6 + 384 + 64
  const qeAuthLen = sigData.readUInt16LE(fixedOffset)
  const tailOffset = fixedOffset + 2 + qeAuthLen
  // Overwrite cert_data_type (UInt16LE) with an unsupported value
  sigData.writeUInt16LE(1, tailOffset)

  const mutated = Buffer.concat([
    original.subarray(0, signedLen),
    Buffer.from(
      new Uint8Array([
        sigData.length & 0xff,
        (sigData.length >> 8) & 0xff,
        (sigData.length >> 16) & 0xff,
        (sigData.length >> 24) & 0xff,
      ]),
    ),
    sigData,
  ])

  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(mutated, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /only PCK cert_data is supported/i)
})

test.serial(
  "Reject a V5 TDX quote, missing certdata (no fallback)",
  async (t) => {
    const base = fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat")
    const noEmbedded = rebuildTdxQuoteWithCertData(base, Buffer.alloc(0))
    const err = await t.throwsAsync(
      async () =>
        await verifyTdx(noEmbedded, {
          date: BASE_TIME,
          crls: [],
          verifyTcb: () => true,
        }),
    )
    t.truthy(err)
    t.regex(err!.message, /missing certdata/i)
  },
)

test.serial(
  "Reject a V5 TDX quote, cert chain not yet valid (too early)",
  async (t) => {
    const buf = fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat")
    const early = Date.parse("2000-01-01")
    const err = await t.throwsAsync(
      async () =>
        await verifyTdx(buf, { date: early, crls: [], verifyTcb: () => true }),
    )
    t.truthy(err)
    t.regex(err!.message, /expired cert chain, or not yet valid/i)
  },
)

test.serial(
  "Reject a V5 TDX quote, cert chain expired (too late)",
  async (t) => {
    const buf = fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat")
    const late = Date.parse("2100-01-01")
    const err = await t.throwsAsync(
      async () =>
        await verifyTdx(buf, { date: late, crls: [], verifyTcb: () => true }),
    )
    t.truthy(err)
    t.regex(err!.message, /expired cert chain, or not yet valid/i)
  },
)

test.serial("Reject a V5 TDX quote, revoked intermediate cert", async (t) => {
  const buf = fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat")
  const { intermediate } = await getTrusteeCertPems()
  const serial = normalizeSerialHex(
    new QV_X509Certificate(intermediate).serialNumber,
  )
  const crl = buildCRL([serial])
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(buf, {
        date: BASE_TIME,
        crls: [crl],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject a V5 TDX quote, revoked leaf cert", async (t) => {
  const buf = fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat")
  const { leaf } = await getTrusteeCertPems()
  const serial = normalizeSerialHex(new QV_X509Certificate(leaf).serialNumber)
  const crl = buildCRL([serial])
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(buf, {
        date: BASE_TIME,
        crls: [crl],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject a V5 TDX quote, unsupported TEE type", async (t) => {
  const original = Buffer.from(
    fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat"),
  )
  // header.tee_type at offset 4 (UInt32LE)
  original.writeUInt32LE(0, 4)
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(original, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /only tdx is supported/i)
})

test.serial(
  "Reject a V5 TDX quote, unsupported attestation key type",
  async (t) => {
    const original = Buffer.from(
      fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat"),
    )
    // header.att_key_type at offset 2 (UInt16LE)
    original.writeUInt16LE(1, 2)
    const err = await t.throwsAsync(
      async () =>
        await verifyTdx(original, {
          date: BASE_TIME,
          crls: [],
          verifyTcb: () => true,
        }),
    )
    t.truthy(err)
    t.regex(err!.message, /only ECDSA att_key_type is supported/i)
  },
)

test.serial("Reject a TDX v5 quote with unsupported version", async (t) => {
  const original = Buffer.from(
    fs.readFileSync("test/sampleQuotes/tdx-v5-trustee.dat"),
  )
  // header.version at offset 0 (UInt16LE)
  original.writeUInt16LE(6, 0)
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(original, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /Unsupported quote version/i)
})
