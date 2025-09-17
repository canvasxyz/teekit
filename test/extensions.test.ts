import test from "ava"
import fs from "node:fs"

import {
  parseTdxQuote,
  parseTdxQuoteBase64,
  extractPemCertificates,
  verifyPCKChain,
} from "../qvl"

const VERIFY_TIME = Date.parse("2025-09-01")

test.serial("PCK chain extensions: GCP sample quote", (t) => {
  const data = JSON.parse(
    fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"),
  )
  const quote: string = data.tdx.quote
  const { signature } = parseTdxQuoteBase64(quote)
  const certs = extractPemCertificates(signature.cert_data)
  const { status } = verifyPCKChain(certs, VERIFY_TIME)
  t.is(status, "valid")
})

test.serial("PCK chain extensions: Edgeless sample quote", (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-edgeless.bin")
  const { signature } = parseTdxQuote(quote)
  const certs = extractPemCertificates(signature.cert_data)
  const { status } = verifyPCKChain(certs, VERIFY_TIME)
  t.is(status, "valid")
})

test.serial("PCK chain extensions: Phala sample quote", (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-phala.bin")
  const { signature } = parseTdxQuote(quote)
  const certs = extractPemCertificates(signature.cert_data)
  const { status } = verifyPCKChain(certs, VERIFY_TIME)
  t.is(status, "valid")
})

