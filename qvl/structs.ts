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

// Note: V5 body can be TDX 1.0 (same layout as V4) or TDX 1.5 (extra 64 bytes)
export const TdxQuoteV5_TDX10 = new Struct("TdxQuoteV5_TDX10")
  .Struct("header", TdxQuoteHeader)
  .Struct("body", TdxQuoteBody_1_0)
  .UInt32LE("sig_data_len")
  .Buffer("sig_data")
  .compile()

export const TdxQuoteV5_TDX15 = new Struct("TdxQuoteV5_TDX15")
  .Struct("header", TdxQuoteHeader)
  .Struct("body", TdxQuoteBody_1_5)
  .UInt32LE("sig_data_len")
  .Buffer("sig_data")
  .compile()

export function parseTdxQuote(quote_data: Buffer) {
  const header = new TdxQuoteHeader(quote_data)
  if (header.version === 4) {
    const { body, sig_data } = new TdxQuoteV4(quote_data)
    const signature = parseTdxSignature(sig_data)
    return { header, body, signature }
  }

  // v5: detect body variant using sig_data_len position sanity
  const off10 = TdxQuoteHeader.baseSize + TdxQuoteBody_1_0.baseSize
  const off15 = TdxQuoteHeader.baseSize + TdxQuoteBody_1_5.baseSize
  const readU32 = (off: number) =>
    off + 4 <= quote_data.length ? quote_data.readUInt32LE(off) : 0
  const v10Len = readU32(off10)
  const v15Len = readU32(off15)
  const rem10 = Math.max(0, quote_data.length - (off10 + 4))
  const rem15 = Math.max(0, quote_data.length - (off15 + 4))
  const v10Valid = v10Len > 0 && v10Len <= rem10
  const v15Valid = v15Len > 0 && v15Len <= rem15

  if (v15Valid && !v10Valid) {
    const { body, sig_data } = new TdxQuoteV5_TDX15(quote_data)
    const signature = parseTdxSignature(sig_data)
    return { header, body, signature }
  }
  if (v10Valid && !v15Valid) {
    const { body, sig_data } = new TdxQuoteV5_TDX10(quote_data)
    const signature = parseTdxSignature(sig_data)
    return { header, body, signature }
  }
  if (v15Valid && v10Valid) {
    // pick the closer match to remainder
    const d10 = Math.abs(rem10 - v10Len)
    const d15 = Math.abs(rem15 - v15Len)
    if (d15 <= d10) {
      const { body, sig_data } = new TdxQuoteV5_TDX15(quote_data)
      const signature = parseTdxSignature(sig_data)
      return { header, body, signature }
    } else {
      const { body, sig_data } = new TdxQuoteV5_TDX10(quote_data)
      const signature = parseTdxSignature(sig_data)
      return { header, body, signature }
    }
  }

  // Fallback: prefer 1.5 for v5
  const { body, sig_data } = new TdxQuoteV5_TDX15(quote_data)
  const signature = parseTdxSignature(sig_data)
  return { header, body, signature }
}

export function parseTdxQuoteBase64(quote: string) {
  return parseTdxQuote(Buffer.from(quote, "base64"))
}
