import fs from "node:fs"
import { TdxQuoteHeader, TdxQuoteBody_1_0, parseTdxQuoteBase64 } from "../qvl/index.js"
import { createPublicKey, verify as nodeVerify } from "node:crypto"

function base64UrlEncode(buf: Buffer) {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

function xyToPublicKey(x: Buffer, y: Buffer) {
  const jwk = { kty: "EC", crv: "P-256", x: base64UrlEncode(x), y: base64UrlEncode(y) } as any
  return createPublicKey({ key: jwk, format: "jwk" })
}

function p256RawSigToDer(signature: Buffer): Buffer {
  if (signature.length !== 64) throw new Error("bad sig len")
  const r = signature.subarray(0, 32)
  const s = signature.subarray(32)
  const trim = (b: Buffer) => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let v = b.subarray(i)
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v])
    return v
  }
  const rT = trim(r), sT = trim(s)
  return Buffer.concat([Buffer.from([0x30, 2 + rT.length + 2 + sT.length]), Buffer.from([0x02, rT.length]), rT, Buffer.from([0x02, sT.length]), sT])
}

const data = JSON.parse(fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"))
const quoteB64: string = data.tdx.quote
const quote = Buffer.from(quoteB64, "base64")
const { header, signature } = parseTdxQuoteBase64(quoteB64)

const attX = signature.attestation_public_key.subarray(0, 32)
const attY = signature.attestation_public_key.subarray(32)
const attPubKey = xyToPublicKey(attX, attY)
const sigDer = p256RawSigToDer(signature.ecdsa_signature)

const candidates: [string, Buffer][] = []
const headLen = TdxQuoteHeader.baseSize
const bodyLen = TdxQuoteBody_1_0.baseSize
const sigLenFieldLen = 4
// plausible ranges
candidates.push(["header+body", quote.subarray(0, headLen + bodyLen)])
candidates.push(["header+body+sig_len", quote.subarray(0, headLen + bodyLen + sigLenFieldLen)])
candidates.push(["entire-without-sig_data", quote.subarray(0, headLen + bodyLen + sigLenFieldLen)])

for (const [name, msg] of candidates) {
  const ok = nodeVerify("sha256", msg, attPubKey, sigDer)
  console.log({ name, ok, msgLen: msg.length })
}

