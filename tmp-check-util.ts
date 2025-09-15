import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { extractDerCertificatesFromBase64Prefix, extractPemCertificates } from "./qvl/utils.ts";
const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const extras = extractDerCertificatesFromBase64Prefix(signature.cert_data!);
console.log("extra DER certs", extras.length);
console.log("pems", extractPemCertificates(signature.cert_data!).length);
