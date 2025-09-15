import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";

const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const qa = signature.qe_auth_data;
const txt = qa.toString("utf8");
const pemRe = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const matches = txt.match(pemRe);
console.log(pem
