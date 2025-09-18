import { ExtractType, Struct } from "typed-struct"

export const QuoteHeader = new Struct("QuoteHeader")
  .UInt16LE("version")
  .UInt16LE("att_key_type")
  .UInt32LE("tee_type")
  .UInt16LE("qe_svn")
  .UInt16LE("pce_svn")
  .Buffer("qe_vendor_id", 16)
  .Buffer("user_data", 20)
  .compile()

export const SgxReportBody = new Struct("SgxReportBody")
  .Buffer("cpu_svn", 16)
  .UInt32LE("misc_select")
  .Buffer("reserved1", 28)
  .Buffer("attributes", 16)
  .Buffer("mr_enclave", 32)
  .Buffer("reserved2", 32)
  .Buffer("mr_signer", 32)
  .Buffer("reserved3", 96)
  .UInt16LE("isv_prod_id")
  .UInt16LE("isv_svn")
  .Buffer("reserved4", 60)
  .Buffer("report_data", 64)
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

export const SgxQuote = new Struct("SgxQuote")
  .Struct("header", QuoteHeader)
  .Struct("body", SgxReportBody)
  .UInt32LE("sig_data_len")
  .Buffer("sig_data")
  .compile()

export const SgxTail = new Struct("SgxTail")
  .UInt16LE("cert_data_type")
  .UInt32LE("cert_data_len")
  .compile()

export const TdxQuoteV4 = new Struct("TdxQuoteV4")
  .Struct("header", QuoteHeader)
  .Struct("body", TdxQuoteBody_1_0)
  .UInt32LE("sig_data_len")
  .Buffer("sig_data")
  .compile()

export const TdxQuoteV5Descriptor = new Struct("TdxQuoteV5BodyDescriptor")
  .Struct("header", QuoteHeader)
  .UInt16LE("body_type")
  .UInt32LE("body_size")
  .Buffer("extra")
  .compile()

export const TdxQuoteV5SigDescriptor = new Struct("TdxQuoteV5SigDescriptor")
  .UInt32LE("sig_data_len")
  .Buffer("sig_data")
  .compile()

/**
 * SGX signatures contain a fixed-length ECDSA signature section, and
 * a variable-length cert_data tail.
 */
export function parseSgxSignature(quote: Buffer) {
  const { sig_data } = new SgxQuote(quote)

  const EcdsaSignatureFixed = new Struct("EcdsaSignatureFixed")
    .Buffer("signature", 64)
    .Buffer("attestation_public_key", 64)
    .Buffer("qe_report", 384)
    .Buffer("qe_report_signature", 64)
    .UInt16LE("qe_auth_data_len")
    .Buffer("extra")
    .compile()
  const fixed = new EcdsaSignatureFixed(sig_data)

  const tail = fixed.extra.subarray(fixed.qe_auth_data_len)
  const { cert_data_type, cert_data_len } = new SgxTail(tail)

  // Read cert_data with exact length, similar to TDX parsing
  const CertData = new Struct("CertData")
    .Buffer("cert_data", cert_data_len)
    .compile()
  const { cert_data } = new CertData(tail.subarray(SgxTail.baseSize))

  return {
    ecdsa_signature: fixed.signature,
    attestation_public_key: fixed.attestation_public_key,
    qe_report: fixed.qe_report,
    qe_report_present: !!fixed.qe_report,
    qe_report_signature: fixed.qe_report_signature,
    qe_auth_data_len: fixed.qe_auth_data_len,
    qe_auth_data: fixed.extra.subarray(0, fixed.qe_auth_data_len),
    cert_data_type,
    cert_data_len,
    cert_data,
  }
}

/**
 * The signature section starts at a fixed offset for V4 quotes, and
 * variable offset for V5 quotes. It contains a fixed-length ECDSA signature,
 * variable-length QE auth_data, and variable-length cert_data tail.
 */
export function parseTdxSignature(quote: Buffer, v5?: boolean) {
  let sig_data
  if (!v5) {
    sig_data = new TdxQuoteV4(quote).sig_data
  } else {
    const { body_size, extra } = new TdxQuoteV5Descriptor(quote)
    sig_data = new TdxQuoteV5SigDescriptor(extra.subarray(body_size)).sig_data
  }

  const EcdsaSigFixed = new Struct("EcdsaSigFixed")
    .Buffer("signature", 64)
    .Buffer("attestation_public_key", 64)
    .UInt16LE("cert_type")
    .UInt32LE("cert_size")
    .Buffer("qe_report", 384)
    .Buffer("qe_report_signature", 64)
    .UInt16LE("qe_auth_data_len")
    .compile()

  const fixed = new EcdsaSigFixed(sig_data)
  let offset = EcdsaSigFixed.baseSize

  const qe_auth_data = sig_data.subarray(
    offset,
    offset + fixed.qe_auth_data_len,
  )
  offset += fixed.qe_auth_data_len

  const Tail = new Struct("Tail")
    .UInt16LE("cert_data_type")
    .UInt32LE("cert_data_len")
    .compile()

  const { cert_data_type, cert_data_len } = new Tail(
    sig_data.subarray(offset, offset + Tail.baseSize),
  )
  offset += Tail.baseSize

  const CertData = new Struct("CertData")
    .Buffer("cert_data", cert_data_len)
    .compile()
  const { cert_data } = new CertData(sig_data.subarray(offset))

  return {
    ecdsa_signature: fixed.signature,
    attestation_public_key: fixed.attestation_public_key,
    qe_report: fixed.qe_report,
    qe_report_present: fixed.qe_report.length === 384,
    qe_report_signature: fixed.qe_report_signature,
    qe_auth_data_len: fixed.qe_auth_data_len,
    qe_auth_data,
    cert_data_type,
    cert_data_len,
    cert_data,
  }
}

export type SgxSignature = ReturnType<typeof parseSgxSignature>
export type TdxSignature = ReturnType<typeof parseTdxSignature>

/**
 * Compute the signed region of an SGX quote: header || body (excludes sig length and sig_data)
 */
export function getSgxSignedRegion(quoteBytes: Buffer): Buffer {
  return quoteBytes.subarray(0, QuoteHeader.baseSize + SgxReportBody.baseSize)
}

/**
 * Compute the signed region of a TDX 1.0 quote: header || body (excludes sig length and sig_data)
 */
export function getTdx10SignedRegion(quoteBytes: Buffer): Buffer {
  const headerLen = QuoteHeader.baseSize as number
  const bodyLen = TdxQuoteBody_1_0.baseSize as number
  return quoteBytes.subarray(0, headerLen + bodyLen)
}

/**
 * Compute the signed region of a TDX 1.5 quote: header || body_descriptor || body
 */
export function getTdx15SignedRegion(quoteBytes: Buffer): Buffer {
  const { body_size } = new TdxQuoteV5Descriptor(quoteBytes)
  const headerLen = QuoteHeader.baseSize as number
  const totalLen = headerLen + 2 + 4 + body_size
  return quoteBytes.subarray(0, totalLen)
}

/**
 * Parse a TDX 1.0 or 1.5 quote as header, body, and signature.
 */
export function parseTdxQuote(quote: Buffer): {
  header: ExtractType<typeof QuoteHeader>
  body: ExtractType<typeof TdxQuoteBody_1_0 | typeof TdxQuoteBody_1_5>
  signature: TdxSignature
} {
  const header = new QuoteHeader(quote)
  if (header.version === 4) {
    const { body } = new TdxQuoteV4(quote)
    const signature = parseTdxSignature(quote)

    return { header, body, signature }
  } else if (header.version === 5) {
    const { body_type, body_size, extra } = new TdxQuoteV5Descriptor(quote)

    let body
    if (body_type === 1) {
      throw new Error("parseQuote: unexpected body_type = 1")
    } else if (body_type === 2) {
      body = new TdxQuoteBody_1_0(extra.subarray(0, body_size))
    } else if (body_type === 3) {
      body = new TdxQuoteBody_1_5(extra.subarray(0, body_size))
    } else {
      throw new Error("parseQuote: unexpected body_type")
    }

    const signature = parseTdxSignature(quote, true)
    return { header, body, signature }
  } else {
    throw new Error(
      "parseQuote: Unsupported quote version, only v4 and v5 supported",
    )
  }
}

export function parseTdxQuoteBase64(quote: string) {
  return parseTdxQuote(Buffer.from(quote, "base64"))
}

/**
 * Parse a TDX 1.0 or 1.5 quote as header, body, and signature.
 */
export function parseSgxQuote(quote: Buffer): {
  header: ExtractType<typeof QuoteHeader>
  body: ExtractType<typeof SgxReportBody>
  signature: SgxSignature
} {
  const header = new QuoteHeader(quote)
  if (header.version !== 3) {
    throw new Error("parseQuote: Unsupported SGX quote version")
  }

  const { body } = new SgxQuote(quote)
  const signature = parseSgxSignature(quote)

  return { header, body, signature }
}

export function parseSgxQuoteBase64(quote: string) {
  return parseSgxQuote(Buffer.from(quote, "base64"))
}
