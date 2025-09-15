import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
const data=JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf8"));
const {signature}=parseTdxQuoteBase64(data.tdx.quote);
console.log("type", signature.cert_data_type, "len", signature.cert_data_len, "actual", signature.cert_data?.length);
