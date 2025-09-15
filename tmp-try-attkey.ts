import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { createPublicKey, createVerify } from "node:crypto";
const data=JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf8"));
const {signature}=parseTdxQuoteBase64(data.tdx.quote);
const pubRaw=signature.attestation_public_key;
const x=pubRaw.subarray(0,32).toString("base64url"); const y=pubRaw.subarray(32).toString("base64url");
boolish: any;
const jwk={kty:EC,crv:P-256,x,y} as const;
const pub=createPublicKey({key:jwk, format:jwk});
for (const algo of [sha256]){ const v=createVerify(algo as any); v.update(signature.qe_report); v.end(); console.log(algo, v.verify({key:pub, dsaEncoding:ieee-p1363 as const}, signature.qe_report_signature)); }
