// @ts-nocheck
import test from "ava"
import fs from "node:fs"
import {
  hex,
  parseTdxQuote,
  parseTdxQuoteBase64,
  verifyTdx,
  verifyTdxBase64,
  getTdx10SignedRegion,
  QV_X509Certificate,
  extractPemCertificates,
  verifyPCKChain,
  computeCertSha256Hex,
  normalizeSerialHex,
} from "../qvl/index.js"
import {
  rebuildQuoteWithCertData,
  tamperPemSignature,
  buildCRLWithSerials,
} from "./qvl-helpers.js"

const BASE_TIME = Date.parse("2025-09-01")

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

// Replicate negative tests from TDXv4 suite for V5 by using a base64 quote sample
// We currently only have a V4 GCP base64 sample; the structural checks apply to V5 too
// by mutating the same fields. We upgrade header.version to 5 where relevant.

function getGcpQuoteBase64(): string {
  const data = JSON.parse(
    fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"),
  )
  return data.tdx.quote as string
}

async function getGcpCertPems(): Promise<{
  leaf: string
  intermediate: string
  root: string
  all: string[]
}> {
  const quoteB64 = getGcpQuoteBase64()
  const { signature } = parseTdxQuoteBase64(quoteB64)
  const pems = extractPemCertificates(signature.cert_data)
  const { chain } = await verifyPCKChain(pems, null)
  const hashToPem = new Map<string, string>()
  for (const pem of pems) {
    const h = await computeCertSha256Hex(new QV_X509Certificate(pem))
    hashToPem.set(h, pem)
  }
  const leafPem = hashToPem.get(await computeCertSha256Hex(chain[0]))!
  const intermediatePem = hashToPem.get(await computeCertSha256Hex(chain[1]))!
  const rootPem = hashToPem.get(await computeCertSha256Hex(chain[2]))!
  return {
    leaf: leafPem,
    intermediate: intermediatePem,
    root: rootPem,
    all: pems,
  }
}

test.serial("Reject a V5 TDX quote, missing root cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  // bump version to 5
  const buf = Buffer.from(quoteB64, "base64")
  buf.writeUInt16LE(5, 0)
  const b64v5 = buf.toString("base64")
  const err = await t.throwsAsync(
    async () =>
      await verifyTdxBase64(b64v5, {
        pinnedRootCerts: [],
        date: BASE_TIME,
        crls: [],
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid root/i)
})

test.serial("Reject a V5 TDX quote, missing intermediate cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const buf = Buffer.from(quoteB64, "base64")
  buf.writeUInt16LE(5, 0)
  const { leaf, root } = await getGcpCertPems()
  const noEmbedded = rebuildQuoteWithCertData(buf, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [leaf, root],
        crls: [],
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid root/i)
})

test.serial("Reject a V5 TDX quote, missing leaf cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const buf = Buffer.from(quoteB64, "base64")
  buf.writeUInt16LE(5, 0)
  const { intermediate, root } = await getGcpCertPems()
  const noEmbedded = rebuildQuoteWithCertData(buf, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [intermediate, root],
        crls: [],
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid cert chain/i)
})

test.serial("Reject a V5 TDX quote, revoked root cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const buf = Buffer.from(quoteB64, "base64")
  buf.writeUInt16LE(5, 0)
  const { root } = await getGcpCertPems()
  const rootSerial = normalizeSerialHex(
    new QV_X509Certificate(root).serialNumber,
  )
  const crl = buildCRLWithSerials([rootSerial])
  const err = await t.throwsAsync(
    async () => await verifyTdxBase64(buf.toString("base64"), { date: BASE_TIME, crls: [crl] }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject a V5 TDX quote, invalid root self-signature", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const buf = Buffer.from(quoteB64, "base64")
  buf.writeUInt16LE(5, 0)
  const { leaf, intermediate, root } = await getGcpCertPems()
  const tamperedRoot = tamperPemSignature(root)
  const noEmbedded = rebuildQuoteWithCertData(buf, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [leaf, intermediate, tamperedRoot],
        crls: [],
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid cert chain/i)
})

test.serial("Reject a V5 TDX quote, incorrect QE signature", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  original.writeUInt16LE(5, 0)
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
  t.regex(err!.message, /invalid qe report signature/i)
})

test.serial("Reject a V5 TDX quote, incorrect QE binding", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  original.writeUInt16LE(5, 0)
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
  t.regex(err!.message, /invalid qe report binding/i)
})

test.serial("Reject a V5 TDX quote, incorrect TD signature", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  original.writeUInt16LE(5, 0)
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
  t.regex(err!.message, /invalid signature over quote/i)
})

test.serial("Reject a V5 TDX quote, unsupported cert_data_type", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  original.writeUInt16LE(5, 0)
  const signedLen = getTdx10SignedRegion(original).length
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
    async () => await verifyTdx(mutated, { date: BASE_TIME, crls: [] }),
  )
  t.truthy(err)
  t.regex(err!.message, /only PCK cert_data is supported/i)
})

test.serial(
  "Reject a V5 TDX quote, missing certdata (no fallback)",
  async (t) => {
    const quoteB64 = getGcpQuoteBase64()
    const base = Buffer.from(quoteB64, "base64")
    base.writeUInt16LE(5, 0)
    const noEmbedded = rebuildQuoteWithCertData(base, Buffer.alloc(0))
    const err = await t.throwsAsync(
      async () => await verifyTdx(noEmbedded, { date: BASE_TIME, crls: [] }),
    )
    t.truthy(err)
    t.regex(err!.message, /missing certdata/i)
  },
)

test.serial(
  "Reject a V5 TDX quote, cert chain not yet valid (too early)",
  async (t) => {
    const quoteB64 = getGcpQuoteBase64()
    const buf = Buffer.from(quoteB64, "base64")
    buf.writeUInt16LE(5, 0)
    const early = Date.parse("2000-01-01")
    const err = await t.throwsAsync(
      async () => await verifyTdx(buf, { date: early, crls: [] }),
    )
    t.truthy(err)
    t.regex(err!.message, /expired cert chain, or not yet valid/i)
  },
)

test.serial(
  "Reject a V5 TDX quote, cert chain expired (too late)",
  async (t) => {
    const quoteB64 = getGcpQuoteBase64()
    const buf = Buffer.from(quoteB64, "base64")
    buf.writeUInt16LE(5, 0)
    const late = Date.parse("2100-01-01")
    const err = await t.throwsAsync(
      async () => await verifyTdx(buf, { date: late, crls: [] }),
    )
    t.truthy(err)
    t.regex(err!.message, /expired cert chain, or not yet valid/i)
  },
)

test.serial("Reject a V5 TDX quote, revoked intermediate cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const buf = Buffer.from(quoteB64, "base64")
  buf.writeUInt16LE(5, 0)
  const { intermediate } = await getGcpCertPems()
  const serial = normalizeSerialHex(
    new QV_X509Certificate(intermediate).serialNumber,
  )
  const crl = buildCRLWithSerials([serial])
  const err = await t.throwsAsync(
    async () => await verifyTdxBase64(buf.toString("base64"), { date: BASE_TIME, crls: [crl] }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject a V5 TDX quote, revoked leaf cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const buf = Buffer.from(quoteB64, "base64")
  buf.writeUInt16LE(5, 0)
  const { leaf } = await getGcpCertPems()
  const serial = normalizeSerialHex(new QV_X509Certificate(leaf).serialNumber)
  const crl = buildCRLWithSerials([serial])
  const err = await t.throwsAsync(
    async () => await verifyTdxBase64(buf.toString("base64"), { date: BASE_TIME, crls: [crl] }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject a V5 TDX quote, unsupported TEE type", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  original.writeUInt16LE(5, 0)
  // header.tee_type at offset 4 (UInt32LE)
  original.writeUInt32LE(0, 4)
  const err = await t.throwsAsync(
    async () => await verifyTdx(original, { date: BASE_TIME, crls: [] }),
  )
  t.truthy(err)
  t.regex(err!.message, /only tdx is supported/i)
})

test.serial(
  "Reject a V5 TDX quote, unsupported attestation key type",
  async (t) => {
    const quoteB64 = getGcpQuoteBase64()
    const original = Buffer.from(quoteB64, "base64")
    original.writeUInt16LE(5, 0)
    // header.att_key_type at offset 2 (UInt16LE)
    original.writeUInt16LE(1, 2)
    const err = await t.throwsAsync(
      async () => await verifyTdx(original, { date: BASE_TIME, crls: [] }),
    )
    t.truthy(err)
    t.regex(err!.message, /only ECDSA att_key_type is supported/i)
  },
)

test.serial("Reject a TDX v5 quote with unsupported version", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  // header.version at offset 0 (UInt16LE)
  original.writeUInt16LE(6, 0)
  const err = await t.throwsAsync(
    async () => await verifyTdx(original, { date: BASE_TIME, crls: [] }),
  )
  t.truthy(err)
  t.regex(err!.message, /Unsupported quote version/i)
})

