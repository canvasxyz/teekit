import test from "ava"
import fs from "node:fs"
import path from "node:path"
import {
  verifySgx,
  verifyTdx,
  isSgxQuote,
  isTdxQuote,
  QV_X509Certificate,
} from "ra-https-qvl"
import { extractPemCertificates } from "ra-https-qvl/utils"

const BASE_TIME = Date.parse("2025-09-01")
const SAMPLE_DIR = "test/sample"

type IntelTcbInfo = {
  tcbInfo: {
    version: number
    issueDate: string
    nextUpdate: string
    fmspc: string
    pceId: string
    tcbType: number
    tcbEvaluationDataNumber: number
    tcbLevels: Array<{
      tcb: { [k: string]: number }
      tcbDate: string
      tcbStatus:
        | "UpToDate"
        | "OutOfDate"
        | "OutOfDateConfigurationNeeded"
        | "ConfigurationNeeded"
        | "Revoked"
        | string
    }>
  }
  signature?: string
}

async function fetchAndCacheTcbInfo(fmspcHex: string): Promise<IntelTcbInfo> {
  const fmspc = fmspcHex.toLowerCase()
  const cachePath = path.join(SAMPLE_DIR, `tcbInfo-${fmspc}.json`)

  // Return from cache when present
  if (fs.existsSync(cachePath)) {
    const raw = fs.readFileSync(cachePath, "utf8")
    console.log("got tcbInfo from cache:", fmspcHex)
    return JSON.parse(raw)
  }
  console.log("getting tcbInfo from API:", fmspcHex)

  const url = `https://api.trustedservices.intel.com/sgx/certification/v4/tcb?fmspc=${fmspc}`
  const headers: Record<string, string> = {
    Accept: "application/json",
  }

  const resp = await fetch(url, { headers })
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch TCB info for FMSPC=${fmspc}: ${resp.status} ${resp.statusText}`,
    )
  }
  const data = (await resp.json()) as IntelTcbInfo

  // Ensure samples directory exists and write cache
  fs.mkdirSync(SAMPLE_DIR, { recursive: true })
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2))
  return data
}

function isAcceptableStatus(status: string): boolean {
  return (
    status === "UpToDate" ||
    status === "ConfigurationNeeded" ||
    status === "OutOfDateConfigurationNeeded"
  )
}

// Builds a verifyFmspc callback that captures the evaluated state for assertions
function buildVerifyFmspcHook(stateRef: {
  status?: string
  freshnessOk?: boolean
}) {
  return async (fmspcHex: string, quote: unknown): Promise<boolean> => {
    try {
      const parsed = quote as any

      // Fetch and evaluate
      const tcbInfo = await fetchAndCacheTcbInfo(fmspcHex)
      // Map quote -> component SVN bytes and PCE SVN
      let compSvn: number[] = []
      let pceSvn = 0
      if (isSgxQuote(parsed)) {
        compSvn = Array.from(parsed.body.cpu_svn as Uint8Array)
        pceSvn = parsed.header.pce_svn as number
      } else if (isTdxQuote(parsed)) {
        // TDX uses tee_tcb_svn (16 bytes) and pce_svn in header
        compSvn = Array.from(parsed.body.tee_tcb_svn as Uint8Array)
        pceSvn = parsed.header.pce_svn as number
      } else {
        return false
      }
      const now = BASE_TIME
      const freshnessOk =
        Date.parse(tcbInfo.tcbInfo.issueDate) <= now &&
        now <= Date.parse(tcbInfo.tcbInfo.nextUpdate)

      let statusFound = "OutOfDate"
      for (const level of tcbInfo.tcbInfo.tcbLevels) {
        const tcb = level.tcb as any
        const pceOk = typeof tcb.pcesvn === "number" ? pceSvn >= tcb.pcesvn : true

        // Compare component SVNs. Support both flattened keys and array form.
        let compsOk = true
        if (Array.isArray(tcb.sgxtcbcomponents)) {
          for (let i = 0; i < Math.min(16, tcb.sgxtcbcomponents.length); i++) {
            const req = tcb.sgxtcbcomponents[i]
            if (req && typeof req.svn === "number") {
              if ((compSvn[i] ?? 0) < req.svn) {
                compsOk = false
                break
              }
            }
          }
        } else {
          for (let comp = 1; comp <= 16; comp++) {
            const key = `sgxtcbcomp${String(comp).padStart(2, "0")}svn`
            if (Object.prototype.hasOwnProperty.call(tcb, key)) {
              if ((compSvn[comp - 1] ?? 0) < tcb[key]) {
                compsOk = false
                break
              }
            }
          }
        }

        if (compsOk && pceOk) {
          statusFound = level.tcbStatus
          break
        }
      }

      stateRef.status = statusFound
      stateRef.freshnessOk = freshnessOk

      // Accept only certain statuses and require freshness
      return freshnessOk && isAcceptableStatus(statusFound)
    } catch (e) {
      // If TCB fetch fails (e.g., 404), treat as policy failure
      stateRef.status = "Unavailable"
      stateRef.freshnessOk = false
      return false
    }
  }
}

function loadExtraCertsIfNeeded(samplePath: string): {
  crls: Uint8Array[]
  extraCertdata?: string[]
  pinnedRoot?: QV_X509Certificate
} {
  if (samplePath.endsWith("test/sample/sgx/quote.dat")) {
    const root = extractPemCertificates(
      fs.readFileSync("test/sample/sgx/trustedRootCaCert.pem"),
    )
    const pckChain = extractPemCertificates(
      fs.readFileSync("test/sample/sgx/pckSignChain.pem"),
    )
    const pckCert = extractPemCertificates(
      fs.readFileSync("test/sample/sgx/pckCert.pem"),
    )
    const extraCertdata = [...root, ...pckChain, ...pckCert]
    const crls = [
      fs.readFileSync("test/sample/sgx/rootCaCrl.der"),
      fs.readFileSync("test/sample/sgx/intermediateCaCrl.der"),
    ]
    return { crls, extraCertdata, pinnedRoot: new QV_X509Certificate(root[0]) }
  }
  if (samplePath.endsWith("test/sample/tdx/quote.dat")) {
    const root = extractPemCertificates(
      fs.readFileSync("test/sample/tdx/trustedRootCaCert.pem"),
    )
    const pckChain = extractPemCertificates(
      fs.readFileSync("test/sample/tdx/pckSignChain.pem"),
    )
    const pckCert = extractPemCertificates(
      fs.readFileSync("test/sample/tdx/pckCert.pem"),
    )
    const extraCertdata = [...root, ...pckChain, ...pckCert]
    const crls = [
      fs.readFileSync("test/sample/tdx/rootCaCrl.der"),
      fs.readFileSync("test/sample/tdx/intermediateCaCrl.der"),
    ]
    return { crls, extraCertdata, pinnedRoot: new QV_X509Certificate(root[0]) }
  }
  return { crls: [] }
}

async function runSgxSample(t: any, sampleRelPath: string) {
  const quote = fs.readFileSync(sampleRelPath)
  const state: { status?: string; freshnessOk?: boolean } = {}
  const verifyHook = buildVerifyFmspcHook(state)
  const extras = loadExtraCertsIfNeeded(sampleRelPath)

  try {
    const ok = await verifySgx(quote, {
      date: BASE_TIME,
      crls: extras.crls,
      extraCertdata: extras.extraCertdata,
      pinnedRootCerts: extras.pinnedRoot ? [extras.pinnedRoot] : undefined,
      verifyFmspc: verifyHook,
    })

    // verifySgx succeeded: ensure our policy accepted the TCB status
    t.true(ok)
    t.truthy(state.status)
    t.true(state!.freshnessOk === true)
    t.true(isAcceptableStatus(state.status!))
  } catch (err: any) {
    // verifySgx rejected: ensure it is due to our verifyFmspc policy
    t.regex(String(err?.message ?? ""), /TCB validation failed/i)
    t.truthy(state.status)
    // We rejected because of unacceptable status or staleness
    const unacceptable =
      !state!.freshnessOk || !isAcceptableStatus(state.status!)
    t.true(unacceptable)
  }
}

async function runTdxSample(t: any, sampleRelPath: string) {
  let quote: Uint8Array
  if (sampleRelPath.endsWith(".hex")) {
    const hex = fs.readFileSync(sampleRelPath, "utf-8").replace(/^0x/, "")
    quote = Buffer.from(hex, "hex")
  } else if (sampleRelPath.endsWith(".json")) {
    const data = JSON.parse(fs.readFileSync(sampleRelPath, "utf-8"))
    const b64: string = data.tdx?.quote || data.quote
    quote = Buffer.from(b64, "base64")
  } else if (sampleRelPath.endsWith("tdx-v4-azure")) {
    const b64 = fs.readFileSync(sampleRelPath, "utf-8")
    quote = Buffer.from(b64, "base64")
  } else {
    quote = fs.readFileSync(sampleRelPath)
  }

  const state: { status?: string; freshnessOk?: boolean } = {}
  const verifyHook = buildVerifyFmspcHook(state)
  const extras = loadExtraCertsIfNeeded(sampleRelPath)

  try {
    const ok = await verifyTdx(quote, {
      date: BASE_TIME,
      crls: extras.crls,
      extraCertdata: extras.extraCertdata,
      pinnedRootCerts: extras.pinnedRoot ? [extras.pinnedRoot] : undefined,
      verifyFmspc: verifyHook,
    })

    t.true(ok)
    t.truthy(state.status)
    t.true(state!.freshnessOk === true)
    t.true(isAcceptableStatus(state.status!))
  } catch (err: any) {
    t.regex(String(err?.message ?? ""), /TCB validation failed/i)
    t.truthy(state.status)
    const unacceptable = !state!.freshnessOk || !isAcceptableStatus(state.status!)
    t.true(unacceptable)
  }
}

test.serial("TCB eval via verifyFmspc: Intel sample quote.dat", async (t) => {
  await runSgxSample(t, "test/sample/sgx/quote.dat")
})

test.serial("TCB eval via verifyFmspc: sgx-occlum.dat", async (t) => {
  await runSgxSample(t, "test/sample/sgx-occlum.dat")
})

test.serial("TCB eval via verifyFmspc: sgx-chinenyeokafor.dat", async (t) => {
  await runSgxSample(t, "test/sample/sgx-chinenyeokafor.dat")
})

test.serial("TCB eval via verifyFmspc: sgx-tlsn-quote9.dat", async (t) => {
  await runSgxSample(t, "test/sample/sgx-tlsn-quote9.dat")
})

test.serial("TCB eval via verifyFmspc: sgx-tlsn-quotedev.dat", async (t) => {
  await runSgxSample(t, "test/sample/sgx-tlsn-quotedev.dat")
})

// TDX v4 samples
test.serial("TCB eval via verifyFmspc (TDX v4): tappd.hex", async (t) => {
  await runTdxSample(t, "test/sample/tdx-v4-tappd.hex")
})

test.serial("TCB eval via verifyFmspc (TDX v4): edgeless.dat", async (t) => {
  await runTdxSample(t, "test/sample/tdx-v4-edgeless.dat")
})

test.serial("TCB eval via verifyFmspc (TDX v4): phala.dat", async (t) => {
  await runTdxSample(t, "test/sample/tdx-v4-phala.dat")
})

test.serial("TCB eval via verifyFmspc (TDX v4): phala.hex", async (t) => {
  await runTdxSample(t, "test/sample/tdx-v4-phala.hex")
})

test.serial("TCB eval via verifyFmspc (TDX v4): moemahhouk.dat", async (t) => {
  await runTdxSample(t, "test/sample/tdx-v4-moemahhouk.dat")
})

test.serial("TCB eval via verifyFmspc (TDX v4): azure (base64)", async (t) => {
  await runTdxSample(t, "test/sample/tdx-v4-azure")
})

test.serial("TCB eval via verifyFmspc (TDX v4): trustee.dat", async (t) => {
  await runTdxSample(t, "test/sample/tdx-v4-trustee.dat")
})

test.serial("TCB eval via verifyFmspc (TDX v4): zkdcap.dat", async (t) => {
  await runTdxSample(t, "test/sample/tdx-v4-zkdcap.dat")
})

test.serial("TCB eval via verifyFmspc (TDX v4): Intel sample quote.dat", async (t) => {
  await runTdxSample(t, "test/sample/tdx/quote.dat")
})

test.serial("TCB eval via verifyFmspc (TDX v4): GCP json", async (t) => {
  await runTdxSample(t, "test/sample/tdx-v4-gcp.json")
})

// TDX v5 samples
test.serial("TCB eval via verifyFmspc (TDX v5): trustee.dat", async (t) => {
  await runTdxSample(t, "test/sample/tdx-v5-trustee.dat")
})
