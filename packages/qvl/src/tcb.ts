import { IntelTcbInfo } from "./structs.js"
import { isTdxQuote, VerifyConfig } from "./verifyTdx.js"

export type TcbRef = { status?: string; tcbInfoFresh?: boolean; fmspc?: string }

export function getTcbStatus(
  tcbInfo: IntelTcbInfo,
  cpuSvn: number[],
  pceSvn: number,
  isTdx: boolean,
): string {
  let statusFound = "OutOfDate"

  for (const level of tcbInfo.tcbInfo.tcbLevels) {
    const pceOk =
      typeof level.tcb.pcesvn === "number" ? pceSvn >= level.tcb.pcesvn : true

    let cpuOk = true

    if (!isTdx) {
      // SGX v2-style keys: sgxtcbcompNNsvn
      for (let comp = 1; comp <= 16; comp++) {
        const key = `sgxtcbcomp${String(comp).padStart(2, "0")}svn`
        if (Object.prototype.hasOwnProperty.call(level.tcb, key)) {
          if (cpuSvn[comp - 1] < level.tcb[key]) {
            cpuOk = false
            break
          }
        }
      }

      // SGX v3-style array: sgxtcbcomponents
      if (cpuOk && Array.isArray(level.tcb.sgxtcbcomponents)) {
        const arr = level.tcb.sgxtcbcomponents as Array<{
          svn?: number
        }>
        for (let i = 0; i < arr.length; i++) {
          const req = arr[i]
          if (req && typeof req.svn === "number") {
            if ((cpuSvn[i] ?? 0) < req.svn) {
              cpuOk = false
              break
            }
          }
        }
      }
    } else {
      // TDX components array: tdxtcbcomponents (compare against tee_tcb_svn)
      if (cpuOk && Array.isArray(level.tcb.tdxtcbcomponents)) {
        const arr = level.tcb.tdxtcbcomponents
        for (let i = 0; i < arr.length; i++) {
          const req = arr[i]
          if (req && typeof req.svn === "number") {
            if ((cpuSvn[i] ?? 0) < req.svn) {
              cpuOk = false
              break
            }
          }
        }
      }
    }

    if (cpuOk && pceOk) {
      statusFound = level.tcbStatus
      break
    }
  }

  return statusFound
}

export function isTcbInfoFresh(
  tcbInfo: IntelTcbInfo,
  currentTime: number,
): boolean {
  return (
    Date.parse(tcbInfo.tcbInfo.issueDate) <= currentTime &&
    currentTime <= Date.parse(tcbInfo.tcbInfo.nextUpdate)
  )
}

export async function verifyTcb({
  fmspc,
  cpuSvn,
  pceSvn,
  quote,
}: Parameters<VerifyConfig["verifyTcb"]>[0]) {
  const isTdx = isTdxQuote(quote)
  const tdxsgx = isTdx ? "tdx" : "sgx"

  // Fetch TCB info from Intel API. Cannot be used in the browser without a CORS proxy
  const url = `https://api.trustedservices.intel.com/${tdxsgx}/certification/v4/tcb?fmspc=${fmspc}`
  const resp = await fetch(url, { headers: { Accept: "application/json" } })
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch TCB info for FMSPC=${fmspc}: ${resp.status} ${resp.statusText}`,
    )
  }

  // Determine the TCB status and check freshness
  const tcbInfo = await resp.json()
  const statusFound = getTcbStatus(tcbInfo, cpuSvn, pceSvn, isTdx)
  const tcbInfoFresh = isTcbInfoFresh(tcbInfo, +new Date())

  return (
    tcbInfoFresh &&
    (statusFound === "UpToDate" || statusFound === "ConfigurationNeeded")
  )
}
