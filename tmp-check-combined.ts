import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { extractCertificatesPossiblyWithLeadingBase64 } from "./qvl/utils.ts";
const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const certs = extractCertificatesPossiblyWithLeadingBase64(signature.cert_data!);
console.log("count", certs.length);
for (const c of certs){ console.log(c.subject); }
