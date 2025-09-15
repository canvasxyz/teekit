import fs from "node:fs"
import { X509Certificate, createVerify } from "node:crypto"
import { parseTdxQuoteBase64 } from "../qvl/structs.js"
import { extractPemCertificates, encodeEcdsaSignatureToDer, extractPemCertificatesFromBinary } from "../qvl/utils.js"

const data = JSON.parse(fs.readFileSync("./test/sample/tdx-v4-gcp.json", "utf-8"))
const quote: string = data.tdx.quote
const { signature } = parseTdxQuoteBase64(quote)

console.log("qe_report len:", signature.qe_report.length)
console.log("qe_report_signature len:", signature.qe_report_signature.length)
console.log("qe_auth_data_len:", signature.qe_auth_data_len)
console.log("qe_auth_data first 64 hex:", signature.qe_auth_data.subarray(0,64).toString("hex"))
try { console.log("qe_auth_data as ascii head:", signature.qe_auth_data.toString("utf8").substring(0,256)) } catch {}

// Extract PEMs from qe_auth_data
try {
  const pemsAuth = extractPemCertificatesFromBinary(signature.qe_auth_data)
  console.log("qe_auth_data PEM count:", pemsAuth.length)
  const certsAuth = pemsAuth.map((p) => new X509Certificate(p))
  console.log("qe_auth_data subjects:", certsAuth.map((c) => c.subject))
  console.log("qe_auth_data pub types:", certsAuth.map((c) => c.publicKey.asymmetricKeyType))

  // try verify with them
  const derSig = encodeEcdsaSignatureToDer(signature.qe_report_signature)
  for (const c of certsAuth) {
    try {
      const v = createVerify("sha256")
      v.update(signature.qe_report)
      v.end()
      const ok = v.verify(c.publicKey, derSig)
      console.log("verify DER with auth cert:", c.subject.split("\n")[0], ok)
    } catch (e) {
      console.log("verify with auth cert error:", (e as Error).message)
    }
  }
} catch (e) {
  console.log("error extracting PEMs from qe_auth_data:", (e as Error).message)
}

const pems = extractPemCertificates(signature.cert_data!)
console.log("pem count:", pems.length)
const certs = pems.map((p) => new X509Certificate(p))
console.log("subjects:", certs.map((c) => c.subject))
console.log("issuers:", certs.map((c) => c.issuer))
console.log("pub types:", certs.map((c) => c.publicKey.asymmetricKeyType))
console.log(
  "pub named curves:",
  certs.map((c) => (c.publicKey.asymmetricKeyDetails as any)?.namedCurve),
)

// Try DER-style verification
try {
  const derSig = encodeEcdsaSignatureToDer(signature.qe_report_signature)
  const verifier = createVerify("sha256")
  verifier.update(signature.qe_report)
  verifier.end()
  const ok = verifier.verify(certs[0].publicKey, derSig)
  console.log("verify DER:", ok)
} catch (e) {
  console.log("verify DER threw:", (e as Error).message)
}

// Try raw P1363
try {
  const verifier = createVerify("sha256")
  verifier.update(signature.qe_report)
  verifier.end()
  const ok = verifier.verify(
    { key: certs[0].publicKey, dsaEncoding: "ieee-p1363" as const },
    signature.qe_report_signature,
  )
  console.log("verify P1363:", ok)
} catch (e) {
  console.log("verify P1363 threw:", (e as Error).message)
}

const cd = signature.cert_data!
console.log("cert_data first 128 ascii:", cd.subarray(0, 128).toString("ascii"))
console.log("cert_data first 128 hex:", cd.subarray(0, 128).toString("hex"))

// scan for DER sequences 0x30 0x82
function findDerSegments(buf: Buffer) {
  const found: Array<{ offset: number; len: number }> = []
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === 0x30 && buf[i + 1] === 0x82) {
      const len = (buf[i + 2] << 8) | buf[i + 3]
      if (i + 4 + len <= buf.length) {
        found.push({ offset: i, len: 4 + len })
        i += 3
      }
    }
  }
  return found
}

const segments = findDerSegments(cd)
console.log("DER segments found:", segments.length, segments.slice(0, 5))
for (const seg of segments.slice(0, 3)) {
  try {
    const cert = new X509Certificate(cd.subarray(seg.offset, seg.offset + seg.len))
    console.log("parsed DER cert at", seg.offset, cert.subject)
  } catch {}
}

