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
    .Buffer("cert_data")
    .compile()

  let tail
  try {
    const headerView = new Tail(sig_data.slice(offset, offset + Tail.baseSize))
    const certDataTotalLen = (Tail.baseSize as number) + headerView.cert_data_len
    tail = new Tail(sig_data.slice(offset, offset + certDataTotalLen))
  } catch {}

  // Fallback: some providers (e.g., Azure vTPM) embed PEMs in qe_auth_data
  // If Tail is absent but qe_auth_data contains PEM, surface it via cert_data
  let fallbackCertData: Buffer | null = null
  if (!tail && fixed.qe_auth_data_len > 0) {
    const txt = qe_auth_data.toString("utf8")
    if (txt.includes("-----BEGIN CERTIFICATE-----") && txt.includes("-----END CERTIFICATE-----")) {
      fallbackCertData = qe_auth_data
    }
  }

  return {
    ecdsa_signature: fixed.signature,
    attestation_public_key: fixed.attestation_public_key,
    qe_report: fixed.qe_report,
    qe_report_present: fixed.qe_report.length === 384,
    qe_report_signature: fixed.qe_report_signature,
    qe_auth_data_len: fixed.qe_auth_data_len,
    qe_auth_data: qe_auth_data,
    cert_data_type: tail ? tail.cert_data_type : null,
    cert_data_len: tail ? tail.cert_data_len : fallbackCertData ? fixed.qe_auth_data_len : null,
    cert_data_prefix: tail
      ? tail.cert_data.slice(0, 32)
      : fallbackCertData
        ? fallbackCertData.slice(0, 32)
        : null,
    cert_data: tail ? tail.cert_data : fallbackCertData,
  }
}

export type TdxSignature = ReturnType<typeof parseTdxSignature>

/**
 * Compute the signed region of a TDX v4 quote: header + body (excludes sig length and sig_data)
 */
export function getTdxV4SignedRegion(quoteBytes: Buffer): Buffer {
  const headerLen = TdxQuoteHeader.baseSize as number
  const bodyLen = TdxQuoteBody_1_0.baseSize as number
  return quoteBytes.subarray(0, headerLen + bodyLen)
}

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
  const { body, sig_data } = new TdxQuoteV4(quote_data) // header.version === 4 ? new TdxQuoteV4(quote) : new TdxQuoteV5(quote)
  const signature = parseTdxSignature(sig_data)

  return { header, body, signature }
}

export function parseTdxQuoteBase64(quote: string) {
  return parseTdxQuote(Buffer.from(quote, "base64"))
}
