import test from "ava"
import fs from "node:fs"
import {
  parseTdxQuote,
  hex,
  verifyTdx,
  getTdx10SignedRegion,
  QV_X509Certificate,
  normalizeSerialHex,
} from "../qvl"
import {
  BASE_TIME,
  tamperPemSignature,
  buildCRLWithSerials,
  rebuildQuoteWithCertData,
  getV5QuoteBuffer,
  getV5CertPems,
} from "./qvl-helpers"

test.serial("Verify a V5 TDX quote from Trustee", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v5-trustee.dat")
  const { header, body } = parseTdxQuote(quote)

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

  t.true(await verifyTdx(quote, { date: BASE_TIME, crls: [] }))
})

// ---------------------- Negative tests (replicated from v4) ----------------------

test.serial("Reject a V5 TDX quote, missing root cert", async (t) => {
  const quote = getV5QuoteBuffer()
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(quote, {
        pinnedRootCerts: [],
        date: BASE_TIME,
        crls: [],
      }),
  )
  t.truthy(err)
})

test.serial("Reject a V5 TDX quote, missing intermediate cert", async (t) => {
  const original = getV5QuoteBuffer()
  const { leaf, root } = await getV5CertPems()
  const noEmbedded = rebuildQuoteWithCertData(original, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [leaf, root],
        crls: [],
      }),
  )
  t.truthy(err)
})

test.serial("Reject a V5 TDX quote, missing leaf cert", async (t) => {
  const original = getV5QuoteBuffer()
  const { intermediate, root } = await getV5CertPems()
  const noEmbedded = rebuildQuoteWithCertData(original, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [intermediate, root],
        crls: [],
      }),
  )
  t.truthy(err)
})

test.serial("Reject a V5 TDX quote, revoked root cert", async (t) => {
  const { root } = await getV5CertPems()
  const serial = normalizeSerialHex(new QV_X509Certificate(root).serialNumber)
  const crl = buildCRLWithSerials([serial])
  const err = await t.throwsAsync(
    async () => await verifyTdx(getV5QuoteBuffer(), { date: BASE_TIME, crls: [crl] }),
  )
  t.truthy(err)
})

test.serial("Reject a V5 TDX quote, revoked intermediate cert", async (t) => {
  const { intermediate } = await getV5CertPems()
  const serial = normalizeSerialHex(new QV_X509Certificate(intermediate).serialNumber)
  const crl = buildCRLWithSerials([serial])
  const err = await t.throwsAsync(
    async () => await verifyTdx(getV5QuoteBuffer(), { date: BASE_TIME, crls: [crl] }),
  )
  t.truthy(err)
})

test.serial("Reject a V5 TDX quote, revoked leaf cert", async (t) => {
  const { leaf } = await getV5CertPems()
  const serial = normalizeSerialHex(new QV_X509Certificate(leaf).serialNumber)
  const crl = buildCRLWithSerials([serial])
  const err = await t.throwsAsync(
    async () => await verifyTdx(getV5QuoteBuffer(), { date: BASE_TIME, crls: [crl] }),
  )
  t.truthy(err)
})

test.serial("Reject a V5 TDX quote, invalid root self-signature", async (t) => {
  const original = getV5QuoteBuffer()
  const { leaf, intermediate, root } = await getV5CertPems()
  const tamperedRoot = tamperPemSignature(root)
  const noEmbedded = rebuildQuoteWithCertData(original, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [leaf, intermediate, tamperedRoot],
        crls: [],
      }),
  )
  t.truthy(err)
})

test.serial("Reject a V5 TDX quote, invalid intermediate cert signature", async (t) => {
  const original = getV5QuoteBuffer()
  const { leaf, intermediate, root } = await getV5CertPems()
  const tamperedIntermediate = tamperPemSignature(intermediate)
  const noEmbedded = rebuildQuoteWithCertData(original, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [leaf, tamperedIntermediate, root],
        crls: [],
      }),
  )
  t.truthy(err)
})

test.serial("Reject a V5 TDX quote, invalid leaf cert signature", async (t) => {
  const original = getV5QuoteBuffer()
  const { leaf, intermediate, root } = await getV5CertPems()
  const tamperedLeaf = tamperPemSignature(leaf)
  const noEmbedded = rebuildQuoteWithCertData(original, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [tamperedLeaf, intermediate, root],
        crls: [],
      }),
  )
  t.truthy(err)
})

test.serial("Reject a V5 TDX quote, incorrect QE signature", async (t) => {
  const original = Buffer.from(getV5QuoteBuffer())
  const signedLen = getTdx10SignedRegion(original).length
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
    async () => await verifyTdx(mutated, { date: BASE_TIME, crls: [] }),
  )
  t.truthy(err)
})

test.serial("Reject a V5 TDX quote, incorrect QE binding", async (t) => {
  const original = Buffer.from(getV5QuoteBuffer())
  const signedLen = getTdx10SignedRegion(original).length
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
    async () => await verifyTdx(mutated, { date: BASE_TIME, crls: [] }),
  )
  t.truthy(err)
})

test.serial("Reject a V5 TDX quote, incorrect TD signature", async (t) => {
  const original = Buffer.from(getV5QuoteBuffer())
  const signedLen = getTdx10SignedRegion(original).length
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
    async () => await verifyTdx(mutated, { date: BASE_TIME, crls: [] }),
  )
  t.truthy(err)
})

test.serial("Reject a V5 TDX quote, missing certdata (no fallback)", async (t) => {
  const base = getV5QuoteBuffer()
  const noEmbedded = rebuildQuoteWithCertData(base, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () => await verifyTdx(noEmbedded, { date: BASE_TIME, crls: [] }),
  )
  t.truthy(err)
})

