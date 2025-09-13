import fs from "node:fs"
import { parseTdxQuoteBase64, formatTdxSignature } from "../qvl/index.js"
import { X509Certificate } from "node:crypto"

const data = JSON.parse(fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"))
const quote: string = data.tdx.quote
const { header, signature } = parseTdxQuoteBase64(quote)
console.log({
  att_key_type: header.att_key_type,
  cert_data_type: signature.cert_data_type,
  cert_data_len: signature.cert_data_len,
  qe_auth_data_len: signature.qe_auth_data_len,
  qe_report_present: signature.qe_report_present,
  sig_preview: formatTdxSignature(signature),
})

const regex = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
const certsInQeAuth = signature.qe_auth_data.toString("utf8").match(regex) || []
const certsInCertData = signature.cert_data?.toString("utf8").match(regex) || []
console.log({ num_pem_in_qe_auth_data: certsInQeAuth.length, num_pem_in_cert_data: certsInCertData.length })
certsInQeAuth.forEach((pem, i) => {
  try {
    const x = new X509Certificate(pem)
    console.log({ idx: i, subject: x.subject, issuer: x.issuer, pubKeyAlgorithm: x.publicKey.asymmetricKeyType })
  } catch {}
})
certsInCertData.forEach((pem, i) => {
  try {
    const x = new X509Certificate(pem)
    console.log({ idx: i, subject: x.subject, issuer: x.issuer, pubKeyAlgorithm: x.publicKey.asymmetricKeyType })
  } catch {}
})

