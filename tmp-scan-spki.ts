import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
function scan(name:string, buf:Buffer){
  console.log("scan", name, buf.length);
  const oid1 = Buffer.from([0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01]);
  const oid2 = Buffer.from([0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07]);
  let hits1:number[]=[]; let hits2:number[]=[];
  for (let i=0;i<buf.length-oid1.length;i++){
    if (buf.subarray(i,i+oid1.length).equals(oid1)) hits1.push(i);
  }
  for (let i=0;i<buf.length-oid2.length;i++){
    if (buf.subarray(i,i+oid2.length).equals(oid2)) hits2.push(i);
  }
  console.log("oid1 hits", hits1.slice(0,5));
  console.log("oid2 hits", hits2.slice(0,5));
}
scan("qe_auth_data", signature.qe_auth_data);
scan("cert_data", signature.cert_data!);
