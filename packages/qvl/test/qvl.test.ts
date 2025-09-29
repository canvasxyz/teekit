import test from "ava"
import fs from "node:fs"
import { base64 as scureBase64 } from "@scure/base"

import {
  parseTdxQuote,
  parseTdxQuoteBase64,
  hex,
  verifyTdx,
  _verifyTdx,
  verifyTdxBase64,
  getTdx10SignedRegion,
  QV_X509Certificate,
} from "ra-https-qvl"
import {
  extractPemCertificates,
  reverseHexBytes,
  normalizeSerialHex,
} from "ra-https-qvl/utils"
import {
  tamperPemSignature,
  buildCRL,
  rebuildTdxQuoteWithCertData,
  getCertPemsFromQuote,
} from "./qvl-helpers.js"

const BASE_TIME = Date.parse("2025-09-01")

test.serial("Verify a V4 TDX quote from Tappd", async (t) => {
  const quoteHex = fs.readFileSync("test/sample/tdx-v4-tappd.hex", "utf-8")
  const quote = Buffer.from(quoteHex.replace(/^0x/, ""), "hex")

  const { header, body } = parseTdxQuote(quote)
  const { fmspc } = await _verifyTdx(quote)

  const expectedMRTD =
    "c68518a0ebb42136c12b2275164f8c72f25fa9a34392228687ed6e9caeb9c0f1dbd895e9cf475121c029dc47e70e91fd"
  const expectedReportData =
    "7668c6b4eafb62301c72714ecc7d90ce9a0e04b52dc117720df2047b0a59f1dbd937243eef1410a3cdc524aad66d4554b4f18b54da2fc0608dac40d6dea5f1d4"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.is(fmspc, "b0c06f000000")
  t.is(header.pce_svn, 0)

  t.true(
    await verifyTdx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

test.serial("Verify a V4 TDX quote from Edgeless", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-edgeless.dat")

  const { header, body } = parseTdxQuote(quote)
  const { fmspc } = await _verifyTdx(quote)

  const expectedMRTD =
    "b65ea009e424e6f761fdd3d7c8962439453b37ecdf62da04f7bc5d327686bb8bafc8a5d24a9c31cee60e4aba87c2f71b"
  const expectedReportData =
    "48656c6c6f2066726f6d20456467656c6573732053797374656d7321000000000000000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.is(fmspc, "00806f050000")
  t.is(header.pce_svn, 0)

  t.true(
    await verifyTdx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

test.serial("Verify a V4 TDX quote from Phala, bin format", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-phala.dat")

  const { header, body } = parseTdxQuote(quote)
  const { fmspc } = await _verifyTdx(quote)

  const expectedMRTD =
    "91eb2b44d141d4ece09f0c75c2c53d247a3c68edd7fafe8a3520c942a604a407de03ae6dc5f87f27428b2538873118b7"
  const expectedReportData =
    "9a9d48e7f6799642d3d1b34e1e5e1742d4bb02dd6ddd551862c1211d35c304f9eca3efdbb481601c163cf52493d6e44aed55d51ec39b7e518fadb92c2b523f20"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.is(fmspc, "b0c06f000000")
  t.is(header.pce_svn, 0)

  t.true(
    await verifyTdx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

test.serial("Verify a V4 TDX quote from Phala, hex format", async (t) => {
  const quoteHex = fs.readFileSync("test/sample/tdx-v4-phala.hex", "utf-8")
  const quote = Buffer.from(quoteHex.replace(/^0x/, ""), "hex")

  const { header, body } = parseTdxQuote(quote)
  const { fmspc } = await _verifyTdx(quote)

  const expectedMRTD =
    "7ba9e262ce6979087e34632603f354dd8f8a870f5947d116af8114db6c9d0d74c48bec4280e5b4f4a37025a10905bb29"
  const expectedReportData =
    "7148f47ef58b475fce69b386e2d6b4c964a9533cc328ea8e544db66612a5174698d006951cefa8fd4450e884300638e567e22f9a012ef5754aa6a9d9564fcd8a"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.is(fmspc, "b0c06f000000")
  t.is(header.pce_svn, 0)

  t.true(
    await verifyTdx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

test.serial("Verify a V4 TDX quote from MoeMahhouk", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-moemahhouk.dat")

  const { header, body } = parseTdxQuote(quote)
  const { fmspc } = await _verifyTdx(quote)

  const expectedMRTD = reverseHexBytes(
    "18bcec2014a3ff000c46191e960ca4fe949f9adb2d8da557dbacee87f6ef7e2411fd5f09dc2b834506959bf69626ddf2",
  )
  const expectedReportData = reverseHexBytes(
    "007945c010980ecf9e0c0daf6dc971bffce0eaab6d4e4b592d4c08bac29c234068adb241fa02c2ef9e443daecd91d450739c601321fe51738a6c978234758e27",
  )

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.is(fmspc, "90c06f000000")
  t.is(header.pce_svn, 0)

  t.true(
    await verifyTdx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

test.serial("Verify a V4 TDX quote from Azure", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-azure", "utf-8")
  const { header, body } = parseTdxQuoteBase64(quote)
  const { fmspc } = await _verifyTdx(scureBase64.decode(quote))

  const expectedMRTD =
    "fe27b2aa3a05ec56864c308aff03dd13c189a6112d21e417ec1afe626a8cb9d91482d1379ec02fe6308972950a930d0a"
  const expectedReportData =
    "675b293e4e395b2bfbfb27a1754f5ca1fdca87e1949b3bc4d8ca39a8be195afe0000000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, new Uint8Array(48))
  t.deepEqual(body.mr_owner, new Uint8Array(48))
  t.deepEqual(body.mr_owner_config, new Uint8Array(48))
  t.is(fmspc, "00806f050000")
  t.is(header.pce_svn, 0)

  t.true(
    await verifyTdxBase64(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

test.serial("Verify a V4 TDX quote from Trustee", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-trustee.dat")
  const { header, body } = parseTdxQuote(quote)
  const { fmspc } = await _verifyTdx(quote)

  const expectedMRTD =
    "705ee9381b8633a9fbe532b52345e8433343d2868959f57889d84ca377c395b689cac1599ccea1b7d420483a9ce5f031"
  const expectedReportData =
    "7c71fe2c86eff65a7cf8dbc22b3275689fd0464a267baced1bf94fc1324656aeb755da3d44d098c0c87382f3a5f85b45c8a28fee1d3bdb38342bf96671501429"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.is(fmspc, "50806f000000")
  t.is(header.pce_svn, 0)

  t.true(
    await verifyTdx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

test.serial("Verify a V4 TDX quote from ZKDCAP", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-zkdcap.dat")
  const { header, body } = parseTdxQuote(quote)
  const { fmspc } = await _verifyTdx(quote)

  const expectedMRTD =
    "935be7742dd89c6a4df6dba8353d89041ae0f052beef993b1e7f4524d3bc57650df20e5582158352e1240b3f1fed55d8"
  const expectedReportData =
    "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.is(fmspc, "00806f050000")
  t.is(header.pce_svn, 0)

  t.true(
    await verifyTdx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

test.serial("Verify a V4 TDX quote from Intel", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx/quote.dat")
  const { header, body } = parseTdxQuote(quote)

  const expectedMRTD =
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
  const expectedReportData =
    "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))

  // Intel sample is missing certdata, reconstruct it from provided PEM files instead
  const root = extractPemCertificates(
    fs.readFileSync("test/sample/tdx/trustedRootCaCert.pem"),
  )
  const pckChain = extractPemCertificates(
    fs.readFileSync("test/sample/tdx/pckSignChain.pem"),
  )
  const pckCert = extractPemCertificates(
    fs.readFileSync("test/sample/tdx/pckCert.pem"),
  )
  const certdata = [...root, ...pckChain, ...pckCert]

  // Use provided certificate revocation lists
  const crls = [
    fs.readFileSync("test/sample/tdx/rootCaCrl.der"),
    fs.readFileSync("test/sample/tdx/intermediateCaCrl.der"),
  ]

  const { fmspc } = await _verifyTdx(quote, {
    extraCertdata: certdata,
    crls,
    verifyTcb: () => true,
  })
  t.is(fmspc, "ed742af8adf5")
  t.is(header.pce_svn, 0)

  t.true(
    await verifyTdx(quote, {
      pinnedRootCerts: [new QV_X509Certificate(root[0])],
      date: BASE_TIME,
      extraCertdata: certdata,
      crls,
      verifyTcb: () => true,
    }),
  )
})

test.serial("Verify a V4 TDX quote from GCP", async (t) => {
  const data = JSON.parse(
    fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"),
  )
  const quote: string = data.tdx.quote
  const { header, body } = parseTdxQuoteBase64(quote)
  const { fmspc } = await _verifyTdx(scureBase64.decode(quote))

  const expectedMRTD =
    "409c0cd3e63d9ea54d817cf851983a220131262664ac8cd02cc6a2e19fd291d2fdd0cc035d7789b982a43a92a4424c99"
  const expectedReportData =
    "806dfeec9d10c22a60b12751216d75fb358d83088ea72dd07eb49c84de24b8a49d483085c4350e545689955bdd10e1d8b55ef7c6d288a17032acece698e35db8"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, new Uint8Array(48))
  t.deepEqual(body.mr_owner, new Uint8Array(48))
  t.deepEqual(body.mr_owner_config, new Uint8Array(48))
  t.is(fmspc, "00806f050000")
  t.is(header.pce_svn, 0)

  t.true(
    await verifyTdxBase64(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

// Negative tests based on the GCP quote

function getGcpQuoteBase64(): string {
  const data = JSON.parse(
    fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"),
  )
  return data.tdx.quote as string
}

test.serial("Reject a V4 TDX quote, missing root cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const err = await t.throwsAsync(
    async () =>
      await verifyTdxBase64(quoteB64, {
        pinnedRootCerts: [],
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid root/i)
})

test.serial("Reject a V4 TDX quote, missing intermediate cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const quoteBuf = Buffer.from(quoteB64, "base64")
  const { leaf, root } = await getCertPemsFromQuote(
    scureBase64.decode(getGcpQuoteBase64()),
    { tdx: true },
  )
  const noEmbedded = rebuildTdxQuoteWithCertData(quoteBuf, Buffer.alloc(0))
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

test.serial("Reject a V4 TDX quote, missing leaf cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const quoteBuf = Buffer.from(quoteB64, "base64")
  const { intermediate, root } = await getCertPemsFromQuote(
    scureBase64.decode(getGcpQuoteBase64()),
    { tdx: true },
  )
  const noEmbedded = rebuildTdxQuoteWithCertData(quoteBuf, Buffer.alloc(0))
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

test.serial("Reject a V4 TDX quote, revoked root cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const { root } = await getCertPemsFromQuote(
    scureBase64.decode(getGcpQuoteBase64()),
    { tdx: true },
  )
  const rootSerial = normalizeSerialHex(
    new QV_X509Certificate(root).serialNumber,
  )
  const crl = buildCRL([rootSerial])
  const err = await t.throwsAsync(
    async () =>
      await verifyTdxBase64(quoteB64, {
        date: BASE_TIME,
        crls: [crl],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject a V4 TDX quote, revoked intermediate cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const { intermediate } = await getCertPemsFromQuote(
    scureBase64.decode(getGcpQuoteBase64()),
    { tdx: true },
  )
  const serial = normalizeSerialHex(
    new QV_X509Certificate(intermediate).serialNumber,
  )
  const crl = buildCRL([serial])
  const err = await t.throwsAsync(
    async () =>
      await verifyTdxBase64(quoteB64, {
        date: BASE_TIME,
        crls: [crl],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject a V4 TDX quote, revoked leaf cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const { leaf } = await getCertPemsFromQuote(
    scureBase64.decode(getGcpQuoteBase64()),
    { tdx: true },
  )
  const serial = normalizeSerialHex(new QV_X509Certificate(leaf).serialNumber)
  const crl = buildCRL([serial])
  const err = await t.throwsAsync(
    async () =>
      await verifyTdxBase64(quoteB64, {
        date: BASE_TIME,
        crls: [crl],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject a V4 TDX quote, invalid root self-signature", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const quoteBuf = Buffer.from(quoteB64, "base64")
  const { leaf, intermediate, root } = await getCertPemsFromQuote(
    scureBase64.decode(getGcpQuoteBase64()),
    { tdx: true },
  )
  const tamperedRoot = tamperPemSignature(root)
  const noEmbedded = rebuildTdxQuoteWithCertData(quoteBuf, Buffer.alloc(0))
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

test.serial(
  "Reject a V4 TDX quote, invalid intermediate cert signature",
  async (t) => {
    const quoteB64 = getGcpQuoteBase64()
    const quoteBuf = Buffer.from(quoteB64, "base64")
    const { leaf, intermediate, root } = await getCertPemsFromQuote(
      scureBase64.decode(getGcpQuoteBase64()),
      { tdx: true },
    )
    const tamperedIntermediate = tamperPemSignature(intermediate)
    const noEmbedded = rebuildTdxQuoteWithCertData(quoteBuf, Buffer.alloc(0))
    const err = await t.throwsAsync(
      async () =>
        await verifyTdx(noEmbedded, {
          date: BASE_TIME,
          extraCertdata: [leaf, tamperedIntermediate, root],
          crls: [],
          verifyTcb: () => true,
        }),
    )
    t.truthy(err)
    t.regex(err!.message, /invalid cert chain/i)
  },
)

test.serial("Reject a V4 TDX quote, invalid leaf cert signature", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const quoteBuf = Buffer.from(quoteB64, "base64")
  const { leaf, intermediate, root } = await getCertPemsFromQuote(
    scureBase64.decode(getGcpQuoteBase64()),
    { tdx: true },
  )
  const tamperedLeaf = tamperPemSignature(leaf)
  const noEmbedded = rebuildTdxQuoteWithCertData(quoteBuf, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [tamperedLeaf, intermediate, root],
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid cert chain/i)
})

test.serial("Reject a V4 TDX quote, incorrect QE signature", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
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

test.serial("Reject a V4 TDX quote, incorrect QE binding", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
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

test.serial("Reject a V4 TDX quote, incorrect TD signature", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
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

test.serial(
  "Reject a V4 TDX quote, missing certdata (no fallback)",
  async (t) => {
    const quoteB64 = getGcpQuoteBase64()
    const base = Buffer.from(quoteB64, "base64")
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
  "Reject a V4 TDX quote, expired or not-yet-valid certificate chain",
  async (t) => {
    const quoteB64 = getGcpQuoteBase64()
    const err = await t.throwsAsync(
      async () =>
        await verifyTdxBase64(quoteB64, {
          date: 0,
          crls: [],
          verifyTcb: () => true,
        }),
    )
    t.truthy(err)
    t.regex(err!.message, /expired cert chain/i)
  },
)

test.serial("Reject a V4 TDX quote, unsupported TEE type", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  const mutated = Buffer.from(original)
  // header.tee_type at offset 4 (UInt32LE)
  mutated.writeUInt32LE(0, 4)
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(mutated, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /only tdx is supported/i)
})

test.serial(
  "Reject a V4 TDX quote, unsupported attestation key type",
  async (t) => {
    const quoteB64 = getGcpQuoteBase64()
    const original = Buffer.from(quoteB64, "base64")
    const mutated = Buffer.from(original)
    // header.att_key_type at offset 2 (UInt16LE)
    mutated.writeUInt16LE(1, 2)
    const err = await t.throwsAsync(
      async () =>
        await verifyTdx(mutated, {
          date: BASE_TIME,
          crls: [],
          verifyTcb: () => true,
        }),
    )
    t.truthy(err)
    t.regex(err!.message, /only ECDSA att_key_type is supported/i)
  },
)

test.serial("Reject a V4 TDX quote, unsupported cert_data_type", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
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
  "Reject a V4 TDX quote, cert chain not yet valid (too early)",
  async (t) => {
    const quoteB64 = getGcpQuoteBase64()
    const early = Date.parse("2000-01-01")
    const err = await t.throwsAsync(
      async () =>
        await verifyTdxBase64(quoteB64, {
          date: early,
          crls: [],
          verifyTcb: () => true,
        }),
    )
    t.truthy(err)
    t.regex(err!.message, /expired cert chain, or not yet valid/i)
  },
)

test.serial(
  "Reject a V4 TDX quote, cert chain expired (too late)",
  async (t) => {
    const quoteB64 = getGcpQuoteBase64()
    const late = Date.parse("2100-01-01")
    const err = await t.throwsAsync(
      async () =>
        await verifyTdxBase64(quoteB64, {
          date: late,
          crls: [],
          verifyTcb: () => true,
        }),
    )
    t.truthy(err)
    t.regex(err!.message, /expired cert chain, or not yet valid/i)
  },
)

test.serial("Reject a TDX quote with unsupported version", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  const mutated = Buffer.from(original)
  // header.version at offset 0 (UInt16LE)
  mutated.writeUInt16LE(6, 0)
  const err = await t.throwsAsync(
    async () =>
      await verifyTdx(mutated, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /Unsupported quote version/i)
})
