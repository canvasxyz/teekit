import fs from "node:fs"
import { parseTdxQuote } from "../qvl/structs.js"
import { extractPemCertificates } from "../qvl/utils.js"
import { verifyPCKChain } from "../qvl/verifyTdx.js"
import { X509Certificate, BasicConstraintsExtension, KeyUsagesExtension, KeyUsageFlags } from "../qvl/x509.js"
import { Certificate } from "pkijs"
import { fromBER } from "asn1js"

function logCert(c: X509Certificate, idx: number) {
  console.log(`#${idx} subj=${c.subject}`)
  console.log(`#${idx} issu=${c.issuer}`)
  console.log(`#${idx} serial=${c.serialNumber}`)
  console.log(`#${idx} notBefore=${c.notBefore.toISOString()} notAfter=${c.notAfter.toISOString()}`)
}

async function main() {
  const hex = fs.readFileSync("test/sample/tdx-v4-tappd.hex", "utf-8").replace(/^0x/, "")
  const quote = Buffer.from(hex, "hex")
  const { signature } = parseTdxQuote(quote)
  const pems = extractPemCertificates(signature.cert_data)
  console.log(`Got ${pems.length} pems`)
  const certs = pems.map((p) => new X509Certificate(p))
  certs.forEach((c, i) => logCert(c, i))
  console.log("leaf.issuer == interm.subject?", certs[0].issuer === certs[1].subject)
  console.log("interm.issuer == root.subject?", certs[1].issuer === certs[2].subject)
  // Dump extensions of #1
  const der = (c: X509Certificate) => Buffer.from(c.rawData)
  const asn = fromBER(der(certs[1]).buffer)
  const pc = new Certificate({ schema: asn.result })
  console.log("ext count", pc.extensions?.length)
  for (const e of pc.extensions || []) {
    console.log("ext", e.extnID, "parsed?", !!(e as any).parsedValue)
  }
  const kuExt = pc.extensions?.find((e) => e.extnID === '2.5.29.15')
  if (kuExt) {
    const v = (kuExt.extnValue.valueBlock.valueHexView)
    console.log('ku octets hex', Buffer.from(v).toString('hex'))
    const inner = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)
    const bs = fromBER(inner).result as any
    const view = bs.valueBlock.valueHexView as Uint8Array
    console.log('ku raw bytes', Buffer.from(view).toString('hex'))
    // compute mask like wrapper
    const unused = view[0] || 0
    const bits = (view.length - 1) * 8 - unused
    let mask = 0
    for (let i = 0; i < bits; i++) {
      const byteIndex = 1 + Math.floor(i / 8)
      const bitIndex = 7 - (i % 8)
      if ((view[byteIndex] >> bitIndex) & 1) mask |= 1 << i
    }
    console.log('computed ku mask', mask)
  }
  const { status, chain } = await verifyPCKChain(pems, Date.now())
  console.log(`status=${status} chainLen=${chain.length}`)
  chain.forEach((c, i) => console.log(`chain[${i}] subj=${c.subject}`))

  // Manual chain walk and verifies
  let leaf = certs.find((c) => !certs.some((o) => o.issuer === c.subject)) || certs[0]
  const manualChain: X509Certificate[] = [leaf]
  while (true) {
    const cur = manualChain[manualChain.length - 1]
    const parent = certs.find((c) => c.subject === cur.issuer)
    if (!parent || parent === cur) break
    manualChain.push(parent)
  }
  console.log("manual chain len", manualChain.length)
  for (let i = 0; i < manualChain.length - 1; i++) {
    const child = manualChain[i]
    const parent = manualChain[i + 1]
    const ok = await child.verify(parent)
    console.log(`verify child[${i}] by parent[${i+1}] =>`, ok)
    const childBC = child.getExtension(BasicConstraintsExtension)
    const parentBC = parent.getExtension(BasicConstraintsExtension)
    const childKU = child.getExtension(KeyUsagesExtension)
    const parentKU = parent.getExtension(KeyUsagesExtension)
    console.log('childBC obj', childBC)
    console.log('parentBC obj', parentBC)
    console.log(`child[${i}] bc.ca=${childBC?.ca} ku=${childKU?.usages}`)
    console.log(`parent[${i+1}] bc.ca=${parentBC?.ca} ku=${parentKU?.usages}`)
    if (parentKU) {
      console.log(`parent keyCertSign?`, (parentKU.usages & KeyUsageFlags.keyCertSign) !== 0)
    }
  }
  const terminal = manualChain[manualChain.length - 1]
  if (terminal) {
    console.log("terminal self?", terminal.subject === terminal.issuer)
    console.log("terminal self verify =>", await terminal.verify(terminal))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

