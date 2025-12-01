import test, { ExecutionContext } from "ava"
import fs from "node:fs"
import path from "node:path"
import { base64 as scureBase64 } from "@scure/base"

import {
  IntelTcbInfo,
  isTdxQuote,
  VerifyConfig,
  verifySgx,
  verifyTdx,
} from "@teekit/qvl"
import { getTcbStatus, isTcbInfoFresh, TcbRef } from "@teekit/qvl/tcb"

const BASE_TIME = Date.parse("2025-09-29T23:00:00Z")
const SAMPLE_DIR = "test/sampleTcbInfos"

async function fetchTcbInfo(
  fmspcHex: string,
  tdx: boolean,
): Promise<IntelTcbInfo> {
  const fmspc = fmspcHex.toLowerCase()
  const tdxsgx = tdx ? "tdx" : "sgx"
  const cachePath = path.join(SAMPLE_DIR, `tcbInfo-${tdxsgx}-${fmspc}.json`)

  if (fs.existsSync(cachePath)) {
    const raw = fs.readFileSync(cachePath, "utf8")
    return JSON.parse(raw)
  } else {
    console.log("unexpected: getting tcbInfo from API:", fmspcHex)
    const url = `https://api.trustedservices.intel.com/${tdxsgx}/certification/v4/tcb?fmspc=${fmspc}`
    const resp = await fetch(url, { headers: { Accept: "application/json" } })
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch TCB info for FMSPC=${fmspc}: ${resp.status} ${resp.statusText}`,
      )
    }
    const result = await resp.json()
    // fs.writeFileSync(cachePath, JSON.stringify(result), "utf8")
    return result
  }
}

// Builds a verifyTcb hook that captures the status & freshness in TcbRef
export function getVerifyTcb(stateRef: TcbRef, baseTime?: number) {
  type VerifyArgs = Parameters<VerifyConfig["verifyTcb"]>[0]
  return async ({ fmspc, cpuSvn, pceSvn, quote }: VerifyArgs) => {
    // Fetch TCB info
    const isTdx = isTdxQuote(quote)
    const tcbInfo = await fetchTcbInfo(fmspc, isTdx)
    const now = baseTime ?? +new Date()

    // Determine the TCB status and check freshness
    const statusFound = getTcbStatus(tcbInfo, cpuSvn, pceSvn, isTdx)
    const tcbInfoFresh = isTcbInfoFresh(tcbInfo, now)

    stateRef.fmspc = fmspc
    stateRef.status = statusFound
    stateRef.tcbInfoFresh = tcbInfoFresh

    return (
      tcbInfoFresh &&
      (statusFound === "UpToDate" || statusFound === "ConfigurationNeeded")
    )
  }
}

async function assertTcb(
  t: ExecutionContext<unknown>,
  path: string,
  config: {
    _tdx: boolean
    _b64?: boolean
    _json?: boolean
    valid: boolean
    status: string
    tcbInfoFreshness: boolean
    fmspc: string
  },
) {
  const { _tdx, _b64, _json, valid, status, tcbInfoFreshness, fmspc } = config

  const quote: Uint8Array = _b64
    ? scureBase64.decode(fs.readFileSync(path, "utf-8"))
    : _json
    ? scureBase64.decode(JSON.parse(fs.readFileSync(path, "utf-8")).tdx.quote)
    : fs.readFileSync(path)

  const stateRef: TcbRef = {}
  const ok = await (_tdx ? verifyTdx : verifySgx)(quote, {
    date: BASE_TIME,
    crls: [],
    verifyTcb: getVerifyTcb(stateRef, BASE_TIME),
    verifyMeasurements: () => true,
  })

  t.is(valid, ok)
  t.is(stateRef.fmspc, fmspc)
  t.is(stateRef.status, status)
  t.is(stateRef.tcbInfoFresh, tcbInfoFreshness)
}

test.serial("Evaluate TCB (SGX): occlum", async (t) => {
  await assertTcb(t, "test/sampleQuotes/sgx-occlum.dat", {
    _tdx: false,
    valid: false,
    status: "OutOfDate",
    tcbInfoFreshness: true,
    fmspc: "30606a000000",
  })
})

test.serial("Evaluate TCB (SGX): chinenyeokafor", async (t) => {
  await assertTcb(t, "test/sampleQuotes/sgx-chinenyeokafor.dat", {
    _tdx: false,
    valid: true,
    status: "UpToDate",
    tcbInfoFreshness: true,
    fmspc: "90c06f000000",
  })
})

test.serial("Evaluate TCB (SGX): tlsn-quote9", async (t) => {
  await assertTcb(t, "test/sampleQuotes/sgx-tlsn-quote9.dat", {
    _tdx: false,
    valid: false,
    status: "SWHardeningNeeded",
    tcbInfoFreshness: true,
    fmspc: "00906ed50000",
  })
})

test.serial("Evaluate TCB (SGX): tlsn-quotedev", async (t) => {
  await assertTcb(t, "test/sampleQuotes/sgx-tlsn-quotedev.dat", {
    _tdx: false,
    valid: false,
    status: "SWHardeningNeeded",
    tcbInfoFreshness: true,
    fmspc: "00906ed50000",
  })
})

test.serial("Evaluate TCB (TDX v5): trustee", async (t) => {
  await assertTcb(t, "test/sampleQuotes/tdx-v5-trustee.dat", {
    _tdx: true,
    valid: true,
    status: "UpToDate",
    tcbInfoFreshness: true,
    fmspc: "90c06f000000",
  })
})

test.serial("Evaluate TCB (TDX v4): azure", async (t) => {
  await assertTcb(t, "test/sampleQuotes/tdx-v4-azure", {
    _tdx: true,
    _b64: true,
    valid: false,
    status: "OutOfDate",
    tcbInfoFreshness: true,
    fmspc: "00806f050000",
  })
})

test.serial("Evaluate TCB (TDX v4): edgeless", async (t) => {
  await assertTcb(t, "test/sampleQuotes/tdx-v4-edgeless.dat", {
    _tdx: true,
    valid: false,
    status: "OutOfDate",
    tcbInfoFreshness: true,
    fmspc: "00806f050000",
  })
})

test.serial("Evaluate TCB (TDX v4): gcp", async (t) => {
  await assertTcb(t, "test/sampleQuotes/tdx-v4-gcp.json", {
    _tdx: true,
    _json: true,
    valid: true,
    status: "UpToDate",
    tcbInfoFreshness: true,
    fmspc: "00806f050000",
  })
})

test.serial("Evaluate TCB (TDX v4): gcp no nonce", async (t) => {
  await assertTcb(t, "test/sampleQuotes/tdx-v4-gcp-no-nonce.json", {
    _tdx: true,
    _json: true,
    valid: true,
    status: "UpToDate",
    tcbInfoFreshness: true,
    fmspc: "00806f050000",
  })
})

test.serial("Evaluate TCB (TDX v4): moemahhouk", async (t) => {
  await assertTcb(t, "test/sampleQuotes/tdx-v4-moemahhouk.dat", {
    _tdx: true,
    valid: false,
    status: "OutOfDate",
    tcbInfoFreshness: true,
    fmspc: "90c06f000000",
  })
})

test.serial("Evaluate TCB (TDX v4): phala", async (t) => {
  await assertTcb(t, "test/sampleQuotes/tdx-v4-phala.dat", {
    _tdx: true,
    valid: true,
    status: "UpToDate",
    tcbInfoFreshness: true,
    fmspc: "b0c06f000000",
  })
})

test.serial("Evaluate TCB (TDX v4): trustee", async (t) => {
  await assertTcb(t, "test/sampleQuotes/tdx-v4-trustee.dat", {
    _tdx: true,
    valid: false,
    status: "OutOfDate",
    tcbInfoFreshness: true,
    fmspc: "50806f000000",
  })
})

test.serial("Evaluate TCB (TDX v4): zkdcap", async (t) => {
  await assertTcb(t, "test/sampleQuotes/tdx-v4-zkdcap.dat", {
    _tdx: true,
    valid: false,
    status: "OutOfDate",
    tcbInfoFreshness: true,
    fmspc: "00806f050000",
  })
})
