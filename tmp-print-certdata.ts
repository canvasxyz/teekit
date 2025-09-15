import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
const data=JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf8"));
const {signature}=parseTdxQuoteBase64(data.tdx.quote);
const txt=signature.cert_data!.toString("utf8");
console.log(txt.slice(0, 600));
