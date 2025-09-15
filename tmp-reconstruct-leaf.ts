import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { X509Certificate } from "node:crypto";

const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const text = signature.cert_data!.toString("utf8");
const endMarker = "-----END CERTIFICATE-----";
const beginMarker = "-----BEGIN CERTIFICATE-----";
const firstEnd = text.indexOf(endMarker);
const firstBegin = text.indexOf(beginMarker);
console.log({ firstEnd, firstBegin });
const base64Body = text.slice(0, firstEnd).replace(/[^A-Za-z0-9+/=]+/g, "");
const pem = ;
try {
  const cert = new X509Certificate(pem);
  console.log(leaf
