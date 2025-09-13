import test from "ava"
import fs from "node:fs"

import { parseTdxQuoteBase64, hex, verifyTdxV4QuoteSignature } from "../qvl"

test.skip("Parse an SGX attestation", async (t) => {
  // TODO
})

test.serial("Parse a V4 TDX attestation from Google Cloud", async (t) => {
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
})

test.skip("Parse a V5 TDX 1.0 attestation", async (t) => {
  // TODO
})

test.skip("Parse a V5 TDX 1.5 attestation", async (t) => {
  // TODO
})

test.skip("Verify an SGX attestation", async (t) => {
  // TODO
})

test.serial("Verify a V4 TDX attestation from Google Cloud", async (t) => {
  const data = JSON.parse(
    fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"),
  )
  const ok = verifyTdxV4QuoteSignature(data.tdx.quote)
  t.true(ok)
})

test.skip("Verify a V5 TDX 1.0 attestation", async (t) => {
  // TODO
})

test.skip("Verify a V5 TDX 1.5 attestation", async (t) => {
  // TODO
})
