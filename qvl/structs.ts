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

// V5 with TDX 1.5 body layout (additional 64 bytes appended to report body)
export const TdxQuoteV5_1_5 = new Struct("TdxQuoteV5_1_5")
  .Struct("header", TdxQuoteHeader)
  .Struct("body", TdxQuoteBody_1_5)
  .UInt32LE("sig_data_len")
  .Buffer("sig_data")
  .compile()

export function parseTdxQuote(quote_data: Buffer) {
  const header = new TdxQuoteHeader(quote_data)

  if (header.version === 4) {
    const parsed = new TdxQuoteV4(quote_data)
    const signature = parseTdxSignature(parsed.sig_data)
    return { header, body: parsed.body, signature }
  }

  if (header.version === 5) {
    // Default to TDX 1.0 body layout for v5; fields are a prefix for 1.5
    try {
      const parsed = new TdxQuoteV5(quote_data)
      const signature = parseTdxSignature(parsed.sig_data)
      return { header, body: parsed.body, signature }
    } catch (_e) {
      const parsed15 = new TdxQuoteV5_1_5(quote_data)
      const signature = parseTdxSignature(parsed15.sig_data)
      return { header, body: parsed15.body, signature }
    }
  }

  throw new Error(`Unsupported or unknown TDX quote version: ${header.version}`)
}

export function parseTdxQuoteBase64(quote: string) {
  return parseTdxQuote(Buffer.from(quote, "base64"))
}
