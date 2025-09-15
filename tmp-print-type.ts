import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
console.log("cert_data_type", signature.cert_data_type);
console.log("cert_data_len", signature.cert_data_len);
