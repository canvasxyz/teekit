import { Struct } from "typed-struct"

export const TdxQuoteHeader = new Struct("TdxQuoteHeader")
  .UInt16LE("version")
  .UInt16LE("att_key_type")
  .UInt32LE("tee_type")
  .UInt16LE("qe_svn")
  .UInt16LE("pce_svn")
  .Buffer("qe_vendor_id", 16)
  .Buffer("user_data", 20)
  .compile()

export const TdxQuoteBody_1_0 = new Struct("TdxQuoteBodyV1_0")
  .Buffer("tee_tcb_svn", 16)
  .Buffer("mr_seam", 48)
  .Buffer("mr_seam_signer", 48)
  .UInt32LE("seam_svn")
  .UInt32LE("reserved0")
  .Buffer("td_attributes", 8)
  .Buffer("xfam", 8)
  .Buffer("mr_td", 48)
  .Buffer("mr_config_id", 48)
  .Buffer("mr_owner", 48)
  .Buffer("mr_owner_config", 48)
  .Buffer("rtmr0", 48)
  .Buffer("rtmr1", 48)
  .Buffer("rtmr2", 48)
  .Buffer("rtmr3", 48)
  .Buffer("report_data", 64)
  .compile()

export const TdxQuoteBody_1_5 = new Struct("TdxQuoteBodyV1_5")
  .Buffer("tee_tcb_svn", 16)
  .Buffer("mr_seam", 48)
  .Buffer("mr_seam_signer", 48)
  .UInt32LE("seam_svn")
  .UInt32LE("reserved0")
  .Buffer("td_attributes", 8)
  .Buffer("xfam", 8)
  .Buffer("mr_td", 48)
  .Buffer("mr_config_id", 48)
  .Buffer("mr_owner", 48)
  .Buffer("mr_owner_config", 48)
  .Buffer("rtmr0", 48)
  .Buffer("rtmr1", 48)
  .Buffer("rtmr2", 48)
  .Buffer("rtmr3", 48)
  .Buffer("report_data", 64)
  .Buffer("tee_tcb_svn_2", 16) // appended
  .Buffer("mrservictd", 48) // appended
  .compile()

/** Contains a fixed-length ECDSA signature, variable-length QE_auth_data,
 * and a variable-length cert_data tail. */
export function parseTdxSignature(sig_data: Buffer) {
  const EcdsaSigFixed = new Struct("EcdsaSigFixed")
    .Buffer("signature", 64)
    .Buffer("attestation_public_key", 64)
    .Buffer("qe_report", 384)
    .Buffer("qe_report_signature", 64)
    .UInt16LE("qe_auth_data_len")
    .compile()

  const fixed = new EcdsaSigFixed(sig_data)
  let offset = EcdsaSigFixed.baseSize

  const qe_auth_data = sig_data.slice(offset, offset + fixed.qe_auth_data_len)
  offset += fixed.qe_auth_data_len

  const Tail = new Struct("Tail")
    .UInt16LE("cert_data_type")
    .UInt32LE("cert_data_len")
    .compile()
  const tail = new Tail(sig_data.slice(offset, offset + Tail.baseSize))
  offset += Tail.baseSize
  const cert_data = sig_data.slice(offset, offset + tail.cert_data_len)

  return {
    ecdsa_signature: fixed.signature,
    attestation_public_key: fixed.attestation_public_key,
    qe_report_present: fixed.qe_report.length === 384,
    qe_report_signature: fixed.qe_report_signature,
    qe_auth_data_len: fixed.qe_auth_data_len,
    qe_auth_data: qe_auth_data,
    cert_data_type: tail.cert_data_type,
    cert_data_len: tail.cert_data_len,
    cert_data_prefix: cert_data.slice(0, 32),
  }
}

export type TdxSignature = ReturnType<typeof parseTdxSignature>

export const TdxQuoteV4 = new Struct("TdxQuoteV4")
  .Struct("header", TdxQuoteHeader)
  .Struct("body", TdxQuoteBody_1_0)
  .UInt32LE("sig_data_len")
  .Buffer("sig_data")
  .compile()

export const TdxQuoteV5 = new Struct("TdxQuoteV5")
  .Struct("header", TdxQuoteHeader)
  .Struct("body", TdxQuoteBody_1_0)
  .UInt32LE("sig_data_len")
  .Buffer("sig_data")
  .compile()

export function parseTdxQuote(quote_data: Buffer) {
  const header = new TdxQuoteHeader(quote_data)

  const headerSize = (TdxQuoteHeader as any).baseSize as number
  const bodyV10Size = (TdxQuoteBody_1_0 as any).baseSize as number
  const bodyV15Size = (TdxQuoteBody_1_5 as any).baseSize as number

  function tryPickBodyAndSig(bodySize: number) {
    const sigLenOffset = headerSize + bodySize
    if (sigLenOffset + 4 > quote_data.length) return undefined
    const sigLen = quote_data.readUInt32LE(sigLenOffset)
    const sigStart = sigLenOffset + 4
    const sigEnd = sigStart + sigLen
    if (sigEnd > quote_data.length) return undefined
    return { sigLen, sigStart, sigEnd }
  }

  let chosenBodySize = bodyV10Size
  let bodyVariant: "v1_0" | "v1_5" = "v1_0"
  let sigPlacement = tryPickBodyAndSig(bodyV10Size)

  if (header.version === 5) {
    // Prefer 1.5 layout when it matches the total length
    const v15 = tryPickBodyAndSig(bodyV15Size)
    if (v15 && (!sigPlacement || v15.sigEnd === quote_data.length)) {
      bodyVariant = "v1_5"
      chosenBodySize = bodyV15Size
      sigPlacement = v15
    }
  }

  if (!sigPlacement) {
    // Fallback: attempt to parse as V4 layout
    sigPlacement = tryPickBodyAndSig(bodyV10Size)
    chosenBodySize = bodyV10Size
    bodyVariant = header.version === 5 ? "v1_0" : "v1_0"
  }

  const bodySlice = quote_data.slice(
    headerSize,
    headerSize + chosenBodySize,
  )
  const body =
    bodyVariant === "v1_5"
      ? new TdxQuoteBody_1_5(bodySlice)
      : new TdxQuoteBody_1_0(bodySlice)

  const sig_data = quote_data.slice(sigPlacement!.sigStart, sigPlacement!.sigEnd)
  const signature = parseTdxSignature(sig_data)

  return { header, body, signature }
}

export function parseTdxQuoteBase64(quote: string) {
  return parseTdxQuote(Buffer.from(quote, "base64"))
}
