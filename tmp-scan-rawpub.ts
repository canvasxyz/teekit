import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { createPublicKey, createVerify } from "node:crypto";
const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const qa = signature.qe_auth_data;
let tried = 0, ok = 0;
for (let i = 0; i < qa.length - 65; i++) {
  if (qa[i] === 0x04) {
    const cand = qa.subarray(i, i + 65);
    try {
      const x = cand.subarray(1, 33).toString("base64url");
      const y = cand.subarray(33, 65).toString("base64url");
      const jwk = { kty: "EC", crv: "P-256", x, y } as const;
      const pub = createPublicKey({ key: jwk, format: "jwk" });
      const v = createVerify("sha256"); v.update(signature.qe_report); v.end();
      const ok1 = v.verify({ key: pub, dsaEncoding: "ieee-p1363" as const }, signature.qe_report_signature);
      tried++; if (ok1) { console.log("FOUND pubkey at", i); ok++; break; }
    } catch {}
  }
}
console.log("tried", tried, "ok", ok);
