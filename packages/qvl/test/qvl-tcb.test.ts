import test, { ExecutionContext } from "ava"
import fs from "node:fs"
import path from "node:path"
import { base64 as scureBase64 } from "@scure/base"

import {
  verifySgx,
  verifyTdx,
  isSgxQuote,
  isTdxQuote,
  SgxQuote,
  TdxQuote,
  IntelTcbInfo,
} from "ra-https-qvl"

const BASE_TIME = Date.parse("2025-09-28T12:00:00Z")
const SAMPLE_DIR = "test/sample"

async function fetchTcbInfo(
  fmspcHex: string,
  opts?: { tdx?: boolean },
): Promise<IntelTcbInfo> {
  const fmspc = fmspcHex.toLowerCase()
  const cachePath = path.join(SAMPLE_DIR, `tcbInfo-${fmspc}.json`)
  if (opts?.tdx) {
    const tdxPath = path.join(SAMPLE_DIR, "tdx", "tcbInfo.json")
    if (fs.existsSync(tdxPath)) {
      const raw = fs.readFileSync(tdxPath, "utf8")
      return JSON.parse(raw)
    }
  }

  if (fs.existsSync(cachePath)) {
    const raw = fs.readFileSync(cachePath, "utf8")
    return JSON.parse(raw)
  } else {
    console.log("[unexpected!] getting tcbInfo from API:", fmspcHex)
    const url = `https://api.trustedservices.intel.com/sgx/certification/v4/tcb?fmspc=${fmspc}`
    const resp = await fetch(url, { headers: { Accept: "application/json" } })
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch TCB info for FMSPC=${fmspc}: ${resp.status} ${resp.statusText}`,
      )
    }
    return await resp.json()
  }
}

type TcbRef = { status?: string; freshnessOk?: boolean; fmspc?: string }

// Builds a verifyTcb hook that captures the status & freshness
function getVerifyTcb(stateRef: TcbRef) {
  type Quote = SgxQuote | TdxQuote

  return async (fmspcHex: string, quote: Quote): Promise<boolean> => {
    // Extract cpu_svn, pce_svn
    let cpuSvn: number[] | null = null
    let pceSvn: number | null = null
    let tdx = false
    if (isSgxQuote(quote)) {
      cpuSvn = Array.from(quote.body.cpu_svn)
      pceSvn = quote.header.pce_svn
      tdx = false
    } else if (isTdxQuote(quote)) {
      cpuSvn = Array.from(quote.body.tee_tcb_svn)
      pceSvn = quote.header.pce_svn
      tdx = true
    } else {
      return false
    }

    // Fetch TCB info
    const tcbInfo = await fetchTcbInfo(fmspcHex, { tdx })
    const now = BASE_TIME

    // Check freshness
    const freshnessOk =
      Date.parse(tcbInfo.tcbInfo.issueDate) <= now &&
      now <= Date.parse(tcbInfo.tcbInfo.nextUpdate)

    // Determine the TCB status by finding the first Intel TCB level
    // whose requirements are satisfied by the quote.
    // For SGX quotes, compare against sgxtcbcomponents (array) if present,
    // otherwise fall back to legacy sgxtcbcompXXsvn keys.
    // For TDX quotes, compare against tdxtcbcomponents (array) if present.
    let statusFound = "OutOfDate"
    let matchedLevel = false
    for (const level of tcbInfo.tcbInfo.tcbLevels) {
      // For TDX, PCE SVN in quotes may be 0 or not applicable; ignore PCE gate
      const pceOk = tdx ? true : pceSvn >= level.tcb.pcesvn

      // Gather required component SVNs for this level
      let required: Array<number | undefined> = new Array(16).fill(undefined)
      if (tdx && Array.isArray(level.tcb.tdxtcbcomponents)) {
        for (let i = 0; i < Math.min(16, level.tcb.tdxtcbcomponents.length); i++) {
          const comp = level.tcb.tdxtcbcomponents[i]
          required[i] = typeof comp?.svn === "number" ? comp.svn : undefined
        }
      } else {
        // Legacy per-component keys: sgxtcbcompXXsvn
        for (let comp = 1; comp <= 16; comp++) {
          const key = `sgxtcbcomp${String(comp).padStart(2, "0")}svn`
          if (Object.prototype.hasOwnProperty.call(level.tcb, key)) {
            required[comp - 1] = level.tcb[key]
          }
        }
      }

      let cpuOk = true
      for (let i = 0; i < Math.min(16, cpuSvn.length); i++) {
        const need = required[i]
        if (typeof need === "number") {
          const have = cpuSvn[i]
          if (have !== undefined && have !== null) {
            if (have < need) {
              cpuOk = false
              break
            }
          }
        }
      }

      if (cpuOk && pceOk) {
        statusFound = level.tcbStatus
        matchedLevel = true
        break
      }
    }

    stateRef.fmspc = fmspcHex
    stateRef.status = statusFound
    stateRef.freshnessOk = freshnessOk

    if (!matchedLevel) {
      console.log(
        `[tcb] No matching TCB level found in TcbInfo (id=${tcbInfo.tcbInfo.id}) for ${tdx ? "TDX" : "SGX"} FMSPC=${tcbInfo.tcbInfo.fmspc} PCE_SVN=${pceSvn}; treating as OutOfDate`,
      )
    }

    const valid =
      freshnessOk &&
      (statusFound === "UpToDate" || statusFound === "ConfigurationNeeded")
    // console.log("status", statusFound, "fresh", freshnessOk, "valid", valid)

    return valid
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
    fresh: boolean
    fmspc: string
  },
) {
  const { _tdx, _b64, _json, valid, status, fresh, fmspc } = config

  const quote: Uint8Array = _b64
    ? scureBase64.decode(fs.readFileSync(path, "utf-8"))
    : _json
      ? scureBase64.decode(JSON.parse(fs.readFileSync(path, "utf-8")).tdx.quote)
      : fs.readFileSync(path)

  const stateRef: TcbRef = {}
  const ok = await (_tdx ? verifyTdx : verifySgx)(quote, {
    date: BASE_TIME,
    crls: [],
    verifyTcb: getVerifyTcb(stateRef),
  })

  t.is(valid, ok)
  t.is(stateRef.fmspc, fmspc)
  t.is(stateRef.status, status)
  t.is(stateRef.freshnessOk, fresh)
}

test.serial("Evaluate TCB (SGX): occlum", async (t) => {
  await assertTcb(t, "test/sample/sgx-occlum.dat", {
    _tdx: false,
    valid: false,
    status: "SWHardeningNeeded",
    fresh: true,
    fmspc: "30606a000000",
  })
})

test.serial("Evaluate TCB (SGX): chinenyeokafor", async (t) => {
  await assertTcb(t, "test/sample/sgx-chinenyeokafor.dat", {
    _tdx: false,
    valid: true,
    status: "UpToDate",
    fresh: true,
    fmspc: "90c06f000000",
  })
})

test.serial("Evaluate TCB (SGX): tlsn-quote9", async (t) => {
  await assertTcb(t, "test/sample/sgx-tlsn-quote9.dat", {
    _tdx: false,
    valid: false,
    status: "SWHardeningNeeded",
    fresh: true,
    fmspc: "00906ed50000",
  })
})

test.serial("Evaluate TCB (SGX): tlsn-quotedev", async (t) => {
  await assertTcb(t, "test/sample/sgx-tlsn-quotedev.dat", {
    _tdx: false,
    valid: false,
    status: "SWHardeningNeeded",
    fresh: true,
    fmspc: "00906ed50000",
  })
})

test.serial("Evaluate TCB (TDX v5): trustee", async (t) => {
  await assertTcb(t, "test/sample/tdx-v5-trustee.dat", {
    _tdx: true,
    valid: false,
    status: "OutOfDate",
    fresh: true,
    fmspc: "90c06f000000",
  })
})

test.serial("Evaluate TCB (TDX v4): azure", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-azure", {
    _tdx: true,
    _b64: true,
    valid: false,
    status: "OutOfDate",
    fresh: true,
    fmspc: "00806f050000",
  })
})

test.serial("Evaluate TCB (TDX v4): edgeless", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-edgeless.dat", {
    _tdx: true,
    valid: false,
    status: "OutOfDate",
    fresh: true,
    fmspc: "00806f050000",
  })
})

test.serial("Evaluate TCB (TDX v4): gcp", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-gcp.json", {
    _tdx: true,
    _json: true,
    valid: false,
    status: "OutOfDate",
    fresh: true,
    fmspc: "00806f050000",
  })
})

test.serial("Evaluate TCB (TDX v4): gcp no nonce", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-gcp-no-nonce.json", {
    _tdx: true,
    _json: true,
    valid: false,
    status: "OutOfDate",
    fresh: true,
    fmspc: "00806f050000",
  })
})

test.serial("Evaluate TCB (TDX v4): moemahhouk", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-moemahhouk.dat", {
    _tdx: true,
    valid: false,
    status: "OutOfDate",
    fresh: true,
    fmspc: "90c06f000000",
  })
})

test.serial("Evaluate TCB (TDX v4): phala", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-phala.dat", {
    _tdx: true,
    valid: false,
    status: "OutOfDate",
    fresh: true,
    fmspc: "b0c06f000000",
  })
})

test.serial("Evaluate TCB (TDX v4): trustee", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-trustee.dat", {
    _tdx: true,
    valid: false,
    status: "OutOfDate",
    fresh: true,
    fmspc: "50806f000000",
  })
})

test.serial("Evaluate TCB (TDX v4): zkdcap", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-zkdcap.dat", {
    _tdx: true,
    valid: false,
    status: "OutOfDate",
    fresh: true,
    fmspc: "00806f050000",
  })
})
