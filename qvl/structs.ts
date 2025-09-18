import { Parser } from "binary-parser"

export const QuoteHeader = new Parser()
  .uint16le("version")
  .uint16le("att_key_type")
  .uint32le("tee_type")
  .uint16le("qe_svn")
  .uint16le("pce_svn")
  .buffer("qe_vendor_id", { length: 16 })
  .buffer("user_data", { length: 20 })

export const SgxReportBody = new Parser()
  .buffer("cpu_svn", { length: 16 })
  .uint32le("misc_select")
  .buffer("reserved1", { length: 28 })
  .buffer("attributes", { length: 16 })
  .buffer("mr_enclave", { length: 32 })
  .buffer("reserved2", { length: 32 })
  .buffer("mr_signer", { length: 32 })
  .buffer("reserved3", { length: 96 })
  .uint16le("isv_prod_id")
  .uint16le("isv_svn")
  .buffer("reserved4", { length: 60 })
  .buffer("report_data", { length: 64 })

export const TdxQuoteBody_1_0 = new Parser()
  .buffer("tee_tcb_svn", { length: 16 })
  .buffer("mr_seam", { length: 48 })
  .buffer("mr_seam_signer", { length: 48 })
  .uint32le("seam_svn")
  .uint32le("reserved0")
  .buffer("td_attributes", { length: 8 })
  .buffer("xfam", { length: 8 })
  .buffer("mr_td", { length: 48 })
  .buffer("mr_config_id", { length: 48 })
  .buffer("mr_owner", { length: 48 })
  .buffer("mr_owner_config", { length: 48 })
  .buffer("rtmr0", { length: 48 })
  .buffer("rtmr1", { length: 48 })
  .buffer("rtmr2", { length: 48 })
  .buffer("rtmr3", { length: 48 })
  .buffer("report_data", { length: 64 })

export const TdxQuoteBody_1_5 = new Parser()
  .buffer("tee_tcb_svn", { length: 16 })
  .buffer("mr_seam", { length: 48 })
  .buffer("mr_seam_signer", { length: 48 })
  .uint32le("seam_svn")
  .uint32le("reserved0")
  .buffer("td_attributes", { length: 8 })
  .buffer("xfam", { length: 8 })
  .buffer("mr_td", { length: 48 })
  .buffer("mr_config_id", { length: 48 })
  .buffer("mr_owner", { length: 48 })
  .buffer("mr_owner_config", { length: 48 })
  .buffer("rtmr0", { length: 48 })
  .buffer("rtmr1", { length: 48 })
  .buffer("rtmr2", { length: 48 })
  .buffer("rtmr3", { length: 48 })
  .buffer("report_data", { length: 64 })
  .buffer("tee_tcb_svn_2", { length: 16 }) // appended
  .buffer("mrservictd", { length: 48 }) // appended

export const SgxQuote = new Parser()
  .nest("header", { type: QuoteHeader })
  .nest("body", { type: SgxReportBody })
  .uint32le("sig_data_len")
  .buffer("sig_data", { length: function() { return this.sig_data_len } })

export const SgxTail = new Parser()
  .uint16le("cert_data_type")
  .uint32le("cert_data_len")
  .buffer("cert_data", { length: function() { return this.cert_data_len } })

export const TdxQuoteV4 = new Parser()
  .nest("header", { type: QuoteHeader })
  .nest("body", { type: TdxQuoteBody_1_0 })
  .uint32le("sig_data_len")
  .buffer("sig_data", { length: function() { return this.sig_data_len } })

export const TdxQuoteV5Descriptor = new Parser()
  .nest("header", { type: QuoteHeader })
  .uint16le("body_type")
  .uint32le("body_size")
  .buffer("extra", { readUntil: "eof" })

export const TdxQuoteV5SigDescriptor = new Parser()
  .uint32le("sig_data_len")
  .buffer("sig_data", { length: function() { return this.sig_data_len } })

/**
 * SGX signatures contain a fixed-length ECDSA signature section, and
 * a variable-length cert_data tail.
 */
export function parseSgxSignature(quote: Buffer) {
  const { sig_data } = SgxQuote.parse(quote)

  const EcdsaSignatureFixed = new Parser()
    .buffer("signature", { length: 64 })
    .buffer("attestation_public_key", { length: 64 })
    .buffer("qe_report", { length: 384 })
    .buffer("qe_report_signature", { length: 64 })
    .uint16le("qe_auth_data_len")
  const fixed = EcdsaSignatureFixed.parse(sig_data)

  const qe_auth_data = sig_data.subarray(64 + 64 + 384 + 64 + 2, 64 + 64 + 384 + 64 + 2 + fixed.qe_auth_data_len)
  const tail = sig_data.subarray(64 + 64 + 384 + 64 + 2 + fixed.qe_auth_data_len)
  const { cert_data_type, cert_data_len, cert_data } = SgxTail.parse(tail)

  return {
    ecdsa_signature: fixed.signature,
    attestation_public_key: fixed.attestation_public_key,
    qe_report: fixed.qe_report,
    qe_report_present: !!fixed.qe_report,
    qe_report_signature: fixed.qe_report_signature,
    qe_auth_data_len: fixed.qe_auth_data_len,
    qe_auth_data,
    cert_data_type,
    cert_data_len,
    cert_data: cert_data.subarray(0, cert_data_len),
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
    sig_data = TdxQuoteV4.parse(quote).sig_data
  } else {
    const { body_size, extra } = TdxQuoteV5Descriptor.parse(quote)
    sig_data = TdxQuoteV5SigDescriptor.parse(extra.subarray(body_size)).sig_data
  }

  const EcdsaSigFixed = new Parser()
    .buffer("signature", { length: 64 })
    .buffer("attestation_public_key", { length: 64 })
    .uint16le("cert_type")
    .uint32le("cert_size")
    .buffer("qe_report", { length: 384 })
    .buffer("qe_report_signature", { length: 64 })
    .uint16le("qe_auth_data_len")

  const fixed = EcdsaSigFixed.parse(sig_data)
  let offset = 64 + 64 + 2 + 4 + 384 + 64 + 2 // Calculate fixed size manually

  const qe_auth_data = sig_data.subarray(
    offset,
    offset + fixed.qe_auth_data_len,
  )
  offset += fixed.qe_auth_data_len

  const Tail = new Parser()
    .uint16le("cert_data_type")
    .uint32le("cert_data_len")

  const { cert_data_type, cert_data_len } = Tail.parse(
    sig_data.subarray(offset, offset + 6), // 2 + 4 = 6 bytes
  )
  offset += 6

  const CertData = new Parser()
    .buffer("cert_data", { length: cert_data_len })
  const { cert_data } = CertData.parse(sig_data.subarray(offset))

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
  // QuoteHeader: 2+2+4+2+2+16+20 = 48 bytes
  // SgxReportBody: 16+4+28+16+32+32+32+96+2+2+60+64 = 384 bytes
  return quoteBytes.subarray(0, 48 + 384)
}

/**
 * Compute the signed region of a TDX 1.0 quote: header || body (excludes sig length and sig_data)
 */
export function getTdx10SignedRegion(quoteBytes: Buffer): Buffer {
  // QuoteHeader: 48 bytes
  // TdxQuoteBody_1_0: 16+48+48+4+4+8+8+48+48+48+48+48+48+48+48+64 = 576 bytes
  return quoteBytes.subarray(0, 48 + 576)
}

/**
 * Compute the signed region of a TDX 1.5 quote: header || body_descriptor || body
 */
export function getTdx15SignedRegion(quoteBytes: Buffer): Buffer {
  const { body_size } = TdxQuoteV5Descriptor.parse(quoteBytes)
  const headerLen = 48 // QuoteHeader size
  const totalLen = headerLen + 2 + 4 + body_size
  return quoteBytes.subarray(0, totalLen)
}

/**
 * Parse a TDX 1.0 or 1.5 quote as header, body, and signature.
 */
export function parseTdxQuote(quote: Buffer): {
  header: ReturnType<typeof QuoteHeader.parse>
  body: ReturnType<typeof TdxQuoteBody_1_0.parse> | ReturnType<typeof TdxQuoteBody_1_5.parse>
  signature: TdxSignature
} {
  const header = QuoteHeader.parse(quote)
  if (header.version === 4) {
    const { body } = TdxQuoteV4.parse(quote)
    const signature = parseTdxSignature(quote)

    return { header, body, signature }
  } else if (header.version === 5) {
    const { body_type, body_size, extra } = TdxQuoteV5Descriptor.parse(quote)

    let body
    if (body_type === 1) {
      throw new Error("parseQuote: unexpected body_type = 1")
    } else if (body_type === 2) {
      body = TdxQuoteBody_1_0.parse(extra.subarray(0, body_size))
    } else if (body_type === 3) {
      body = TdxQuoteBody_1_5.parse(extra.subarray(0, body_size))
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
  header: ReturnType<typeof QuoteHeader.parse>
  body: ReturnType<typeof SgxReportBody.parse>
  signature: SgxSignature
} {
  const header = QuoteHeader.parse(quote)
  if (header.version !== 3) {
    throw new Error("parseQuote: Unsupported SGX quote version")
  }

  const { body } = SgxQuote.parse(quote)
  const signature = parseSgxSignature(quote)

  return { header, body, signature }
}

export function parseSgxQuoteBase64(quote: string) {
  return parseSgxQuote(Buffer.from(quote, "base64"))
}
