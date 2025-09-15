import fs from "node:fs"
import { parseTdxQuoteBase64 } from "../qvl/structs.js"
import {
  extractPemCertificates,
  extractAllX509CertificatesFromCertData,
} from "../qvl/utils.js"
import { verifyProvisioningCertificationChain } from "../qvl/verify.js"

const data = JSON.parse(fs.readFileSync("./test/sample/tdx-v4-gcp.json", "utf-8"))
const quote: string = data.tdx.quote
const { signature } = parseTdxQuoteBase64(quote)

const pems = extractPemCertificates(signature.cert_data!)
console.log("PEM count:", pems.length)

const all = extractAllX509CertificatesFromCertData(signature.cert_data!)
console.log("All extracted certs:", all.length)
for (const c of all) {
  console.log(" - subj:", c.subject)
}

const { status, chain, root } = verifyProvisioningCertificationChain(
  signature.cert_data!,
  { verifyAtTimeMs: Date.parse("2025-09-01T00:01:00Z") },
)
console.log("chain status:", status)
console.log("chain length:", chain.length)
for (const c of chain) console.log("chain subj:", c.subject)
console.log("root subj:", root?.subject)

