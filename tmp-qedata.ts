import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
console.log("qe_auth_data_len", signature.qe_auth_data_len);
console.log("qe_auth_data hex head", signature.qe_auth_data.subarray(0,32).toString("hex"));
console.log("qe_report sig head", signature.qe_report_signature.subarray(0,16).toString("hex"));
console.log("qe_report head", signature.qe_report.subarray(0,16).toString("hex"));
