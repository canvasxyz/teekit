import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const cd = signature.cert_data!;
console.log("cert_data length", cd.length);
console.log("cd head", cd.subarray(0, 32).toString("hex"));
let offs:number[]=[];
for (let i=0;i<cd.length-1;i++){
  if (cd[i]===0x30 && cd[i+1]===0x82){offs.push(i); if(offs.length>20) break;}
}
console.log("DER offsets", offs);
