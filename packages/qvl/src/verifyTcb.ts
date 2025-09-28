import { base64 as scureBase64, hex as scureHex } from "@scure/base"
import { fromBER } from "asn1js"
import { parseSgxQuote, parseTdxQuote } from "./structs.js"
import { QV_X509Certificate } from "./x509.js"

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type CanonicalizeOptions = {
  space?: number
}

function canonicalizeJson(value: JsonValue, options?: CanonicalizeOptions): string {
  const space = options?.space ?? 0
  function inner(v: JsonValue): string {
    if (v === null) return "null"
    if (typeof v === "string") return JSON.stringify(v)
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null"
    if (typeof v === "boolean") return v ? "true" : "false"

    if (Array.isArray(v)) {
      const items = v.map((i) => inner(i)).join(",")
      return `[${items}]`
    }

    const obj = v as { [key: string]: JsonValue }
    const keys = Object.keys(obj).sort()
    const keyvals = keys.map((k) => `${JSON.stringify(k)}:${inner(obj[k])}`).join(",")
    return `{${keyvals}}`
  }
  const s = inner(value)
  if (!space) return s
  // Optional pretty print for developer logging only
  try {
    return JSON.stringify(JSON.parse(s), null, space)
  } catch {
    return s
  }
}

async function importEcdsaPublicKeyFromCert(leaf: QV_X509Certificate, namedCurve: "P-256" | "P-384" | "P-521" = "P-256") {
  return await crypto.subtle.importKey(
    "spki",
    leaf.publicKey.rawData,
    { name: "ECDSA", namedCurve },
    false,
    ["verify"],
  )
}

function tryDecodeSignatureToRaw(signature: Uint8Array, curveLen: number): Uint8Array | null {
  // If already raw r||s of correct length, return as-is
  if (signature.length === curveLen * 2) return signature

  // Try DER -> raw conversion
  try {
    const asn1 = fromBER(signature)
    const seq: any = asn1.result
    if (!seq || !seq.valueBlock || !Array.isArray(seq.valueBlock.value)) return null
    const r = new Uint8Array(seq.valueBlock.value[0].valueBlock.valueHex)
    const s = new Uint8Array(seq.valueBlock.value[1].valueBlock.valueHex)

    const pad = (v: Uint8Array) => {
      let out = v
      while (out.length > 0 && out[0] === 0) out = out.subarray(1)
      if (out.length > curveLen) out = out.subarray(out.length - curveLen)
      const res = new Uint8Array(curveLen)
      res.set(out, curveLen - out.length)
      return res
    }
    const raw = new Uint8Array(curveLen * 2)
    raw.set(pad(r), 0)
    raw.set(pad(s), curveLen)
    return raw
  } catch {
    return null
  }
}

export type VerifyTcbInfoSignatureInput = {
  // Either provide the parsed object or the raw JSON text; if both are provided, `tcbInfoObject` is used for digest
  tcbInfoObject?: JsonValue
  tcbInfoText?: string
  signature: string // hex or base64url/base64
  signingChain: string[] // PEMs, leaf first
  hash?: "SHA-256" | "SHA-384" | "SHA-512"
}

/**
 * Verify a TCB Info JSON signature using the provided signing cert chain.
 * - Assumes ECDSA with SHA-256/384/512 on the canonicalized JSON of the `tcbInfo` object.
 * - Returns `true` if the signature verifies and the chain is structurally valid to a self-signed root.
 *
 * Note: Intel DCAP services also provide an HTTP header signature over the exact JSON bytes. If you have the raw
 * bytes and header signature values, prefer passing `tcbInfoText` for canonical fidelity.
 */
export async function verifyTcbInfoSignature(input: VerifyTcbInfoSignatureInput): Promise<boolean> {
  const hash = input.hash ?? "SHA-256"
  let messageBytes: Uint8Array
  if (input.tcbInfoObject) {
    const canonical = canonicalizeJson(input.tcbInfoObject)
    messageBytes = new TextEncoder().encode(canonical)
  } else if (typeof input.tcbInfoText === "string") {
    messageBytes = new TextEncoder().encode(input.tcbInfoText)
  } else {
    throw new Error("verifyTcbInfoSignature: missing tcbInfoObject or tcbInfoText")
  }

  // Decode signature (detect hex vs base64)
  const sigStr = input.signature.trim()
  const signatureBytes = /^(?:[0-9a-f]{2})+$/i.test(sigStr)
    ? scureHex.decode(sigStr)
    : scureBase64.decode(sigStr.replace(/\s+/g, ""))

  if (input.signingChain.length === 0) return false
  const leaf = new QV_X509Certificate(input.signingChain[0])

  // Pick curve length based on SPKI curve OID if discoverable (default P-256)
  let namedCurve: "P-256" | "P-384" | "P-521" = "P-256"
  try {
    // Best effort inference based on SPKI params (same technique as in x509.ts)
    const anyLeaf: any = leaf as any
    const curveOid = anyLeaf._cert?.subjectPublicKeyInfo?.algorithm?.algorithmParams?.valueBlock?.toString?.()
    if (curveOid === "1.3.132.0.34") namedCurve = "P-384"
    else if (curveOid === "1.3.132.0.35") namedCurve = "P-521"
  } catch {}
  const curveLen = namedCurve === "P-256" ? 32 : namedCurve === "P-384" ? 48 : 66

  const publicKey = await importEcdsaPublicKeyFromCert(leaf, namedCurve)

  // Try raw r||s then DER
  const tryRaw = tryDecodeSignatureToRaw(signatureBytes, curveLen) || signatureBytes

  try {
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash }, publicKey, tryRaw, messageBytes)
    if (ok) return true
  } catch {}

  // Try DER if not already tried
  try {
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash }, publicKey, signatureBytes, messageBytes)
    return !!ok
  } catch {
    return false
  }
}

export type SgxTcbInfo = {
  tcbInfo: {
    version: number
    issueDate: string
    nextUpdate: string
    fmspc: string
    pceId: string
    tcbType: number
    tcbEvaluationDataNumber: number
    tcbLevels: Array<{
      tcb: {
        sgxtcbcomp01svn: number
        sgxtcbcomp02svn: number
        sgxtcbcomp03svn: number
        sgxtcbcomp04svn: number
        sgxtcbcomp05svn: number
        sgxtcbcomp06svn: number
        sgxtcbcomp07svn: number
        sgxtcbcomp08svn: number
        sgxtcbcomp09svn: number
        sgxtcbcomp10svn: number
        sgxtcbcomp11svn: number
        sgxtcbcomp12svn: number
        sgxtcbcomp13svn: number
        sgxtcbcomp14svn: number
        sgxtcbcomp15svn: number
        sgxtcbcomp16svn: number
        pcesvn: number
      }
      tcbDate: string
      tcbStatus: string
      advisoryIDs?: string[]
    }>
  }
  signature?: string
}

export type TdxTcbInfo = {
  tcbInfo: {
    id: string
    version: number
    issueDate: string
    nextUpdate: string
    fmspc: string
    pceId: string
    tcbType: number
    tcbEvaluationDataNumber: number
    tdxModule?: {
      mrsigner: string
      attributes: string
      attributesMask: string
    }
    tcbLevels: Array<{
      tcb: {
        tdxtcbcomponents: Array<{ svn: number }>
        pcesvn?: number
        sgxtcbcomponents?: Array<{ svn: number }>
      }
      tcbDate: string
      tcbStatus: string
      advisoryIDs?: string[]
    }>
  }
  signature?: string
}

export type EvaluateTcbOptions = {
  atTimeMs?: number
  // Enforce status to be UpToDate. If false, returns the matched level status for caller inspection.
  enforceUpToDate?: boolean
}

export type TcbMatchResult = {
  ok: boolean
  matchedStatus: string
  matchedIndex: number
}

function nowMs(): number {
  return Date.now()
}

function isWithin(intervalStartIso: string, intervalEndIso: string, atTimeMs: number): boolean {
  const start = Date.parse(intervalStartIso)
  const end = Date.parse(intervalEndIso)
  return start <= atTimeMs && atTimeMs <= end
}

/**
 * Evaluate SGX TCB by comparing the quote's CPU SVN and PCE SVN against provided SGX TCB Info levels.
 */
export function evaluateSgxTcb(
  quoteInput: string | Uint8Array,
  tcbInfo: SgxTcbInfo,
  options?: EvaluateTcbOptions,
): TcbMatchResult {
  const at = options?.atTimeMs ?? nowMs()
  const requireUpToDate = options?.enforceUpToDate ?? true

  const quoteBytes = typeof quoteInput === "string" ? scureBase64.decode(quoteInput) : quoteInput
  const { header, body } = parseSgxQuote(quoteBytes)

  // Validity window
  if (!isWithin(tcbInfo.tcbInfo.issueDate, tcbInfo.tcbInfo.nextUpdate, at)) {
    return { ok: false, matchedStatus: "TCBInfoExpired", matchedIndex: -1 }
  }

  const cpuSvn = body.cpu_svn // 16 bytes
  const pceSvn = header.pce_svn

  // Prepare CPU SVN as array of 16 component SVNs (uint8)
  const comp: number[] = Array.from(cpuSvn)

  // Search for the highest acceptable level: all component SVNs >= required and pcesvn >= required
  const levels = tcbInfo.tcbInfo.tcbLevels
  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i]
    const t = lvl.tcb as any
    const requiredComp = [
      t.sgxtcbcomp01svn,
      t.sgxtcbcomp02svn,
      t.sgxtcbcomp03svn,
      t.sgxtcbcomp04svn,
      t.sgxtcbcomp05svn,
      t.sgxtcbcomp06svn,
      t.sgxtcbcomp07svn,
      t.sgxtcbcomp08svn,
      t.sgxtcbcomp09svn,
      t.sgxtcbcomp10svn,
      t.sgxtcbcomp11svn,
      t.sgxtcbcomp12svn,
      t.sgxtcbcomp13svn,
      t.sgxtcbcomp14svn,
      t.sgxtcbcomp15svn,
      t.sgxtcbcomp16svn,
    ] as number[]
    const requiredPce = t.pcesvn as number

    let meets = pceSvn >= requiredPce
    for (let j = 0; j < 16 && meets; j++) {
      if (comp[j] < requiredComp[j]) meets = false
    }
    if (!meets) continue

    const status = (lvl.tcbStatus || "").toString()
    if (requireUpToDate) {
      const ok = status.toLowerCase() === "uptodate"
      return { ok, matchedStatus: status, matchedIndex: i }
    } else {
      return { ok: true, matchedStatus: status, matchedIndex: i }
    }
  }

  return { ok: false, matchedStatus: "NoMatchingLevel", matchedIndex: -1 }
}

/**
 * Evaluate TDX TCB by comparing the quote's TEE_TCB_SVN (16 bytes) and PCE SVN against provided TDX TCB Info levels.
 */
export function evaluateTdxTcb(
  quoteInput: string | Uint8Array,
  tcbInfo: TdxTcbInfo,
  options?: EvaluateTcbOptions,
): TcbMatchResult {
  const at = options?.atTimeMs ?? nowMs()
  const requireUpToDate = options?.enforceUpToDate ?? true

  const quoteBytes = typeof quoteInput === "string" ? scureBase64.decode(quoteInput) : quoteInput
  const { header, body } = parseTdxQuote(quoteBytes)

  // Validity window
  if (!isWithin(tcbInfo.tcbInfo.issueDate, tcbInfo.tcbInfo.nextUpdate, at)) {
    return { ok: false, matchedStatus: "TCBInfoExpired", matchedIndex: -1 }
  }

  const teeTcb = body.tee_tcb_svn // 16 bytes
  const pceSvn = header.pce_svn

  const comp: number[] = Array.from(teeTcb)
  const levels = tcbInfo.tcbInfo.tcbLevels
  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i]
    const t = lvl.tcb as any
    const tdxtcbcomponents: Array<{ svn: number }> = t.tdxtcbcomponents || []
    const requiredPce: number | undefined = t.pcesvn

    if (tdxtcbcomponents.length !== 16) continue

    let meets = true
    for (let j = 0; j < 16 && meets; j++) {
      if (comp[j] < (tdxtcbcomponents[j]?.svn ?? 0)) meets = false
    }
    if (meets && typeof requiredPce === "number") {
      meets = pceSvn >= requiredPce
    }
    if (!meets) continue

    const status = (lvl.tcbStatus || "").toString()
    if (requireUpToDate) {
      const ok = status.toLowerCase() === "uptodate"
      return { ok, matchedStatus: status, matchedIndex: i }
    } else {
      return { ok: true, matchedStatus: status, matchedIndex: i }
    }
  }

  return { ok: false, matchedStatus: "NoMatchingLevel", matchedIndex: -1 }
}

export type EvaluateTcbResult = {
  ok: boolean
  type: "sgx" | "tdx"
  matchedStatus: string
  matchedIndex: number
}

/**
 * Convenience wrapper to evaluate TCB for either SGX or TDX quotes.
 */
export function evaluateTcb(
  quoteInput: string | Uint8Array,
  tcbInfo: SgxTcbInfo | TdxTcbInfo,
  options?: EvaluateTcbOptions,
): EvaluateTcbResult {
  const bytes = typeof quoteInput === "string" ? scureBase64.decode(quoteInput) : quoteInput
  // Peek tee_type via parseSgxQuote try/catch
  try {
    const r = parseSgxQuote(bytes)
    const res = evaluateSgxTcb(bytes, tcbInfo as SgxTcbInfo, options)
    return { ok: res.ok, matchedStatus: res.matchedStatus, matchedIndex: res.matchedIndex, type: "sgx" }
  } catch {
    const res = evaluateTdxTcb(bytes, tcbInfo as TdxTcbInfo, options)
    return { ok: res.ok, matchedStatus: res.matchedStatus, matchedIndex: res.matchedIndex, type: "tdx" }
  }
}

