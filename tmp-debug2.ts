import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { extractPemCertificates } from "./qvl/utils.ts";

const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json", "utf-8"));
const quote: string = data.tdx.quote;
const { signature } = parseTdxQuoteBase64(quote);
console.log(qe_auth_data_len, signature.qe_auth_data_len);
console.log(qe_auth_data
