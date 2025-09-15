import fs from "node:fs"
import { X509Certificate, createVerify } from "node:crypto"
import { parseTdxQuoteBase64 } from "../qvl/structs.js"
import {
  extractPemCertificates,
  extractX509CertificatesFromBuffer,
  encodeEcdsaSignatureToDer,
} from "../qvl/utils.js"

const data = JSON.parse(fs.readFileSync("./test/sample/tdx-v4-gcp.json", "utf-8"))
const quote: string = data.tdx.quote
const { signature } = parseTdxQuoteBase64(quote)

const text = signature.cert_data!.toString("utf8")
const begin = "-----BEGIN CERTIFICATE-----"
const firstPemIdx = text.indexOf(begin)
const before = firstPemIdx >= 0 ? text.substring(0, firstPemIdx) : text
const b64 = before.replace(/[^A-Za-z0-9+/=]/g, "")
console.log("before PEM b64 len:", b64.length)
const cmsDer = Buffer.from(b64, "base64")
console.log("cmsDer len:", cmsDer.length)

const derCerts = extractX509CertificatesFromBuffer(cmsDer)
console.log("DER certs inside CMS:", derCerts.length)
for (const c of derCerts) console.log(" - subj:", c.subject)

// try verifying qe_report with any DER cert found in CMS
const derSig = encodeEcdsaSignatureToDer(signature.qe_report_signature)
for (const c of derCerts) {
  try {
    const v = createVerify("sha256")
    v.update(signature.qe_report)
    v.end()
    const ok = v.verify(c.publicKey, derSig)
    console.log("verify with CMS cert:", c.subject.split("\n")[0], ok)
  } catch (e) {
    console.log("verify with CMS cert error:", (e as Error).message)
  }
}

