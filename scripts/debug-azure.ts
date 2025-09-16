import fs from "node:fs"
import { parseTdxQuote } from "../qvl/index.js"

const buf = fs.readFileSync("test/sample/tdx-v4-azure-vtpm.bin")
const { signature, header } = parseTdxQuote(buf)

function containsPem(b?: Buffer | null): boolean {
  if (!b) return false
  const s = b.toString("utf8")
  return s.includes("-----BEGIN CERTIFICATE-----")
}

console.log({
  version: header.version,
  qe_auth_data_len: signature.qe_auth_data_len,
  cert_data_type: signature.cert_data_type,
  cert_data_len: signature.cert_data_len,
  qe_auth_contains_pem: containsPem(signature.qe_auth_data),
  cert_data_contains_pem: containsPem(signature.cert_data as Buffer | undefined),
})

