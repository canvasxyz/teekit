// @ts-nocheck
import test from "ava"
import fs from "node:fs"
import path from "node:path"
import { verifySgx } from "ra-https-qvl"
import https from "node:https"

const BASE_TIME = Date.parse("2025-09-01")
const SAMPLES_DIR = path.join("test", "sample", "sgx")

type TcbInfoResponse = {
  tcbInfo: {
    version: number
    issueDate: string
    nextUpdate: string
    fmspc: string
    pceId: string
    tcbType: number
    tcbEvaluationDataNumber: number
    tcbLevels: Array<{
      tcb: Record<string, number>
      tcbDate: string
      tcbStatus:
        | "UpToDate"
        | "OutOfDate"
        | "ConfigurationNeeded"
        | "OutOfDateConfigurationNeeded"
        | "Revoked"
        | string
    }>
  }
  signature?: string
}

async function fetchOrLoadTcbInfo(fmspcHex: string): Promise<TcbInfoResponse | null> {
  const filename = path.join(SAMPLES_DIR, `tcb.${fmspcHex.toLowerCase()}.json`)
  try {
    if (fs.existsSync(filename)) {
      const raw = fs.readFileSync(filename, "utf-8")
      return JSON.parse(raw)
    }
  } catch {}

  const url = `https://api.trustedservices.intel.com/sgx/certification/v4/tcb?fmspc=${fmspcHex.toLowerCase()}`
  const headers: Record<string, string> = { Accept: "application/json" }
  const apiKey =
    process.env.INTEL_PCS_API_KEY ||
    process.env.PCS_API_KEY ||
    process.env.INTEL_API_KEY ||
    process.env.OCP_APIM_SUBSCRIPTION_KEY ||
    ""
  if (apiKey) headers["Ocp-Apim-Subscription-Key"] = apiKey

  try {
    let data: TcbInfoResponse | null = null
    if (typeof fetch === "function") {
      const res = await fetch(url, { headers })
      if (!res.ok) return null
      data = (await res.json()) as TcbInfoResponse
    } else {
      data = await new Promise<TcbInfoResponse | null>((resolve) => {
        const req = https.get(url, { headers }, (res) => {
          if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
            resolve(null)
            res.resume()
            return
          }
          const chunks: Buffer[] = []
          res.on("data", (c) => chunks.push(c))
          res.on("end", () => {
            try {
              const text = Buffer.concat(chunks).toString("utf-8")
              resolve(JSON.parse(text))
            } catch {
              resolve(null)
            }
          })
        })
        req.on("error", () => resolve(null))
        req.end()
      })
    }
    if (!data) return null
    try {
      fs.writeFileSync(filename, JSON.stringify(data, null, 2))
    } catch {}
    return data
  } catch {
    return null
  }
}

function classifyFreshness(tcb: TcbInfoResponse["tcbInfo"], atTimeMs: number) {
  const nextUpdateMs = Date.parse(tcb.nextUpdate)
  const issueDateMs = Date.parse(tcb.issueDate)
  const isFresh = Number.isFinite(nextUpdateMs) && atTimeMs < nextUpdateMs
  const isIssued = Number.isFinite(issueDateMs) && issueDateMs <= atTimeMs
  if (isFresh && isIssued) return "fresh"
  if (!isIssued) return "preissue"
  return "stale"
}

async function verifyFmspcFreshness(fmspcHex: string) {
  const tcb = await fetchOrLoadTcbInfo(fmspcHex)
  if (!tcb || !tcb.tcbInfo) {
    return { passed: true, state: "unavailable" as const }
  }
  const state = classifyFreshness(tcb.tcbInfo, BASE_TIME)
  return { passed: true, state }
}

function listSgxQuotes(): string[] {
  const root = path.join("test", "sample")
  const files = fs.readdirSync(root)
  return files
    .filter((f) => f.startsWith("sgx-") && f.endsWith(".dat"))
    .map((f) => path.join(root, f))
}

test.serial("Verify FMSPC freshness for SGX quotes and cache TCBs", async (t) => {
  const quoteFiles = listSgxQuotes()
  t.true(quoteFiles.length > 0, "expected at least one SGX quote sample")

  for (const file of quoteFiles) {
    const buf = fs.readFileSync(file)
    let observedState: string | null = null
    let observedFmspc: string | null = null

    // Phase 1: permissive verifier to record state and ensure SGX path succeeds
    const ok = await verifySgx(buf, {
      date: BASE_TIME,
      crls: [],
      verifyFmspc: async (fmspcHex) => {
        const { passed, state } = await verifyFmspcFreshness(fmspcHex)
        observedState = state
        observedFmspc = fmspcHex.toLowerCase()
        return passed
      },
    })

    t.true(ok, `${path.basename(file)} should pass SGX verification`)

    // Validate observed state matches cached TCB classification if available
    t.truthy(observedState, "verifyFmspc should record a state")
    const expectedState = (() => {
      if (!observedFmspc) return "unavailable"
      const best = path.join(SAMPLES_DIR, `tcb.${observedFmspc}.json`)
      if (!fs.existsSync(best)) return "unavailable"
      try {
        const parsed = JSON.parse(fs.readFileSync(best, "utf-8")) as TcbInfoResponse
        return classifyFreshness(parsed.tcbInfo, BASE_TIME)
      } catch {
        return "unavailable"
      }
    })()

    if (expectedState === "unavailable") {
      t.is(observedState, "unavailable")
    } else {
      t.is(observedState, expectedState)
    }

    // Phase 2: strict verifier enforces freshness
    if (observedFmspc) {
      const strict = async () =>
        await verifySgx(buf, {
          date: BASE_TIME,
          crls: [],
          verifyFmspc: async (fmspcHex) => {
            const info = await fetchOrLoadTcbInfo(fmspcHex)
            if (!info || !info.tcbInfo) return false
            return classifyFreshness(info.tcbInfo, BASE_TIME) === "fresh"
          },
        })

      if (observedState === "fresh") {
        t.true(await strict(), `${path.basename(file)} should pass with strict freshness`)
      } else {
        await t.throwsAsync(strict(), {
          message: /TCB validation failed|verifySgx/i,
        })
      }
    }
  }
})

