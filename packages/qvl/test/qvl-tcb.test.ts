// @ts-nocheck
import test from "ava"
import fs from "node:fs"
import path from "node:path"
import {
  verifySgx,
  parseSgxQuote,
  isSgxQuote,
  QV_X509Certificate,
} from "ra-https-qvl"
import { extractPemCertificates } from "ra-https-qvl/utils"

const BASE_TIME = Date.parse("2025-09-01")
const SAMPLE_DIR = "test/sample/sgx"

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
    return JSON.parse(raw)
  }

  const url = `https://api.trustedservices.intel.com/sgx/certification/v4/tcb?fmspc=${fmspc}`
  const headers: Record<string, string> = {
    Accept: "application/json",
  }
  // Optional API key if available in environment
  const key =
    process.env.INTEL_SGX_API_KEY ||
    process.env.INTEL_API_KEY ||
    process.env.OCP_APIM_SUBSCRIPTION_KEY
  if (key) headers["Ocp-Apim-Subscription-Key"] = key

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

function parseCpuSvn(quoteBytes: Uint8Array): number[] {
  const { body } = parseSgxQuote(quoteBytes)
  return Array.from(body.cpu_svn)
}

function getPceSvn(quoteBytes: Uint8Array): number {
  const { header } = parseSgxQuote(quoteBytes)
  return header.pce_svn
}

function pickTcbStatusForSgx(
  quoteBytes: Uint8Array,
  info: IntelTcbInfo,
): {
  status: string
  matchedLevelIndex: number
  freshnessOk: boolean
} {
  const cpuSvn = parseCpuSvn(quoteBytes)
  const pceSvn = getPceSvn(quoteBytes)

  const tcbInfo = info.tcbInfo
  const now = BASE_TIME
  const freshnessOk =
    Date.parse(tcbInfo.issueDate) <= now && now <= Date.parse(tcbInfo.nextUpdate)

  // Iterate in provided order; Intel typically sorts from most secure to least
  for (let i = 0; i < tcbInfo.tcbLevels.length; i++) {
    const level = tcbInfo.tcbLevels[i]
    const tcb = level.tcb

    const pceOk = typeof tcb.pcesvn === "number" ? pceSvn >= tcb.pcesvn : true
    // Compare each SGX component SVN if present
    let cpuOk = true
    for (let comp = 1; comp <= 16; comp++) {
      const key = `sgxtcbcomp${String(comp).padStart(2, "0")}svn`
      if (Object.prototype.hasOwnProperty.call(tcb, key)) {
        const required = (tcb as any)[key] as number
        if (cpuSvn[comp - 1] < required) {
          cpuOk = false
          break
        }
      }
    }

    if (cpuOk && pceOk) {
      return { status: level.tcbStatus, matchedLevelIndex: i, freshnessOk }
    }
  }

  // If no level matched, treat as OutOfDate
  return { status: "OutOfDate", matchedLevelIndex: -1, freshnessOk }
}

function isAcceptableStatus(status: string): boolean {
  return (
    status === "UpToDate" ||
    status === "ConfigurationNeeded" ||
    status === "OutOfDateConfigurationNeeded"
  )
}

// Builds a verifyFmspc callback that captures the evaluated state for assertions
function buildVerifyFmspcHook(stateRef: { status?: string; freshnessOk?: boolean }) {
  return async (fmspcHex: string, quote: unknown): Promise<boolean> => {
    try {
      if (!isSgxQuote(quote as any)) return false
      const parsed = quote as any

      // Fetch and evaluate
      const tcbInfo = await fetchAndCacheTcbInfo(fmspcHex)
      const cpuSvn = Array.from(parsed.body.cpu_svn as Uint8Array)
      const pceSvn = parsed.header.pce_svn as number
      const now = BASE_TIME
      const freshnessOk =
        Date.parse(tcbInfo.tcbInfo.issueDate) <= now &&
        now <= Date.parse(tcbInfo.tcbInfo.nextUpdate)

      let statusFound = "OutOfDate"
      for (const level of tcbInfo.tcbInfo.tcbLevels) {
        const tcb = level.tcb as any
        const pceOk =
          typeof tcb.pcesvn === "number" ? pceSvn >= tcb.pcesvn : true
        let cpuOk = true
        for (let comp = 1; comp <= 16; comp++) {
          const key = `sgxtcbcomp${String(comp).padStart(2, "0")}svn`
          if (Object.prototype.hasOwnProperty.call(tcb, key)) {
            if (cpuSvn[comp - 1] < tcb[key]) {
              cpuOk = false
              break
            }
          }
        }
        if (cpuOk && pceOk) {
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

