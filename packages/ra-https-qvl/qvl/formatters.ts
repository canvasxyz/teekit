import type { TdxSignature } from "./structs.js"
import type {
  QuoteHeaderType,
  TdxQuoteBody10Type,
  TdxQuoteBody15Type,
} from "./structs.js"
import { hex } from "./utils.js"

export const formatTDXHeader = (header: QuoteHeaderType) => {
  return {
    version: header.version,
    att_key_type: header.att_key_type,
    tee_type: header.tee_type,
    qe_svn: header.qe_svn,
    pce_svn: header.pce_svn,
    qe_vendor_id: hex(header.qe_vendor_id),
    user_data: hex(header.user_data),
  }
}

export const formatTDXQuoteBodyV4 = (
  report: TdxQuoteBody10Type | TdxQuoteBody15Type,
) => {
  return {
    seam_svn: report.seam_svn,
    td_attributes: hex(report.td_attributes),
    xfam: hex(report.xfam),
    mr_td: hex(report.mr_td),
    mr_config_id: hex(report.mr_config_id),
    mr_owner: hex(report.mr_owner),
    mr_owner_config: hex(report.mr_owner_config),
    rtmr0: hex(report.rtmr0),
    rtmr1: hex(report.rtmr1),
    rtmr2: hex(report.rtmr2),
    rtmr3: hex(report.rtmr3),
    report_data: hex(report.report_data),
  }
}

export const formatTdxSignature = (signature: TdxSignature) => {
  return {
    ecdsa_signature: hex(signature.ecdsa_signature),
    attestation_public_key: hex(signature.attestation_public_key),
    qe_report_present: signature.qe_report_present,
    qe_report_signature: hex(signature.qe_report_signature),
    qe_auth_data_len: signature.qe_auth_data_len,
    qe_auth_data: hex(signature.qe_auth_data),
    cert_data_type: signature.cert_data_type,
    cert_data_len: signature.cert_data_len,
  }
}
