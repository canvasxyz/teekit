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
    // - PCE SVN must be >= the level's pcesvn
    // - For each TCB component present (SGX or TDX),
    //   the quote's component must be >= the level's required svn
    // On first match, adopt that level's tcbStatus.
    let statusFound: string | null = null
    for (const level of tcbInfo.tcbInfo.tcbLevels) {
      const tcb = level.tcb as Record<string, unknown>
      const pceRequired = (tcb.pcesvn as number) ?? 0
      const pceOk = (pceSvn ?? 0) >= pceRequired

      let cpuOk = true

      // Prefer array-based components for TDX only; keep SGX behavior as before
      // (SGX samples often include placeholder 255 values which should not be
      // compared directly).
      const tdxArray = Array.isArray((tcb as any).tdxtcbcomponents)
        ? ((tcb as any).tdxtcbcomponents as Array<{ svn?: number }>)
        : null

      const preferredArray = tdx ? tdxArray : null

      if (preferredArray) {
        for (let i = 0; i < Math.min(preferredArray.length, cpuSvn.length); i++) {
          const required = preferredArray[i]?.svn
          // Only enforce checks for realistic 0..255 values
          if (
            typeof required === "number" &&
            required >= 0 &&
            required <= 255 &&
            cpuSvn[i] < required
          ) {
            cpuOk = false
            break
          }
        }
      } else {
        // Legacy flat-key representation (e.g. sgxtcbcompXXsvn / tdxtcbcompXXsvn)
        for (let comp = 1; comp <= 16; comp++) {
          const key = `${tdx ? "tdx" : "sgx"}tcbcomp${String(comp).padStart(2, "0")}svn`
          if (Object.prototype.hasOwnProperty.call(tcb, key)) {
            const required = (tcb as any)[key]
            if (
              typeof required === "number" &&
              required >= 0 &&
              required <= 255 &&
              cpuSvn[comp - 1] < required
            ) {
              cpuOk = false
              break
            }
          }
        }
      }

      if (cpuOk && pceOk) {
        statusFound = level.tcbStatus
        break
      }
    }

    if (!statusFound) {
      console.log(
        `[TCB] No matching TCB level found for FMSPC=${fmspcHex.toLowerCase()} (tdx=${tdx}). Defaulting to OutOfDate`,
      )
    }

    stateRef.fmspc = fmspcHex
    stateRef.status = statusFound ?? "OutOfDate"
    stateRef.freshnessOk = freshnessOk

    const valid =
      freshnessOk &&
      ((statusFound ?? "OutOfDate") === "UpToDate" ||
        (statusFound ?? "OutOfDate") === "ConfigurationNeeded")
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
