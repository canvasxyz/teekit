import fs from "node:fs";
import { parseTdxQuoteBase64 } from "./qvl/structs.ts";
import { X509Certificate, createVerify } from "node:crypto";
import { encodeEcdsaSignatureToDer } from "./qvl/utils.ts";

const data = JSON.parse(fs.readFileSync("/workspace/test/sample/tdx-v4-gcp.json","utf-8"));
const { signature } = parseTdxQuoteBase64(data.tdx.quote);
const cd = signature.cert_data!;
const txt = cd.toString("utf8");
const idx = txt.indexOf("-----BEGIN CERTIFICATE-----");
const head = (idx>=0? txt.slice(0, idx) : txt).replace(/\s+/g, "").trim();
console.log(prefix
