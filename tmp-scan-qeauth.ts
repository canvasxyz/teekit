import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { X509Certificate } from "node:crypto";

const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const qa = signature.qe_auth_data;
console.log("qa len", qa.length);
let derOffsets:number[]=[];
for (let i=0;i<qa.length-1;i++){
  if (qa[i]===0x30 && qa[i+1]===0x82) derOffsets.push(i);
}
console.log("DER offsets", derOffsets.slice(0,10));
for (const off of derOffsets.slice(0,5)){
  try{ const cert = new X509Certificate(qa.subarray(off)); console.log("DER cert at", off, cert.subject); } catch {}
}
const txt = qa.toString("utf8");
const pemRe = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const matches = txt.match(pemRe) || [];
console.log("PEM matches", matches.length);
for (let i=0;i<matches.length;i++){
  try{ const cert = new X509Certificate(matches[i]); console.log("PEM", i, cert.subject);} catch {}
}
