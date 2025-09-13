export const hex = (b: Buffer) => b.toString("hex")

export function extractPemCertsFromBuffer(certData: Buffer): string[] {
  const text = certData.toString("utf-8")
  const regex = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  const matches = text.match(regex) || []
  return matches
}

export function ecdsaSigRawToDer(sig: Buffer): Buffer {
  if (sig.length !== 64) throw new Error("Expected 64-byte raw ECDSA signature")
  const r = sig.slice(0, 32)
  const s = sig.slice(32, 64)

  const derInt = (bn: Buffer) => {
    // trim leading zeros
    let v = Buffer.from(bn)
    while (v.length > 0 && v[0] === 0x00) v = v.slice(1)
    // if high bit set, prepend 0x00
    if (v.length === 0 || (v[0] & 0x80)) v = Buffer.concat([Buffer.from([0x00]), v])
    return Buffer.concat([Buffer.from([0x02, v.length]), v])
  }

  const rDer = derInt(r)
  const sDer = derInt(s)
  const seqLen = rDer.length + sDer.length
  return Buffer.concat([Buffer.from([0x30, seqLen]), rDer, sDer])
}

/** Convert raw P-256 uncompressed public key (x||y, 64 bytes) to SPKI DER */
export function p256RawPublicKeyToSpkiDer(rawXY: Buffer): Buffer {
  if (rawXY.length !== 64) throw new Error("Expected 64-byte P-256 public key (x||y)")
  const uncompressed = Buffer.concat([Buffer.from([0x04]), rawXY])

  // SEQUENCE(
  //   SEQUENCE(
  //     OID 1.2.840.10045.2.1 (id-ecPublicKey)
  //     OID 1.2.840.10045.3.1.7 (secp256r1)
  //   )
  //   BIT STRING (0 unused bits) 0x04||X||Y
  // )

  const idEcPublicKey = Buffer.from([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01])
  const secp256r1 = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07])
  const algIdInner = Buffer.concat([idEcPublicKey, secp256r1])
  const algId = Buffer.concat([Buffer.from([0x30, algIdInner.length]), algIdInner])

  const bitString = Buffer.concat([
    Buffer.from([0x03, uncompressed.length + 1, 0x00]),
    uncompressed,
  ])

  const spkiInner = Buffer.concat([algId, bitString])
  const spki = Buffer.concat([Buffer.from([0x30, spkiInner.length]), spkiInner])
  return spki
}
