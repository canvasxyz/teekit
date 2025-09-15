import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { extractPemCertificates } from "./qvl/utils.ts";
import { X509Certificate, createVerify } from "node:crypto";
import { encodeEcdsaSignatureToDer } from "./qvl/utils.ts";

const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const cd = signature.cert_data!;
console.log(cert_data
