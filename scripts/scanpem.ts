import fs from "node:fs"
import { parseTdxQuoteBase64 } from "../qvl/structs.js"

const data = JSON.parse(fs.readFileSync("./test/sample/tdx-v4-gcp.json", "utf-8"))
const quote: string = data.tdx.quote
const { signature } = parseTdxQuoteBase64(quote)

const a = signature.qe_auth_data
const c = signature.cert_data!
const combined = Buffer.concat([a, c])

const begin = Buffer.from("-----BEGIN CERTIFICATE-----", "ascii")
const end = Buffer.from("-----END CERTIFICATE-----", "ascii")

function findAll(buf: Buffer, needle: Buffer) {
  const idxs: number[] = []
  let pos = 0
  while (true) {
    const i = buf.indexOf(needle, pos)
    if (i === -1) break
    idxs.push(i)
    pos = i + needle.length
  }
  return idxs
}

const beginA = findAll(a, begin)
const endA = findAll(a, end)
console.log("qe_auth_data begins:", beginA, "ends:", endA)
const beginC = findAll(c, begin)
const endC = findAll(c, end)
console.log("cert_data begins:", beginC.slice(0,3), "ends:", endC.slice(0,3))
const beginComb = findAll(combined, begin)
const endComb = findAll(combined, end)
console.log("combined begins count:", beginComb.length, "ends count:", endComb.length)
for (let i = 0; i < Math.min(beginComb.length, endComb.length); i++) {
  const s = beginComb[i]
  const e = endComb[i]
  if (e > s) {
    const slice = combined.subarray(s, e + end.length).toString("utf8")
    console.log("block", i, "len", slice.length)
  }
}

