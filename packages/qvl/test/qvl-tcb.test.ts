// @ts-nocheck
import test from "ava"
import fs from "node:fs"

import { evaluateTcb, evaluateTdxTcb, evaluateSgxTcb, verifyTcbInfoSignature } from "ra-https-qvl"

const BASE_TIME = Date.parse("2025-09-01")

test.serial("TDX TCB evaluate (sample JSON)", async (t) => {
  const data = JSON.parse(
    fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"),
  )
  const quoteB64: string = data.tdx.quote
  const tcbInfo = JSON.parse(
    fs.readFileSync("test/sample/tdx/tcbInfo.json", "utf-8"),
  )

  const res = evaluateTcb(quoteB64, tcbInfo, {
    atTimeMs: BASE_TIME,
    enforceUpToDate: false,
  })
  t.truthy(res)
  t.is(res.type, "tdx")
  t.true(typeof res.matchedStatus === "string")
  t.true(res.matchedIndex >= -1)
})

test.serial("TDX TCB evaluate (direct)", async (t) => {
  const data = JSON.parse(
    fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"),
  )
  const quoteB64: string = data.tdx.quote
  const tcbInfo = JSON.parse(
    fs.readFileSync("test/sample/tdx/tcbInfo.json", "utf-8"),
  )

  const res = evaluateTdxTcb(quoteB64, tcbInfo, {
    atTimeMs: BASE_TIME,
    enforceUpToDate: false,
  })
  t.truthy(res)
  t.true(typeof res.matchedStatus === "string")
})

test.serial("SGX TCB evaluate (sample JSON)", async (t) => {
  const quote = fs.readFileSync("test/sample/sgx/quote.dat")
  const tcbInfo = JSON.parse(
    fs.readFileSync("test/sample/sgx/tcbInfo.json", "utf-8"),
  )

  const res = evaluateSgxTcb(quote, tcbInfo, {
    atTimeMs: BASE_TIME,
    enforceUpToDate: false,
  })
  t.truthy(res)
  t.true(typeof res.matchedStatus === "string")
})

test.serial("TCB Info signature verification (TDX sample)", async (t) => {
  // We don't have real header signature/chain in repo; so we re-use the JSON body with a fake signature to ensure function surfaces false
  const tcbInfoText = fs.readFileSync("test/sample/tdx/tcbInfo.json", "utf-8")
  const signingChain: string[] = []
  const ok = await verifyTcbInfoSignature({
    tcbInfoText,
    signature: "00", // invalid
    signingChain,
    hash: "SHA-256",
  })
  t.false(ok)
})

