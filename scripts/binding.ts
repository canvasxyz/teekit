import fs from "node:fs"
import { parseTdxQuoteBase64 } from "../qvl/index.js"
import { createHash } from "node:crypto"

function sha256(data: Buffer) {
  return createHash("sha256").update(data).digest()
}

const data = JSON.parse(fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"))
const quoteB64: string = data.tdx.quote
const { signature } = parseTdxQuoteBase64(quoteB64)
const reportData = signature.qe_report.subarray(signature.qe_report.length - 64)
const expected = reportData.subarray(0, 32)

const x = signature.attestation_public_key.subarray(0, 32)
const y = signature.attestation_public_key.subarray(32)
const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y])
const zeros = Buffer.alloc(32)

const combos: [string, Buffer][] = [
  ["sha256(pub||qe_auth)", sha256(Buffer.concat([signature.attestation_public_key, signature.qe_auth_data]))],
  ["sha256(0x04||x||y||qe_auth)", sha256(Buffer.concat([uncompressed, signature.qe_auth_data]))],
  ["sha256(pub)", sha256(signature.attestation_public_key)],
  ["sha256(0x04||x||y)", sha256(uncompressed)],
  ["sha256(qe_auth)", sha256(signature.qe_auth_data)],
]

for (const [name, h] of combos) {
  console.log(name, h.equals(expected))
}

console.log("report_data (first32)", expected.toString("hex"))

