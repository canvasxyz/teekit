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

async function fetchTcbInfo(fmspcHex: string): Promise<IntelTcbInfo> {
  const fmspc = fmspcHex.toLowerCase()
  const cachePath = path.join(SAMPLE_DIR, `tcbInfo-${fmspc}.json`)

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
    const tcbInfo = await fetchTcbInfo(fmspcHex)
    const now = BASE_TIME

    // Check freshness
    const freshnessOk =
      Date.parse(tcbInfo.tcbInfo.issueDate) <= now &&
      now <= Date.parse(tcbInfo.tcbInfo.nextUpdate)

    // Determine the TCB status by finding the first Intel TCB level
    // whose requirements are satisfied by the quote:
    // - PCE SVN must be >= the level's pcesvn (if present)
    // - For each CPU SVN component present in the level, the quote's
    //   corresponding svn byte must be >= the level's value
    // Supports both legacy SGX keys (sgxtcbcompXXsvn) and array styles
    // (sgxtcbcomponents/tdxtcbcomponents) used by newer Intel schemas.
    let statusFound = "NoTCBMatch"
    for (const level of tcbInfo.tcbInfo.tcbLevels) {
      const levelTcb: any = level.tcb as any
      const levelPceSvn: number | undefined = levelTcb.pcesvn
      const pceOk =
        typeof levelPceSvn === "number" ? pceSvn >= levelPceSvn : true

      // Build unified required component list (up to 16 entries)
      const reqs: Array<number | undefined> = new Array(16).fill(undefined)

      if (tdx) {
        // For TDX quotes: prefer TDX component array; fallback to SGX array;
        // then fallback to legacy numeric keys
        const tdxArray: Array<{ svn?: number }> | undefined = Array.isArray(
          levelTcb.tdxtcbcomponents,
        )
          ? levelTcb.tdxtcbcomponents
          : undefined
        const sgxArray: Array<{ svn?: number }> | undefined = Array.isArray(
          levelTcb.sgxtcbcomponents,
        )
          ? levelTcb.sgxtcbcomponents
          : undefined

        const compArray = tdxArray ?? sgxArray
        if (compArray && compArray.length > 0) {
          for (let i = 0; i < Math.min(16, compArray.length); i++) {
            const v = compArray[i]?.svn
            if (typeof v === "number") reqs[i] = v
          }
        } else {
          for (let i = 1; i <= 16; i++) {
            const tdxKey = `tdxtcbcomp${String(i).padStart(2, "0")}svn`
            const sgxKey = `sgxtcbcomp${String(i).padStart(2, "0")}svn`
            if (Object.prototype.hasOwnProperty.call(levelTcb, tdxKey)) {
              const v = levelTcb[tdxKey]
              if (typeof v === "number") reqs[i - 1] = v
            } else if (
              Object.prototype.hasOwnProperty.call(levelTcb, sgxKey)
            ) {
              const v = levelTcb[sgxKey]
              if (typeof v === "number") reqs[i - 1] = v
            }
          }
        }
      } else {
        // For SGX quotes: use legacy numeric keys only, to match existing behavior
        for (let i = 1; i <= 16; i++) {
          const key = `sgxtcbcomp${String(i).padStart(2, "0")}svn`
          if (Object.prototype.hasOwnProperty.call(levelTcb, key)) {
            const v = levelTcb[key]
            if (typeof v === "number") reqs[i - 1] = v
          }
        }
      }

      // Evaluate CPU SVN against requirements; treat 255 as "ignore"
      let cpuOk = true
      for (let i = 0; i < 16; i++) {
        const required = reqs[i]
        if (typeof required !== "number") continue
        if (required === 255) continue
        if (cpuSvn[i] < required) {
          cpuOk = false
          break
        }
      }

      if (cpuOk && pceOk) {
        statusFound = level.tcbStatus
        break
      }
    }

    stateRef.fmspc = fmspcHex
    stateRef.status = statusFound
    stateRef.freshnessOk = freshnessOk

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
    status: "NoTCBMatch",
    fresh: true,
    fmspc: "90c06f000000",
  })
})

test.serial("Evaluate TCB (TDX v4): azure", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-azure", {
    _tdx: true,
    _b64: true,
    valid: false,
    status: "NoTCBMatch",
    fresh: true,
    fmspc: "00806f050000",
  })
})

test.serial("Evaluate TCB (TDX v4): edgeless", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-edgeless.dat", {
    _tdx: true,
    valid: false,
    status: "NoTCBMatch",
    fresh: true,
    fmspc: "00806f050000",
  })
})

test.serial("Evaluate TCB (TDX v4): gcp", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-gcp.json", {
    _tdx: true,
    _json: true,
    valid: false,
    status: "NoTCBMatch",
    fresh: true,
    fmspc: "00806f050000",
  })
})

test.serial("Evaluate TCB (TDX v4): gcp no nonce", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-gcp-no-nonce.json", {
    _tdx: true,
    _json: true,
    valid: false,
    status: "NoTCBMatch",
    fresh: true,
    fmspc: "00806f050000",
  })
})

test.serial("Evaluate TCB (TDX v4): moemahhouk", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-moemahhouk.dat", {
    _tdx: true,
    valid: false,
    status: "NoTCBMatch",
    fresh: true,
    fmspc: "90c06f000000",
  })
})

test.serial("Evaluate TCB (TDX v4): phala", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-phala.dat", {
    _tdx: true,
    valid: false,
    status: "NoTCBMatch",
    fresh: true,
    fmspc: "b0c06f000000",
  })
})

test.serial("Evaluate TCB (TDX v4): trustee", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-trustee.dat", {
    _tdx: true,
    valid: false,
    status: "NoTCBMatch",
    fresh: true,
    fmspc: "50806f000000",
  })
})

test.serial("Evaluate TCB (TDX v4): zkdcap", async (t) => {
  await assertTcb(t, "test/sample/tdx-v4-zkdcap.dat", {
    _tdx: true,
    valid: false,
    status: "NoTCBMatch",
    fresh: true,
    fmspc: "00806f050000",
  })
})
