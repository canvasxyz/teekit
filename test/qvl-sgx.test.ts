import test from "ava"
import fs from "node:fs"
import { QV_X509Certificate, hex, parseSgxQuote, verifySgx, extractPemCertificates } from "../qvl"
import { BASE_TIME } from "./qvl-helpers"

test.serial("Verify an SGX quote from Intel, no quote signature", async (t) => {
  const quote = fs.readFileSync("test/sample/sgx/quote.dat")
  const { header, body, signature } = parseSgxQuote(quote)

  const expectedMrEnclave =
    "0000000000000000000000000000000000000000000000000000000000000000"
  const expectedReportData =
    "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 3)
  t.is(header.tee_type, 0)
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

  t.true(
    await verifySgx(quote, {
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

  const expectedMrEnclave =
    "9c90fd81f6e9fe64b46b14f0623523a52d6a5678482988c408f6adffe6301e2c"
  const expectedReportData =
    "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 3)
  t.is(header.tee_type, 0)
  t.is(hex(body.mr_enclave), expectedMrEnclave)
  t.is(hex(body.report_data), expectedReportData)

  t.true(await verifySgx(quote, { date: BASE_TIME, crls: [] }))
})

test.serial("Verify an SGX quote from chinenyeokafor", async (t) => {
  const quote = fs.readFileSync("test/sample/sgx-chinenyeokafor.dat")
  const { header, body } = parseSgxQuote(quote)

  const expectedMrEnclave =
    "0696ab235b2d339e68a4303cb64cde005bb8cdf2448bed742ac8ea8339bd0cb7"
  const expectedReportData =
    "888d97435fd51947e5a8c71f73ba24d9abcf716a1ac05b495a54f9a6fb54609e0000000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 3)
  t.is(header.tee_type, 0)
  t.is(hex(body.mr_enclave), expectedMrEnclave)
  t.is(hex(body.report_data), expectedReportData)

  t.true(await verifySgx(quote, { date: BASE_TIME, crls: [] }))
})

test.serial("Verify an SGX quote from TLSN, quote9", async (t) => {
  const quote = fs.readFileSync("test/sample/sgx-tlsn-quote9.dat")
  const { header, body } = parseSgxQuote(quote)

  const expectedMrEnclave =
    "50a6a608c1972408f94379f83a7af2ea55b31095f131efe93af74f5968a44f29"
  const expectedReportData =
    "03351d6944f43d3041a075bddf540d2b91595979ef67fee8c9e6f1c3a5ff6e9e7300000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 3)
  t.is(header.tee_type, 0)
  t.is(hex(body.mr_enclave), expectedMrEnclave)
  t.is(hex(body.report_data), expectedReportData)

  t.true(await verifySgx(quote, { date: BASE_TIME, crls: [] }))
})

test.serial("Verify an SGX quote from TLSN, quote_dev", async (t) => {
  const quote = fs.readFileSync("test/sample/sgx-tlsn-quotedev.dat")
  const { header, body } = parseSgxQuote(quote)

  const expectedMrEnclave =
    "db5e55d3190d92512e4eae09d697b4b5fe30c2212e1ad6db5681379608c46204"
  const expectedReportData =
    "030eba01d248d2c2fb4f39fc8f2daaf2392560100989eb022dc6570e87a011b29c00000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 3)
  t.is(header.tee_type, 0)
  t.is(hex(body.mr_enclave), expectedMrEnclave)
  t.is(hex(body.report_data), expectedReportData)

  t.true(await verifySgx(quote, { date: BASE_TIME, crls: [] }))
})

