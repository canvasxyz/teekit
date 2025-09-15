import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { extractPemCertificates, encodeEcdsaSignatureToDer } from "./qvl/utils.ts";
import { X509Certificate, createVerify } from "node:crypto";

const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json", "utf-8"));
const quote: string = data.tdx.quote;
const { signature } = parseTdxQuoteBase64(quote);
if (!signature.cert_data) { console.log("no cert_data"); process.exit(0); }
const pems = extractPemCertificates(signature.cert_data);
console.log("num certs:", pems.length);
const certs = pems.map(p => new X509Certificate(p));
for (const c of certs) {
  console.log("subject:", c.subject);
  console.log("issuer:", c.issuer);
  console.log("asym:", c.publicKey.asymmetricKeyType);
  // @ts-ignore
  console.log("details:", c.publicKey.asymmetricKeyDetails);
}
const leaf = certs.find(c => !certs.some(o => o.issuer === c.subject)) || certs[0];
console.log("leaf subject:", leaf.subject);
try {
  const derSig = encodeEcdsaSignatureToDer(signature.qe_report_signature);
  const v = createVerify("sha256");
  v.update(signature.qe_report);
  v.end();
  console.log("verify DER:", v.verify(leaf.publicKey, derSig));
} catch (e) {
  console.log("der err:", e);
}
try {
  const v2 = createVerify("sha256");
  v2.update(signature.qe_report);
  v2.end();
  console.log("verify P1363:", v2.verify({ key: leaf.publicKey, dsaEncoding: "ieee-p1363" as const }, signature.qe_report_signature));
} catch (e) {
  console.log("p1363 err:", e);
}
