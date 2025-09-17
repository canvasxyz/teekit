import test from "ava"
import fs from "node:fs"

import {
  parseTdxQuote,
  parseTdxQuoteBase64,
  hex,
  reverseHexBytes,
  extractPemCertificates,
  verifyPCKChain,
  verifyTdx,
  verifyTdxBase64,
  loadRootCerts,
  getTdxV4SignedRegion,
  computeCertSha256Hex,
} from "../qvl"
import { X509Certificate } from "node:crypto"

test.serial("Verify a V4 TDX quote from Tappd", async (t) => {
  const quoteHex = fs.readFileSync("test/sample/tdx-v4-tappd.hex", "utf-8")
  const quote = Buffer.from(quoteHex.replace(/^0x/, ""), "hex")

  const { header, body } = parseTdxQuote(quote)
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

  t.true(
    verifyTdx(quote, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: Date.parse("2025-09-01"),
      crls: [],
    }),
  )
})

test.serial("Verify a V4 TDX quote from Edgeless", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-edgeless.bin")

  const { header, body } = parseTdxQuote(quote)
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

  t.true(
    verifyTdx(quote, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: Date.parse("2025-09-01"),
      crls: [],
    }),
  )
})

test.serial("Verify a V4 TDX quote from Phala, bin format", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-phala.bin")

  const { header, body } = parseTdxQuote(quote)
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

  t.true(
    verifyTdx(quote, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: Date.parse("2025-09-01"),
      crls: [],
    }),
  )
})

test.serial("Verify a V4 TDX quote from Phala, hex format", async (t) => {
  const quoteHex = fs.readFileSync("test/sample/tdx-v4-phala.hex", "utf-8")
  const quote = Buffer.from(quoteHex.replace(/^0x/, ""), "hex")

  const { header, body } = parseTdxQuote(quote)
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

  t.true(
    verifyTdx(quote, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: Date.parse("2025-09-01"),
      crls: [],
    }),
  )
})

test.serial("Verify a V4 TDX quote from MoeMahhouk", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-moemahhouk.bin")

  const { header, body } = parseTdxQuote(quote)
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

  t.true(verifyTdx(quote, { pinnedRootCerts: loadRootCerts("test/certs"), date: Date.parse("2025-09-01") }))
})

test.serial("Verify a V4 TDX quote from Azure", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-azure-quote", "utf-8")
  const { header, body } = parseTdxQuoteBase64(quote)

  const expectedMRTD =
    "fe27b2aa3a05ec56864c308aff03dd13c189a6112d21e417ec1afe626a8cb9d91482d1379ec02fe6308972950a930d0a"
  const expectedReportData =
    "675b293e4e395b2bfbfb27a1754f5ca1fdca87e1949b3bc4d8ca39a8be195afe0000000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))

  t.true(
    verifyTdxBase64(quote, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: Date.parse("2025-09-01"),
      crls: [],
    }),
  )
})

test.serial("Verify a V4 TDX quote from Trustee", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-trustee.dat")
  const { header, body } = parseTdxQuote(quote)

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

  t.true(
    verifyTdx(
      quote,
      loadRootCerts("test/certs"),
      Date.parse("2025-09-01"),
      undefined,
      [],
    ),
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

  const root = extractPemCertificates(
    fs.readFileSync("test/sample/tdx/trustedRootCaCert.pem"),
  ).map((txt) => new X509Certificate(txt))
  const certdata = [
    ...extractPemCertificates(
      fs.readFileSync("test/sample/tdx/pckSignChain.pem"),
    ),
    ...extractPemCertificates(fs.readFileSync("test/sample/tdx/pckCert.pem")),
  ]
  const crls = [
    fs.readFileSync("test/sample/tdx/rootCaCrl.der"),
    fs.readFileSync("test/sample/tdx/intermediateCaCrl.der"),
  ]
  t.true(
    verifyTdx(quote, {
      pinnedRootCerts: root,
      date: Date.parse("2025-09-01"),
      extraCerts: certdata,
      crls,
    }),
  )
})

test.serial("Verify a V4 TDX quote from GCP", async (t) => {
  const data = JSON.parse(
    fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"),
  )
  const quote: string = data.tdx.quote
  const { header, body } = parseTdxQuoteBase64(quote)

  const expectedMRTD =
    "409c0cd3e63d9ea54d817cf851983a220131262664ac8cd02cc6a2e19fd291d2fdd0cc035d7789b982a43a92a4424c99"
  const expectedReportData =
    "806dfeec9d10c22a60b12751216d75fb358d83088ea72dd07eb49c84de24b8a49d483085c4350e545689955bdd10e1d8b55ef7c6d288a17032acece698e35db8"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))

  t.true(
    verifyTdxBase64(quote, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: Date.parse("2025-09-01"),
      crls: [],
    }),
  )
})

// test.skip("Verify a V5 TDX 1.0 attestation", async (t) => {
//   // TODO
// })

// test.skip("Verify a V5 TDX 1.5 attestation", async (t) => {
//   // TODO
// })

// test.skip("Verify an SGX attestation", async (t) => {
//   // TODO
// })

// ---------------------- Negative tests for invalid scenarios ----------------------

const BASE_TIME = Date.parse("2025-09-01")

function pemToDer(pem: string): Buffer {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "")
  return Buffer.from(b64, "base64")
}

function derToPem(der: Buffer): string {
  const b64 = der.toString("base64")
  const lines = b64.match(/.{1,64}/g) || []
  return `-----BEGIN CERTIFICATE-----\n${lines.join(
    "\n",
  )}\n-----END CERTIFICATE-----\n`
}

function tamperPemSignature(pem: string): string {
  const der = Buffer.from(pemToDer(pem))
  der[der.length - 1] ^= 0x01
  return derToPem(der)
}

function buildCRLWithSerials(serialsUpperHex: string[]): Buffer {
  const encodeLen = (len: number) => {
    if (len < 0x80) return Buffer.from([len])
    const bytes: number[] = []
    let v = len
    while (v > 0) {
      bytes.unshift(v & 0xff)
      v >>= 8
    }
    return Buffer.from([0x80 | bytes.length, ...bytes])
  }
  const tlv = (tag: number, value: Buffer) =>
    Buffer.concat([Buffer.from([tag]), encodeLen(value.length), value])

  const encodeIntegerHex = (hex: string) => {
    let v = Buffer.from(hex.replace(/[^0-9A-F]/g, ""), "hex")
    if (v.length === 0) v = Buffer.from([0])
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v])
    return tlv(0x02, v)
  }

  const version = tlv(0x02, Buffer.from([0x01]))
  const sigAlg = tlv(0x30, Buffer.alloc(0))
  const issuer = tlv(0x30, Buffer.alloc(0))
  const thisUpdate = tlv(0x17, Buffer.from("250101000000Z"))

  const revokedEntries = serialsUpperHex.map((s) =>
    tlv(0x30, encodeIntegerHex(s)),
  )
  const revokedSeq = tlv(0x30, Buffer.concat(revokedEntries))

  const tbs = tlv(
    0x30,
    Buffer.concat([version, sigAlg, issuer, thisUpdate, revokedSeq]),
  )
  const outer = tlv(0x30, tbs)
  return outer
}

function rebuildQuoteWithCertData(baseQuote: Buffer, certData: Buffer): Buffer {
  const signedLen = getTdxV4SignedRegion(baseQuote).length
  const sigLen = baseQuote.readUInt32LE(signedLen)
  const sigStart = signedLen + 4
  const sigData = baseQuote.subarray(sigStart, sigStart + sigLen)

  const FIXED_LEN = 64 + 64 + 6 + 384 + 64 + 2 // ECDSA fixed portion
  const qeAuthLen = sigData.readUInt16LE(64 + 64 + 6 + 384 + 64)
  const fixedPlusAuth = sigData.subarray(0, FIXED_LEN + qeAuthLen)

  const tail = Buffer.alloc(2 + 4)
  tail.writeUInt16LE(5, 0) // cert_data_type = 5 (PCK)
  tail.writeUInt32LE(certData.length, 2)

  const newSigData = Buffer.concat([fixedPlusAuth, tail, certData])
  const newSigLen = Buffer.alloc(4)
  newSigLen.writeUInt32LE(newSigData.length, 0)

  const prefix = baseQuote.subarray(0, signedLen)
  return Buffer.concat([prefix, newSigLen, newSigData])
}

function rebuildQuoteWithCertType(
  baseQuote: Buffer,
  certDataType: number,
): Buffer {
  const signedLen = getTdxV4SignedRegion(baseQuote).length
  const sigLen = baseQuote.readUInt32LE(signedLen)
  const sigStart = signedLen + 4
  const sigData = baseQuote.subarray(sigStart, sigStart + sigLen)

  const FIXED_LEN = 64 + 64 + 6 + 384 + 64 + 2 // ECDSA fixed portion
  const qeAuthLen = sigData.readUInt16LE(64 + 64 + 6 + 384 + 64)
  const fixedPlusAuth = sigData.subarray(0, FIXED_LEN + qeAuthLen)

  // Extract existing cert_data tail
  const certDataOffset = FIXED_LEN + qeAuthLen + 2 + 4
  const existingCertData = sigData.subarray(certDataOffset)

  const tail = Buffer.alloc(2 + 4)
  tail.writeUInt16LE(certDataType, 0)
  tail.writeUInt32LE(existingCertData.length, 2)

  const newSigData = Buffer.concat([fixedPlusAuth, tail, existingCertData])
  const newSigLen = Buffer.alloc(4)
  newSigLen.writeUInt32LE(newSigData.length, 0)

  const prefix = baseQuote.subarray(0, signedLen)
  return Buffer.concat([prefix, newSigLen, newSigData])
}

function getGcpQuoteBase64(): string {
  const data = JSON.parse(
    fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"),
  )
  return data.tdx.quote as string
}

function getGcpCertPems(): {
  leaf: string
  intermediate: string
  root: string
  all: string[]
} {
  const quoteB64 = getGcpQuoteBase64()
  const { signature } = parseTdxQuoteBase64(quoteB64)
  const pems = extractPemCertificates(signature.cert_data)
  const { chain } = verifyPCKChain(pems, null)
  const hashToPem = new Map<string, string>()
  for (const pem of pems) {
    const h = computeCertSha256Hex(new X509Certificate(pem))
    hashToPem.set(h, pem)
  }
  const leafPem = hashToPem.get(computeCertSha256Hex(chain[0]))!
  const intermediatePem = hashToPem.get(computeCertSha256Hex(chain[1]))!
  const rootPem = hashToPem.get(computeCertSha256Hex(chain[2]))!
  return {
    leaf: leafPem,
    intermediate: intermediatePem,
    root: rootPem,
    all: pems,
  }
}

test.serial("Reject a V4 TDX quote, missing root cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const err = t.throws(() => verifyTdxBase64(quoteB64, { pinnedRootCerts: [], date: BASE_TIME }))
  t.truthy(err)
  t.regex(err!.message, /invalid root/i)
})

test.serial("Reject a V4 TDX quote, missing intermediate cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const quoteBuf = Buffer.from(quoteB64, "base64")
  const { leaf, root } = getGcpCertPems()
  const noEmbedded = rebuildQuoteWithCertData(quoteBuf, Buffer.alloc(0))
  const err = t.throws(() =>
    verifyTdx(noEmbedded, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: BASE_TIME,
      extraCerts: [leaf, root],
    }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid root/i)
})

test.serial("Reject a V4 TDX quote, missing leaf cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const quoteBuf = Buffer.from(quoteB64, "base64")
  const { intermediate, root } = getGcpCertPems()
  const noEmbedded = rebuildQuoteWithCertData(quoteBuf, Buffer.alloc(0))
  const err = t.throws(() =>
    verifyTdx(noEmbedded, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: BASE_TIME,
      extraCerts: [intermediate, root],
    }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid cert chain/i)
})

test.serial("Reject a V4 TDX quote, revoked root cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const { root } = getGcpCertPems()
  const rootSerial = new X509Certificate(root).serialNumber
    .replace(/[^0-9A-F]/g, "")
    .toUpperCase()
    .replace(/^0+(?=[0-9A-F])/g, "")
  const crl = buildCRLWithSerials([rootSerial])
  const err = t.throws(() =>
    verifyTdxBase64(quoteB64, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: BASE_TIME,
      crls: [crl],
    }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject a V4 TDX quote, revoked intermediate cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const { intermediate } = getGcpCertPems()
  const serial = new X509Certificate(intermediate).serialNumber
    .replace(/[^0-9A-F]/g, "")
    .toUpperCase()
    .replace(/^0+(?=[0-9A-F])/g, "")
  const crl = buildCRLWithSerials([serial])
  const err = t.throws(() =>
    verifyTdxBase64(quoteB64, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: BASE_TIME,
      crls: [crl],
    }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject a V4 TDX quote, revoked leaf cert", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const { leaf } = getGcpCertPems()
  const serial = new X509Certificate(leaf).serialNumber
    .replace(/[^0-9A-F]/g, "")
    .toUpperCase()
    .replace(/^0+(?=[0-9A-F])/g, "")
  const crl = buildCRLWithSerials([serial])
  const err = t.throws(() =>
    verifyTdxBase64(quoteB64, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: BASE_TIME,
      crls: [crl],
    }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject a V4 TDX quote, invalid root self-signature", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const quoteBuf = Buffer.from(quoteB64, "base64")
  const { leaf, intermediate, root } = getGcpCertPems()
  const tamperedRoot = tamperPemSignature(root)
  const noEmbedded = rebuildQuoteWithCertData(quoteBuf, Buffer.alloc(0))
  const err = t.throws(() =>
    verifyTdx(noEmbedded, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: BASE_TIME,
      extraCerts: [leaf, intermediate, tamperedRoot],
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
    const { leaf, intermediate, root } = getGcpCertPems()
    const tamperedIntermediate = tamperPemSignature(intermediate)
    const noEmbedded = rebuildQuoteWithCertData(quoteBuf, Buffer.alloc(0))
    const err = t.throws(() =>
      verifyTdx(noEmbedded, {
        pinnedRootCerts: loadRootCerts("test/certs"),
        date: BASE_TIME,
        extraCerts: [leaf, tamperedIntermediate, root],
      }),
    )
    t.truthy(err)
    t.regex(err!.message, /invalid cert chain/i)
  },
)

test.serial("Reject a V4 TDX quote, invalid leaf cert signature", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const quoteBuf = Buffer.from(quoteB64, "base64")
  const { leaf, intermediate, root } = getGcpCertPems()
  const tamperedLeaf = tamperPemSignature(leaf)
  const noEmbedded = rebuildQuoteWithCertData(quoteBuf, Buffer.alloc(0))
  const err = t.throws(() =>
    verifyTdx(noEmbedded, {
      pinnedRootCerts: loadRootCerts("test/certs"),
      date: BASE_TIME,
      extraCerts: [tamperedLeaf, intermediate, root],
    }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid cert chain/i)
})

test.serial("Reject a V4 TDX quote, incorrect QE signature", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  const signedLen = getTdxV4SignedRegion(original).length
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
  const err = t.throws(() => verifyTdx(mutated, { pinnedRootCerts: loadRootCerts("test/certs"), date: BASE_TIME }))
  t.truthy(err)
  t.regex(err!.message, /invalid qe report signature/i)
})

test.serial("Reject a V4 TDX quote, incorrect QE binding", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  const signedLen = getTdxV4SignedRegion(original).length
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
  const err = t.throws(() => verifyTdx(mutated, { pinnedRootCerts: loadRootCerts("test/certs"), date: BASE_TIME }))
  t.truthy(err)
  t.regex(err!.message, /invalid qe report binding/i)
})

test.serial("Reject a V4 TDX quote, incorrect TD signature", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  const signedLen = getTdxV4SignedRegion(original).length
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
  const err = t.throws(() => verifyTdx(mutated, { pinnedRootCerts: loadRootCerts("test/certs"), date: BASE_TIME }))
  t.truthy(err)
  t.regex(err!.message, /attestation_public_key signature/i)
})

test.serial(
  "Reject a V4 TDX quote, missing certdata (no fallback)",
  async (t) => {
    const quoteB64 = getGcpQuoteBase64()
    const base = Buffer.from(quoteB64, "base64")
    const noEmbedded = rebuildQuoteWithCertData(base, Buffer.alloc(0))
  const err = t.throws(() => verifyTdx(noEmbedded, { pinnedRootCerts: loadRootCerts("test/certs"), date: BASE_TIME }))
    t.truthy(err)
    t.regex(err!.message, /missing certdata/i)
  },
)

test.serial(
  "Reject a V4 TDX quote, expired or not-yet-valid certificate chain",
  async (t) => {
    const quoteB64 = getGcpQuoteBase64()
  const err = t.throws(() => verifyTdxBase64(quoteB64, { pinnedRootCerts: loadRootCerts("test/certs"), date: 0 }))
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
  const err = t.throws(() => verifyTdx(mutated, { pinnedRootCerts: loadRootCerts("test/certs"), date: BASE_TIME }))
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
    const err = t.throws(() =>
      verifyTdx(mutated, { pinnedRootCerts: loadRootCerts("test/certs"), date: BASE_TIME }),
    )
    t.truthy(err)
    t.regex(err!.message, /only ECDSA att_key_type is supported/i)
  },
)

test.serial("Reject a V4 TDX quote, unsupported cert_data_type", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  const mutated = rebuildQuoteWithCertType(original, 0)
  const err = t.throws(() => verifyTdx(mutated, { pinnedRootCerts: loadRootCerts("test/certs"), date: BASE_TIME }))
  t.truthy(err)
  t.regex(err!.message, /only PCK cert_data is supported/i)
})

test.serial("Reject a TDX quote with unsupported version", async (t) => {
  const quoteB64 = getGcpQuoteBase64()
  const original = Buffer.from(quoteB64, "base64")
  const mutated = Buffer.from(original)
  // header.version at offset 0 (UInt16LE)
  mutated.writeUInt16LE(5, 0)
  const err = t.throws(() => verifyTdx(mutated, { pinnedRootCerts: loadRootCerts("test/certs"), date: BASE_TIME }))
  t.truthy(err)
  t.regex(err!.message, /Unsupported quote version/i)
})
