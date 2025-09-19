import { parseTdxQuote } from "./structs.js"
import { base64 as scureBase64, hex as scureHex } from "@scure/base"

type QeIdentity = {
  enclaveIdentity: {
    id: string
    version: number
    issueDate: string
    nextUpdate: string
    tcbEvaluationDataNumber: number
    miscselect?: string
    miscselectMask?: string
    attributes: string
    attributesMask: string
    mrsigner: string
    isvprodid?: number
    tcbLevels: Array<{
      tcb: { isvsvn: number }
      tcbDate: string
      tcbStatus: string
      advisoryIDs?: string[]
    }>
  }
  signature?: string
}

/** Minimal view of SGX Report fields inside QE report */
function parseSgxReport(report: Uint8Array) {
  if (report.length !== 384) {
    throw new Error("Unexpected SGX report length")
  }
  const attributes = report.subarray(48, 64)
  const mrEnclave = report.subarray(64, 96)
  const mrSigner = report.subarray(128, 160)
  const view = new DataView(report.buffer, report.byteOffset, report.byteLength)
  const isvProdId = view.getUint16(256, true)
  const isvSvn = view.getUint16(258, true)
  const reportData = report.subarray(320, 384)
  return { attributes, mrEnclave, mrSigner, isvProdId, isvSvn, reportData }
}

function hexEqualsMasked(
  actual: Uint8Array,
  expectedHex: string,
  maskHex: string,
) {
  const exp = scureHex.decode(expectedHex)
  const mask = scureHex.decode(maskHex)
  if (exp.length !== actual.length || mask.length !== actual.length)
    return false
  for (let i = 0; i < actual.length; i++) {
    if ((actual[i] & mask[i]) !== (exp[i] & mask[i])) return false
  }
  return true
}

/** Verify QE Identity against the QE report embedded in the quote. */
export function verifyQeIdentity(
  quoteInput: string | Uint8Array,
  qeIdentity: QeIdentity,
  atTimeMs?: number,
): boolean {
  const now = atTimeMs ?? Date.now()
  const quoteBytes =
    typeof quoteInput === "string" ? scureBase64.decode(quoteInput) : quoteInput

  const { signature } = parseTdxQuote(quoteBytes)
  if (!signature.qe_report_present) return false
  const report = parseSgxReport(signature.qe_report)

  const id = qeIdentity.enclaveIdentity
  const notBefore = Date.parse(id.issueDate)
  const notAfter = Date.parse(id.nextUpdate)
  if (!(notBefore <= now && now <= notAfter)) return false

  // Attributes with mask
  if (!hexEqualsMasked(report.attributes, id.attributes, id.attributesMask)) {
    return false
  }

  // MRSIGNER must match exactly
  if (
    scureHex.encode(report.mrSigner).toLowerCase() !== id.mrsigner.toLowerCase()
  ) {
    return false
  }

  // Optional ISVPRODID
  if (typeof id.isvprodid === "number" && id.isvprodid !== report.isvProdId) {
    return false
  }

  // Pick an UpToDate level if available; otherwise accept any level
  const level =
    id.tcbLevels.find((l) => l.tcbStatus.toLowerCase() === "uptodate") ||
    id.tcbLevels[0]
  if (!level) return false
  if (level.tcb.isvsvn !== report.isvSvn) return false

  return true
}
