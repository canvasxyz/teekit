import * as r from "restructure"

export type QuoteHeaderType = {
  version: number
  att_key_type: number
  tee_type: number
  qe_svn: number
  pce_svn: number
  qe_vendor_id: Uint8Array
  user_data: Uint8Array
}

export const QuoteHeader = new r.Struct({
  version: r.uint16le,
  att_key_type: r.uint16le,
  tee_type: r.uint32le,
  qe_svn: r.uint16le,
  pce_svn: r.uint16le,
  qe_vendor_id: new r.Buffer(16),
  user_data: new r.Buffer(20),
})

export type SgxReportBodyType = {
  cpu_svn: Uint8Array
  misc_select: number
  reserved1: Uint8Array
  attributes: Uint8Array
  mr_enclave: Uint8Array
  reserved2: Uint8Array
  mr_signer: Uint8Array
  reserved3: Uint8Array
  isv_prod_id: number
  isv_svn: number
  reserved4: Uint8Array
  report_data: Uint8Array
}

export const SgxReportBody = new r.Struct({
  cpu_svn: new r.Buffer(16),
  misc_select: r.uint32le,
  reserved1: new r.Buffer(28),
  attributes: new r.Buffer(16),
  mr_enclave: new r.Buffer(32),
  reserved2: new r.Buffer(32),
  mr_signer: new r.Buffer(32),
  reserved3: new r.Buffer(96),
  isv_prod_id: r.uint16le,
  isv_svn: r.uint16le,
  reserved4: new r.Buffer(60),
  report_data: new r.Buffer(64),
})

export type TdxQuoteBody10Type = {
  tee_tcb_svn: Uint8Array
  mr_seam: Uint8Array
  mr_seam_signer: Uint8Array
  seam_svn: number
  reserved0: number
  td_attributes: Uint8Array
  xfam: Uint8Array
  mr_td: Uint8Array
  mr_config_id: Uint8Array
  mr_owner: Uint8Array
  mr_owner_config: Uint8Array
  rtmr0: Uint8Array
  rtmr1: Uint8Array
  rtmr2: Uint8Array
  rtmr3: Uint8Array
  report_data: Uint8Array
}

export const TdxQuoteBody_1_0 = new r.Struct({
  tee_tcb_svn: new r.Buffer(16),
  mr_seam: new r.Buffer(48),
  mr_seam_signer: new r.Buffer(48),
  seam_svn: r.uint32le,
  reserved0: r.uint32le,
  td_attributes: new r.Buffer(8),
  xfam: new r.Buffer(8),
  mr_td: new r.Buffer(48),
  mr_config_id: new r.Buffer(48),
  mr_owner: new r.Buffer(48),
  mr_owner_config: new r.Buffer(48),
  rtmr0: new r.Buffer(48),
  rtmr1: new r.Buffer(48),
  rtmr2: new r.Buffer(48),
  rtmr3: new r.Buffer(48),
  report_data: new r.Buffer(64),
})

export type TdxQuoteBody15Type = TdxQuoteBody10Type & {
  tee_tcb_svn_2: Uint8Array
  mrservictd: Uint8Array
}

export const TdxQuoteBody_1_5 = new r.Struct({
  tee_tcb_svn: new r.Buffer(16),
  mr_seam: new r.Buffer(48),
  mr_seam_signer: new r.Buffer(48),
  seam_svn: r.uint32le,
  reserved0: r.uint32le,
  td_attributes: new r.Buffer(8),
  xfam: new r.Buffer(8),
  mr_td: new r.Buffer(48),
  mr_config_id: new r.Buffer(48),
  mr_owner: new r.Buffer(48),
  mr_owner_config: new r.Buffer(48),
  rtmr0: new r.Buffer(48),
  rtmr1: new r.Buffer(48),
  rtmr2: new r.Buffer(48),
  rtmr3: new r.Buffer(48),
  report_data: new r.Buffer(64),
  tee_tcb_svn_2: new r.Buffer(16),
  mrservictd: new r.Buffer(48),
})

export type IntelTcbInfo = {
  tcbInfo: {
    version: number
    issueDate: string
    nextUpdate: string
    fmspc: string
    pceId: string
    tcbType: number
    tcbEvaluationDataNumber: number
    tcbLevels: Array<{
      tcb: { [k: string]: number }
      tcbDate: string
      tcbStatus:
        | "UpToDate"
        | "OutOfDate"
        | "OutOfDateConfigurationNeeded"
        | "ConfigurationNeeded"
        | "Revoked"
    }>
  }
  signature?: string
}

export function readUInt16LE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset + offset, 2).getUint16(0, true)
}

export function readUInt32LE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0, true)
}

/**
 * SGX signatures contain a fixed-length ECDSA signature section, and
 * a variable-length cert_data tail.
 */
export function parseSgxSignature(quote: Uint8Array) {
  const headerLen = QuoteHeader.size()
  const bodyLen = SgxReportBody.size()
  const signedLen = headerLen + bodyLen
  const sigLen = readUInt32LE(quote, signedLen)
  const sigStart = signedLen + 4
  const sig_data = quote.subarray(sigStart, sigStart + sigLen)

  const EcdsaSignatureFixed = new r.Struct({
    signature: new r.Buffer(64),
    attestation_public_key: new r.Buffer(64),
    qe_report: new r.Buffer(384),
    qe_report_signature: new r.Buffer(64),
    qe_auth_data_len: r.uint16le,
  })

  const fixed = EcdsaSignatureFixed.fromBuffer(sig_data)
  let offset = EcdsaSignatureFixed.size()

  const qe_auth_data = sig_data.subarray(
    offset,
    offset + fixed.qe_auth_data_len,
  )
  offset += fixed.qe_auth_data_len

  const Tail = new r.Struct({
    cert_data_type: r.uint16le,
    cert_data_len: r.uint32le,
  })

  const tailHeader = Tail.fromBuffer(sig_data.subarray(offset))
  const tailHeaderSize = Tail.size()
  const cert_data = sig_data.subarray(
    offset + tailHeaderSize,
    offset + tailHeaderSize + tailHeader.cert_data_len,
  )

  return {
    ecdsa_signature: fixed.signature,
    attestation_public_key: fixed.attestation_public_key,
    qe_report: fixed.qe_report,
    qe_report_present: fixed.qe_report.length === 384,
    qe_report_signature: fixed.qe_report_signature,
    qe_auth_data_len: fixed.qe_auth_data_len,
    qe_auth_data,
    cert_data_type: tailHeader.cert_data_type,
    cert_data_len: tailHeader.cert_data_len,
    cert_data,
    body_type: null,
  }
}

/**
 * The signature section starts at a fixed offset for V4 quotes, and
 * variable offset for V5 quotes. It contains a fixed-length ECDSA signature,
 * variable-length QE auth_data, and variable-length cert_data tail.
 */
export function parseTdxSignature(quote: Uint8Array, v5?: boolean) {
  let sig_data
  let body_type = null
  if (!v5) {
    const headerLen = QuoteHeader.size()
    const bodyLen = TdxQuoteBody_1_0.size()
    const signedLen = headerLen + bodyLen
    const sigLen = readUInt32LE(quote, signedLen)
    const sigStart = signedLen + 4
    sig_data = quote.subarray(sigStart, sigStart + sigLen)
  } else {
    const headerLen = QuoteHeader.size()
    const descOffset = headerLen
    body_type = readUInt16LE(quote, descOffset)
    const body_size = readUInt32LE(quote, descOffset + 2)
    const sigDescStart = descOffset + 2 + 4 + body_size
    const sigLen = readUInt32LE(quote, sigDescStart)
    const sigStart = sigDescStart + 4
    sig_data = quote.subarray(sigStart, sigStart + sigLen)
  }

  const EcdsaSigFixed = new r.Struct({
    signature: new r.Buffer(64),
    attestation_public_key: new r.Buffer(64),
    cert_type: r.uint16le,
    cert_size: r.uint32le,
    qe_report: new r.Buffer(384),
    qe_report_signature: new r.Buffer(64),
    qe_auth_data_len: r.uint16le,
  })

  const fixed = EcdsaSigFixed.fromBuffer(sig_data)
  let offset = EcdsaSigFixed.size()

  const qe_auth_data = sig_data.subarray(
    offset,
    offset + fixed.qe_auth_data_len,
  )
  offset += fixed.qe_auth_data_len

  const Tail = new r.Struct({
    cert_data_type: r.uint16le,
    cert_data_len: r.uint32le,
  })

  const tailHeader = Tail.fromBuffer(sig_data.subarray(offset))
  const tailHeaderSize = Tail.size()
  const cert_data = sig_data.subarray(
    offset + tailHeaderSize,
    offset + tailHeaderSize + tailHeader.cert_data_len,
  )

  return {
    ecdsa_signature: fixed.signature,
    attestation_public_key: fixed.attestation_public_key,
    qe_report: fixed.qe_report,
    qe_report_present: fixed.qe_report.length === 384,
    qe_report_signature: fixed.qe_report_signature,
    qe_auth_data_len: fixed.qe_auth_data_len,
    qe_auth_data,
    cert_data_type: tailHeader.cert_data_type,
    cert_data_len: tailHeader.cert_data_len,
    cert_data,
    body_type,
  }
}

export type SgxSignature = ReturnType<typeof parseSgxSignature>
export type TdxSignature = ReturnType<typeof parseTdxSignature>

/**
 * Compute the signed region of an SGX quote: header || body (excludes sig length and sig_data)
 */
export function getSgxSignedRegion(quoteBytes: Uint8Array): Uint8Array {
  return quoteBytes.subarray(0, QuoteHeader.size() + SgxReportBody.size())
}

/**
 * Compute the signed region of a TDX 1.0 quote: header || body (excludes sig length and sig_data)
 */
export function getTdx10SignedRegion(quoteBytes: Uint8Array): Uint8Array {
  const headerLen = QuoteHeader.size()
  const bodyLen = TdxQuoteBody_1_0.size()
  return quoteBytes.subarray(0, headerLen + bodyLen)
}

/**
 * Compute the signed region of a TDX 1.5 quote: header || body_descriptor || body
 */
export function getTdx15SignedRegion(quoteBytes: Uint8Array): Uint8Array {
  const headerLen = QuoteHeader.size()
  const body_size = readUInt32LE(quoteBytes, headerLen + 2)
  const totalLen = headerLen + 2 + 4 + body_size
  return quoteBytes.subarray(0, totalLen)
}
