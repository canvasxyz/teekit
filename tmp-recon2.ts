import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { X509Certificate } from "node:crypto";
const data=JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf8"));
const {signature}=parseTdxQuoteBase64(data.tdx.quote);
const text=signature.cert_data!.toString("utf8");
const end="-----END CERTIFICATE-----"; const begin="-----BEGIN CERTIFICATE-----";
const firstEnd=text.indexOf(end), firstBegin=text.indexOf(begin);
console.log({firstEnd, firstBegin});
const b64=text.slice(0,firstEnd).replace(/[^A-Za-z0-9+/=]+/g,"");
const der=Buffer.from(b64,"base64");
console.log("head", der.subarray(0,16).toString("hex"));
try{ new X509Certificate(der); console.log("x509 ok"); }catch(e){ console.log("x509 err", (e as Error).message); }
