import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const cd = signature.cert_data!;
const txt = cd.toString("utf8");
const idx = txt.indexOf("-----BEGIN CERTIFICATE-----");
const prefix = (idx>=0? txt.slice(0, idx) : txt);
console.log("prefix (first 120 chars):\n", prefix.slice(0, 120).replace(/\n/g,"\\n"));
console.log("prefix length chars:", prefix.length);
const head = prefix.replace(/\s+/g, "");
console.log("head b64-ish:", /^[A-Za-z0-9+/=]+$/.test(head));
if (/^[A-Za-z0-9+/=]+$/.test(head) && head.length>60) {
  try{
    const der = Buffer.from(head, base64);
    // print DER magic
    console.log("DER magic bytes:", der.subarray(0,4).toString("hex"));
  }catch(e){ console.log("b64 decode failed:", (e as Error).message); }
}
