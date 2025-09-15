import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { extractPemCertificates } from "./qvl/utils.ts";
import { X509Certificate, createVerify } from "node:crypto";

const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const pems = extractPemCertificates(signature.cert_data!);
const certs = pems.map(p => new X509Certificate(p));
const leaf = certs.find(c => !certs.some(o => o.issuer === c.subject)) || certs[0];
for (const algo of ["sha256","sha384","sha512"]) {
  const v = createVerify(algo as any);
  v.update(signature.qe_report); v.end();
  const ok = v.verify({key: leaf.publicKey, dsaEncoding: "ieee-p1363" as const}, signature.qe_report_signature);
  console.log(algo, ok);
}
