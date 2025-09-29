import test from "ava"
import fs from "node:fs"
import {
  QV_X509Certificate,
  hex,
  verifySgx,
  _verifySgx,
  parseSgxQuote,
  getSgxSignedRegion,
} from "ra-https-qvl"
import { normalizeSerialHex, extractPemCertificates } from "ra-https-qvl/utils"
import {
  rebuildSgxQuoteWithCertData,
  tamperPemSignature,
  buildCRL,
  getCertPemsFromQuote,
} from "./qvl-helpers.js"

const BASE_TIME = Date.parse("2025-09-01")

test.serial("Verify an SGX quote from Intel, no quote signature", async (t) => {
  const quote = fs.readFileSync("test/sample/sgx/quote.dat")
  const { header, body, signature } = parseSgxQuote(quote)

  const expectedMrEnclave =
    "0000000000000000000000000000000000000000000000000000000000000000"
  const expectedReportData =
    "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 3)
  t.is(header.tee_type, 0)
  t.is(header.pce_svn, 3)
  t.is(hex(body.mr_enclave), expectedMrEnclave)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_signer, Buffer.alloc(32))
  t.deepEqual(body.attributes, Buffer.alloc(16))
  t.deepEqual(body.cpu_svn, Buffer.alloc(16))

  t.is(
    hex(signature.ecdsa_signature),
    "021a1375acdfc4520ade2f984b051e59a54e2892b24d3aa98e543b7b49eef2a375a7b5bafd1f1972e604fd799d4a01e2e422a52558768606daade2b17a6313ee",
  )

  // Intel sample is missing certdata, reconstruct it from provided PEM files instead
  const root = extractPemCertificates(
    fs.readFileSync("test/sample/sgx/trustedRootCaCert.pem"),
  )
  const pckChain = extractPemCertificates(
    fs.readFileSync("test/sample/sgx/pckSignChain.pem"),
  )
  const pckCert = extractPemCertificates(
    fs.readFileSync("test/sample/sgx/pckCert.pem"),
  )
  const certdata = [...root, ...pckChain, ...pckCert]

  // Use provided certificate revocation lists
  const crls = [
    fs.readFileSync("test/sample/sgx/rootCaCrl.der"),
    fs.readFileSync("test/sample/sgx/intermediateCaCrl.der"),
  ]

  const { fmspc } = await _verifySgx(quote, {
    crls: [],
    verifyTcb: () => true,
    extraCertdata: certdata,
  })
  t.is(fmspc, "00707f000000")

  t.true(
    await verifySgx(quote, {
      verifyTcb: () => true,
      pinnedRootCerts: [new QV_X509Certificate(root[0])],
      date: BASE_TIME,
      crls,
      extraCertdata: certdata,
    }),
  )
})

test.serial("Verify an SGX quote from Occlum", async (t) => {
  const quote = fs.readFileSync("test/sample/sgx-occlum.dat")
  const { header, body } = parseSgxQuote(quote)
  const { fmspc } = await _verifySgx(quote)

  const expectedMrEnclave =
    "9c90fd81f6e9fe64b46b14f0623523a52d6a5678482988c408f6adffe6301e2c"
  const expectedReportData =
    "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 3)
  t.is(header.tee_type, 0)
  t.is(header.pce_svn, 13)
  t.is(hex(body.mr_enclave), expectedMrEnclave)
  t.is(hex(body.report_data), expectedReportData)
  t.is(fmspc, "30606a000000")

  t.true(
    await verifySgx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

test.serial("Verify an SGX quote from chinenyeokafor", async (t) => {
  const quote = fs.readFileSync("test/sample/sgx-chinenyeokafor.dat")
  const { header, body } = parseSgxQuote(quote)
  const { fmspc } = await _verifySgx(quote)

  const expectedMrEnclave =
    "0696ab235b2d339e68a4303cb64cde005bb8cdf2448bed742ac8ea8339bd0cb7"
  const expectedReportData =
    "888d97435fd51947e5a8c71f73ba24d9abcf716a1ac05b495a54f9a6fb54609e0000000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 3)
  t.is(header.tee_type, 0)
  t.is(header.pce_svn, 16)
  t.is(hex(body.mr_enclave), expectedMrEnclave)
  t.is(hex(body.report_data), expectedReportData)
  t.is(fmspc, "90c06f000000")

  t.true(
    await verifySgx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

test.serial("Verify an SGX quote from TLSN, quote9", async (t) => {
  const quote = fs.readFileSync("test/sample/sgx-tlsn-quote9.dat")
  const { header, body } = parseSgxQuote(quote)
  const { fmspc } = await _verifySgx(quote)

  const expectedMrEnclave =
    "50a6a608c1972408f94379f83a7af2ea55b31095f131efe93af74f5968a44f29"
  const expectedReportData =
    "03351d6944f43d3041a075bddf540d2b91595979ef67fee8c9e6f1c3a5ff6e9e7300000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 3)
  t.is(header.tee_type, 0)
  t.is(header.pce_svn, 16)
  t.is(hex(body.mr_enclave), expectedMrEnclave)
  t.is(hex(body.report_data), expectedReportData)
  t.is(fmspc, "00906ed50000")

  t.true(
    await verifySgx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

test.serial("Verify an SGX quote from TLSN, quote_dev", async (t) => {
  const quote = fs.readFileSync("test/sample/sgx-tlsn-quotedev.dat")
  const { header, body } = parseSgxQuote(quote)
  const { fmspc } = await _verifySgx(quote)

  const expectedMrEnclave =
    "db5e55d3190d92512e4eae09d697b4b5fe30c2212e1ad6db5681379608c46204"
  const expectedReportData =
    "030eba01d248d2c2fb4f39fc8f2daaf2392560100989eb022dc6570e87a011b29c00000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 3)
  t.is(header.tee_type, 0)
  t.is(hex(body.mr_enclave), expectedMrEnclave)
  t.is(hex(body.report_data), expectedReportData)
  t.is(fmspc, "00906ed50000")

  t.true(
    await verifySgx(quote, {
      date: BASE_TIME,
      crls: [],
      verifyTcb: () => true,
    }),
  )
})

// Negative tests based on the Occlum SGX quote

test.serial("Reject an SGX quote, missing root cert", async (t) => {
  const quote = fs.readFileSync("test/sample/sgx-occlum.dat")
  const err = await t.throwsAsync(
    async () =>
      await verifySgx(quote, {
        pinnedRootCerts: [],
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid root/i)
})

test.serial("Reject an SGX quote, missing intermediate cert", async (t) => {
  const original = fs.readFileSync("test/sample/sgx-occlum.dat")
  const { leaf, root } = await getCertPemsFromQuote(original)
  const noEmbedded = rebuildSgxQuoteWithCertData(original, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifySgx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [leaf, root],
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid root/i)
})

test.serial("Reject an SGX quote, missing leaf cert", async (t) => {
  const original = fs.readFileSync("test/sample/sgx-occlum.dat")
  const { intermediate, root } = await getCertPemsFromQuote(original)
  const noEmbedded = rebuildSgxQuoteWithCertData(original, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifySgx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [intermediate, root],
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid cert chain/i)
})

test.serial("Reject an SGX quote, revoked root cert", async (t) => {
  const original = fs.readFileSync("test/sample/sgx-occlum.dat")
  const { root } = await getCertPemsFromQuote(original)
  const rootSerial = normalizeSerialHex(
    new QV_X509Certificate(root).serialNumber,
  )
  const crl = buildCRL([rootSerial])
  const err = await t.throwsAsync(
    async () =>
      await verifySgx(original, {
        date: BASE_TIME,
        crls: [crl],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject an SGX quote, invalid root self-signature", async (t) => {
  const original = fs.readFileSync("test/sample/sgx-occlum.dat")
  const { leaf, intermediate, root } = await getCertPemsFromQuote(original)
  const tamperedRoot = tamperPemSignature(root)
  const noEmbedded = rebuildSgxQuoteWithCertData(original, Buffer.alloc(0))
  const err = await t.throwsAsync(
    async () =>
      await verifySgx(noEmbedded, {
        date: BASE_TIME,
        extraCertdata: [leaf, intermediate, tamperedRoot],
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid cert chain/i)
})

test.serial("Reject an SGX quote, incorrect QE signature", async (t) => {
  const original = Buffer.from(fs.readFileSync("test/sample/sgx-occlum.dat"))
  const signedLen = getSgxSignedRegion(original).length
  const sigLen = original.readUInt32LE(signedLen)
  const sigStart = signedLen + 4
  const sigData = Buffer.from(original.subarray(sigStart, sigStart + sigLen))
  const qeReportSigOffset = 64 + 64 + 384 // inside sig_data
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
      await verifySgx(mutated, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid qe report signature/i)
})

test.serial("Reject an SGX quote, incorrect QE binding", async (t) => {
  const original = Buffer.from(fs.readFileSync("test/sample/sgx-occlum.dat"))
  const signedLen = getSgxSignedRegion(original).length
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
      await verifySgx(mutated, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid qe report binding/i)
})

test.serial("Reject an SGX quote, incorrect quote signature", async (t) => {
  const original = Buffer.from(fs.readFileSync("test/sample/sgx-occlum.dat"))
  const signedLen = getSgxSignedRegion(original).length
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
      await verifySgx(mutated, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /invalid signature over quote/i)
})

test.serial("Reject an SGX quote, unsupported cert_data_type", async (t) => {
  const original = Buffer.from(fs.readFileSync("test/sample/sgx-occlum.dat"))
  const signedLen = getSgxSignedRegion(original).length
  const sigLen = original.readUInt32LE(signedLen)
  const sigStart = signedLen + 4
  const sigData = Buffer.from(original.subarray(sigStart, sigStart + sigLen))

  const fixedOffset = 64 + 64 + 384 + 64
  const qeAuthLen = sigData.readUInt16LE(fixedOffset)
  const tailOffset = fixedOffset + 2 + qeAuthLen
  // Overwrite cert_data_type (UInt16LE) with an unsupported value
  sigData.writeUInt16LE(2, tailOffset)

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
      await verifySgx(mutated, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /only PCK cert_data is supported/i)
})

test.serial(
  "Reject an SGX quote, missing certdata (no fallback)",
  async (t) => {
    const base = Buffer.from(fs.readFileSync("test/sample/sgx-occlum.dat"))
    const noEmbedded = rebuildSgxQuoteWithCertData(base, Buffer.alloc(0))
    const err = await t.throwsAsync(
      async () =>
        await verifySgx(noEmbedded, {
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
  "Reject an SGX quote, cert chain not yet valid (too early)",
  async (t) => {
    const buf = Buffer.from(fs.readFileSync("test/sample/sgx-occlum.dat"))
    const early = Date.parse("2000-01-01")
    const err = await t.throwsAsync(
      async () =>
        await verifySgx(buf, { date: early, crls: [], verifyTcb: () => true }),
    )
    t.truthy(err)
    t.regex(err!.message, /expired cert chain, or not yet valid/i)
  },
)

test.serial("Reject an SGX quote, cert chain expired (too late)", async (t) => {
  const buf = Buffer.from(fs.readFileSync("test/sample/sgx-occlum.dat"))
  const late = Date.parse("2100-01-01")
  const err = await t.throwsAsync(
    async () =>
      await verifySgx(buf, { date: late, crls: [], verifyTcb: () => true }),
  )
  t.truthy(err)
  t.regex(err!.message, /expired cert chain, or not yet valid/i)
})

test.serial("Reject an SGX quote, revoked intermediate cert", async (t) => {
  const buf = Buffer.from(fs.readFileSync("test/sample/sgx-occlum.dat"))
  const { intermediate } = await getCertPemsFromQuote(buf)
  const serial = normalizeSerialHex(
    new QV_X509Certificate(intermediate).serialNumber,
  )
  const crl = buildCRL([serial])
  const err = await t.throwsAsync(
    async () =>
      await verifySgx(buf, {
        date: BASE_TIME,
        crls: [crl],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject an SGX quote, revoked leaf cert", async (t) => {
  const buf = Buffer.from(fs.readFileSync("test/sample/sgx-occlum.dat"))
  const { leaf } = await getCertPemsFromQuote(buf)
  const serial = normalizeSerialHex(new QV_X509Certificate(leaf).serialNumber)
  const crl = buildCRL([serial])
  const err = await t.throwsAsync(
    async () =>
      await verifySgx(buf, {
        date: BASE_TIME,
        crls: [crl],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /revoked certificate in cert chain/i)
})

test.serial("Reject an SGX quote, unsupported TEE type", async (t) => {
  const original = Buffer.from(fs.readFileSync("test/sample/sgx-occlum.dat"))
  // header.tee_type at offset 4 (UInt32LE)
  original.writeUInt32LE(129, 4)
  const err = await t.throwsAsync(
    async () =>
      await verifySgx(original, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /only sgx is supported/i)
})

test.serial(
  "Reject an SGX quote, unsupported attestation key type",
  async (t) => {
    const original = Buffer.from(fs.readFileSync("test/sample/sgx-occlum.dat"))
    // header.att_key_type at offset 2 (UInt16LE)
    original.writeUInt16LE(1, 2)
    const err = await t.throwsAsync(
      async () =>
        await verifySgx(original, {
          date: BASE_TIME,
          crls: [],
          verifyTcb: () => true,
        }),
    )
    t.truthy(err)
    t.regex(err!.message, /only ECDSA att_key_type is supported/i)
  },
)

test.serial("Reject an SGX quote with unsupported version", async (t) => {
  const original = Buffer.from(fs.readFileSync("test/sample/sgx-occlum.dat"))
  // header.version at offset 0 (UInt16LE)
  original.writeUInt16LE(4, 0)
  const err = await t.throwsAsync(
    async () =>
      await verifySgx(original, {
        date: BASE_TIME,
        crls: [],
        verifyTcb: () => true,
      }),
  )
  t.truthy(err)
  t.regex(err!.message, /Unsupported SGX quote version/i)
})
