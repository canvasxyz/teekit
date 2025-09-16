import fs from "node:fs"
import path from "node:path"
import { TdxQuoteHeader, TdxQuoteBody_1_0, parseTdxQuote } from "../qvl/structs.js"

function toHex(buf: Buffer, max = 64) {
  const slice = buf.subarray(0, Math.min(max, buf.length))
  return [...slice].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function findAll(buf: Buffer, needle: Buffer): number[] {
  const idxs: number[] = []
  let i = 0
  while (true) {
    const idx = buf.indexOf(needle, i)
    if (idx === -1) break
    idxs.push(idx)
    i = idx + 1
  }
  return idxs
}

const inputPath = process.argv[2] || path.resolve("/workspace/test/sample/tdx-v4-azure-vtpm.bin")
const bytes = fs.readFileSync(inputPath)

const { header, body, signature } = parseTdxQuote(bytes)

// Offsets within the full quote
const headerLen = (TdxQuoteHeader.baseSize as number)
const bodyLen = (TdxQuoteBody_1_0.baseSize as number)
const sigLenFieldLen = 4
const sigDataStart = headerLen + bodyLen + sigLenFieldLen

// Fixed ECDSA segment before qe_auth_data (64 + 64 + 384 + 64 + 2)
const ecdsaFixedLen = 64 + 64 + 384 + 64 + 2
const qeAuthStart = sigDataStart + ecdsaFixedLen
const qeAuthEnd = qeAuthStart + signature.qe_auth_data_len

console.log(JSON.stringify({
  header: { version: header.version, att_key_type: header.att_key_type },
  qe_auth_data_len: signature.qe_auth_data_len,
  qe_auth_data_offset: { start: qeAuthStart, end: qeAuthEnd },
  qe_auth_prefix_hex: toHex(signature.qe_auth_data, 128),
}, null, 2))

const pemBegin = Buffer.from("-----BEGIN CERTIFICATE-----", "ascii")
const pemEnd = Buffer.from("-----END CERTIFICATE-----", "ascii")

// Search within qe_auth_data only
const beginIdxs = findAll(signature.qe_auth_data, pemBegin)
const endIdxs = findAll(signature.qe_auth_data, pemEnd)

console.log(JSON.stringify({
  pem_in_qe_auth: {
    begin_indices: beginIdxs,
    end_indices: endIdxs,
  }
}, null, 2))

// Also search entire file for reference
const beginAll = findAll(bytes, pemBegin)
const endAll = findAll(bytes, pemEnd)
console.log(JSON.stringify({ all_file_pem: { begin_indices: beginAll, end_indices: endAll } }, null, 2))

