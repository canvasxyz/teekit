import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { extractPemCertificates } from "./qvl/utils.ts";
import { X509Certificate, createVerify } from "node:crypto";

const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const pems = extractPemCertificates(signature.cert_data!);
const certs = pems.map(p => new X509Certificate(p));
const leaf = certs.find(c => !certs.some(o => o.issuer === c.subject)) || certs[0];
const r = Buffer.from(signature.qe_report_signature.subarray(0,32));
const s = Buffer.from(signature.qe_report_signature.subarray(32));
const rev = Buffer.concat([Buffer.from(r).reverse(), Buffer.from(s).reverse()]);
const v = createVerify("sha256"); v.update(signature.qe_report); v.end();
console.log('raw', v.verify({key: leaf.publicKey, dsaEncoding: "ieee-p1363" as const}, signature.qe_report_signature));
const v2 = createVerify("sha256"); v2.update(signature.qe_report); v2.end();
console.log('raw-rev', v2.verify({key: leaf.publicKey, dsaEncoding: "ieee-p1363" as const}, rev));
