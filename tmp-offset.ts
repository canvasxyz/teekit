import fs from "node:fs";
import { parseTdxQuoteBase64, parseTdxSignature } from "./qvl/structs.ts";
import { Struct } from "typed-struct";
const data=JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf8"));
const q=Buffer.from(data.tdx.quote, "base64");
const { header, body, signature } = (()=>{ const {TdxQuoteV4} = await import("./qvl/structs.ts"); return { header: new (await import("./qvl/structs.ts")).TdxQuoteHeader(q), body: new (await import("./qvl/structs.ts")).TdxQuoteBody_1_0(q.subarray((await import("./qvl/structs.ts")).TdxQuoteHeader.baseSize)), signature: (await import("./qvl/structs.ts")).parseTdxSignature(new (await import("./qvl/structs.ts")).TdxQuoteV4(q).sig_data) }; })();
