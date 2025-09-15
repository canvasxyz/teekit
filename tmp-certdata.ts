import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { X509Certificate } from "node:crypto";

const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json", "utf-8"));
const quote: string = data.tdx.quote;
const { signature } = parseTdxQuoteBase64(quote);
if (!signature.cert_data) { console.log("no cert_data"); process.exit(0); }
const cd = signature.cert_data;
console.log(cert_data
