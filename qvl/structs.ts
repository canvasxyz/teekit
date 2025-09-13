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

  const maxAuthLen = Math.max(0, Math.min(fixed.qe_auth_data_len, Math.max(0, sig_data.length - offset)))
  const qe_auth_data = sig_data.slice(offset, offset + maxAuthLen)
  offset += maxAuthLen

  const Tail = new Struct("Tail")
    .UInt16LE("cert_data_type")
    .UInt32LE("cert_data_len")
    .compile()
  let cert_data_type = 0
  let cert_data_len = 0
  let cert_data = Buffer.alloc(0)
  if (sig_data.length >= offset + Tail.baseSize) {
    const tail = new Tail(sig_data.slice(offset, offset + Tail.baseSize))
    cert_data_type = tail.cert_data_type
    cert_data_len = tail.cert_data_len
    offset += Tail.baseSize
    const maxCertLen = Math.max(0, Math.min(cert_data_len, Math.max(0, sig_data.length - offset)))
    cert_data = sig_data.slice(offset, offset + maxCertLen)
  }

  return {
    ecdsa_signature: fixed.signature,
    attestation_public_key: fixed.attestation_public_key,
    qe_report_present: fixed.qe_report.length === 384,
    qe_report_signature: fixed.qe_report_signature,
    qe_auth_data_len: fixed.qe_auth_data_len,
    qe_auth_data: qe_auth_data,
    cert_data_type: cert_data_type,
    cert_data_len: cert_data_len,
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

  // Heuristic to distinguish v5 body 1.0 vs 1.5 by checking whether the
  // sig_data_len located after a 1.5-sized body points to the end of buffer
  const HEADER_SIZE = 48
  const BODY_V1_5_SIZE = 648

  let body: any
  let sig_data: Buffer

  if (header.version === 4) {
    const parsed = new TdxQuoteV4(quote_data)
    body = parsed.body
    sig_data = parsed.sig_data
  } else if (header.version === 5) {
    const sigOffsetIfV15 = HEADER_SIZE + BODY_V1_5_SIZE
    let isV15 = false
    if (quote_data.length >= sigOffsetIfV15 + 4) {
      const sigLen = quote_data.readUInt32LE(sigOffsetIfV15)
      isV15 = sigOffsetIfV15 + 4 + sigLen === quote_data.length
    }

    if (isV15) {
      // Manually parse to avoid misaligned struct definitions
      const bodyBuf = quote_data.slice(HEADER_SIZE, HEADER_SIZE + BODY_V1_5_SIZE)
      body = new TdxQuoteBody_1_5(bodyBuf)
      const sigLen = quote_data.readUInt32LE(sigOffsetIfV15)
      sig_data = quote_data.slice(sigOffsetIfV15 + 4, sigOffsetIfV15 + 4 + sigLen)
    } else {
      const parsed = new TdxQuoteV5(quote_data)
      body = parsed.body
      sig_data = parsed.sig_data
    }
  } else {
    // Fallback: try v4 layout for unknown versions
    const parsed = new TdxQuoteV4(quote_data)
    body = parsed.body
    sig_data = parsed.sig_data
  }

  const signature = parseTdxSignature(sig_data)

  return { header, body, signature }
}

export function parseTdxQuoteBase64(quote: string) {
  return parseTdxQuote(Buffer.from(quote, "base64"))
}
