import fs from "node:fs"
import { X509Certificate } from "node:crypto"
import { parseTdxQuoteBase64 } from "../qvl/structs.js"

const data = JSON.parse(fs.readFileSync("./test/sample/tdx-v4-gcp.json", "utf-8"))
const quote: string = data.tdx.quote
const { signature } = parseTdxQuoteBase64(quote)
const buf = signature.qe_auth_data

const begin = Buffer.from("-----BEGIN CERTIFICATE-----", "ascii")
const s = buf.indexOf(begin)
console.log("begin at", s)
if (s < 0) process.exit(0)
const endMarker = Buffer.from("-----END CERTIFICATE-----", "ascii")
const eIdx = buf.indexOf(endMarker, s)
console.log("end at", eIdx)
if (eIdx >= 0) {
  const pem = buf.subarray(s, eIdx + endMarker.length).toString("utf8")
  console.log("PEM slice len:", pem.length)
}

// Gather base64 characters after BEGIN until we parse a cert or run out
const base64Allowed = new Set<number>([
  ...Array.from({ length: 26 }, (_, i) => 0x41 + i), // A-Z
  ...Array.from({ length: 26 }, (_, i) => 0x61 + i), // a-z
  ...Array.from({ length: 10 }, (_, i) => 0x30 + i), // 0-9
  0x2b, // +
  0x2f, // /
  0x3d, // =
  0x0a, // \n
  0x0d, // \r
  0x20, // space
  0x09, // tab
])

let end = s + begin.length
while (end < buf.length && base64Allowed.has(buf[end])) end++
const raw = buf.subarray(s + begin.length, end).toString("ascii").replace(/[\s]/g, "")
console.log("base64 chars:", raw.length)
try {
  const der = Buffer.from(raw, "base64")
  console.log("der len:", der.length)
  const cert = new X509Certificate(der)
  console.log("Recovered leaf subject:", cert.subject)
} catch (e) {
  console.log("failed to parse DER cert:", (e as Error).message)
}

