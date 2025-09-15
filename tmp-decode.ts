import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { X509Certificate } from "node:crypto";
const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const txt = signature.cert_data!.toString("utf8");
const idx = txt.indexOf("-----BEGIN CERTIFICATE-----");
const prefix = (idx>=0? txt.slice(0, idx) : txt);
const b64 = prefix.replace(/[^A-Za-z0-9+/=]+/g, "");
console.log("b64 len", b64.length);
const der = Buffer.from(b64, "base64");
console.log("der bytes", der.length, der.subarray(0,16).toString("hex"));
let count=0;
for (let i=0;i<der.length;i++){ if (der[i]===0x30){ try { new X509Certificate(der.subarray(i)); count++; console.log("x509 at", i); } catch{} } }
