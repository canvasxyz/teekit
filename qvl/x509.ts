import { fromBER } from "asn1js"
import * as asn1js from "asn1js"
import { Certificate, BasicConstraints, setEngine, CryptoEngine } from "pkijs"

// Minimal crypto provider shim to mirror @peculiar/x509 usage
export const cryptoProvider = {
  _crypto: globalThis.crypto as Crypto | undefined,
  set(instance: Crypto) {
    this._crypto = instance
    // Ensure global WebCrypto is available for pkijs and utils
    try {
      // @ts-ignore
      if (!globalThis.crypto || globalThis.crypto !== instance) {
        // @ts-ignore
        globalThis.crypto = instance as any
      }
    } catch {
      // ignore
    }
    try {
      setEngine(
        "custom",
        instance as any,
        new CryptoEngine({ name: "custom", crypto: instance as any, subtle: (instance as any).subtle }),
      )
    } catch {
      // ignore
    }
  },
}

export enum KeyUsageFlags {
  digitalSignature = 1 << 0,
  nonRepudiation = 1 << 1,
  keyEncipherment = 1 << 2,
  dataEncipherment = 1 << 3,
  keyAgreement = 1 << 4,
  keyCertSign = 1 << 5,
  cRLSign = 1 << 6,
  encipherOnly = 1 << 7,
  decipherOnly = 1 << 8,
}

// Adapters to be API-compatible with previous code
export class BasicConstraintsExtension {
  public ca: boolean
  public pathLength?: number
  constructor(ca: boolean, pathLength?: number) {
    this.ca = ca
    this.pathLength = pathLength
  }
}

export class KeyUsagesExtension {
  public usages: number
  constructor(usages: number) {
    this.usages = usages
  }
}

function pemToDerBytes(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "")
  const buf = Buffer.from(b64, "base64")
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function nameToComparableString(name: any): string {
  try {
    const parts = name.typesAndValues.map((atv: any) => {
      const oid = atv.type
      const val = String(atv.value.valueBlock.value)
      return `${oid}=${val}`
    })
    return parts.join(",")
  } catch {
    return ""
  }
}

function bitArrayToUsageFlags(bitArray: asn1js.BitString): number {
  // pkijs KeyUsage parsed as BitString in extension.value
  const view = bitArray.valueBlock.valueHexView
  if (!view || view.length === 0) return 0
  // First byte(s) are bits; map to mask
  let mask = 0
  const bits = (view.length - 1) * 8 - (view[0] || 0)
  for (let i = 0; i < bits; i++) {
    const byteIndex = 1 + Math.floor(i / 8)
    const bitIndex = 7 - (i % 8)
    if ((view[byteIndex] >> bitIndex) & 1) {
      mask |= 1 << i
    }
  }
  return mask
}

export class X509Certificate {
  private _cert: Certificate
  public rawData: ArrayBuffer

  constructor(pem: string) {
    const derBytes = pemToDerBytes(pem)
    const der = derBytes.buffer.slice(derBytes.byteOffset, derBytes.byteOffset + derBytes.byteLength)
    const asn1 = fromBER(der)
    if (asn1.offset === -1) {
      throw new Error("Failed to parse certificate")
    }
    const cert = new Certificate({ schema: asn1.result })
    this._cert = cert
    this.rawData = der
  }

  get subject(): string {
    return nameToComparableString(this._cert.subject)
  }

  get issuer(): string {
    return nameToComparableString(this._cert.issuer)
  }

  get serialNumber(): string {
    // Uppercase hex without leading 0x
    const hex = Buffer.from(
      this._cert.serialNumber.valueBlock.valueHexView,
    ).toString("hex")
    return hex.toUpperCase()
  }

  get notBefore(): Date {
    return this._cert.notBefore.value as Date
  }

  get notAfter(): Date {
    return this._cert.notAfter.value as Date
  }

  get publicKey(): { rawData: ArrayBuffer } {
    // Export SPKI for WebCrypto import
    const spki = this._cert.subjectPublicKeyInfo.toSchema().toBER(false)
    return { rawData: spki }
  }

  async verify(issuerCert: X509Certificate): Promise<boolean> {
    try {
      // Determine hash and curve
      const sigOid = this._cert.signatureAlgorithm.algorithmId
      let hash: 'SHA-256' | 'SHA-384' | 'SHA-512' = 'SHA-256'
      if (sigOid.includes('1.2.840.10045.4.3.3')) hash = 'SHA-384'
      else if (sigOid.includes('1.2.840.10045.4.3.4')) hash = 'SHA-512'

      // Named curve from issuer public key
      let namedCurve: 'P-256' | 'P-384' | 'P-521' = 'P-256'
      try {
        const params: any = issuerCert._cert.subjectPublicKeyInfo.algorithm.algorithmParams
        const curveOid = params?.valueBlock?.toString?.() || ''
        if (curveOid === '1.3.132.0.34') namedCurve = 'P-384'
        else if (curveOid === '1.3.132.0.35') namedCurve = 'P-521'
        else namedCurve = 'P-256'
      } catch {
        namedCurve = 'P-256'
      }

      const curveLen = namedCurve === 'P-256' ? 32 : namedCurve === 'P-384' ? 48 : 66

      const tbs = this._cert.encodeTBS().toBER(false) as ArrayBuffer
      const sigDer = new Uint8Array(this._cert.signatureValue.valueBlock.valueHex)
      const spki = issuerCert._cert.subjectPublicKeyInfo.toSchema().toBER(false)
      const publicKey = await crypto.subtle.importKey(
        'spki',
        spki,
        { name: 'ECDSA', namedCurve },
        false,
        ['verify'],
      )

      // Try verifying with DER signature directly
      let ok = false
      try {
        ok = await crypto.subtle.verify({ name: 'ECDSA', hash }, publicKey, sigDer, tbs)
      } catch {
        ok = false
      }
      if (ok) return true

      // Fallback: convert DER -> raw (r||s)
      try {
        const asn1sig = fromBER(sigDer.buffer.slice(sigDer.byteOffset, sigDer.byteOffset + sigDer.byteLength))
        const seq: any = asn1sig.result
        const r: Uint8Array = new Uint8Array(seq.valueBlock.value[0].valueBlock.valueHex)
        const s: Uint8Array = new Uint8Array(seq.valueBlock.value[1].valueBlock.valueHex)
        const pad = (v: Uint8Array) => {
          let out = v
          // Remove leading zeros
          while (out.length > 0 && out[0] === 0) out = out.subarray(1)
          if (out.length > curveLen) out = out.subarray(out.length - curveLen)
          const res = new Uint8Array(curveLen)
          res.set(out, curveLen - out.length)
          return res
        }
        const raw = new Uint8Array(curveLen * 2)
        raw.set(pad(r), 0)
        raw.set(pad(s), curveLen)
        ok = await crypto.subtle.verify({ name: 'ECDSA', hash }, publicKey, raw, tbs)
        return !!ok
      } catch {
        return false
      }
    } catch {
      return false
    }
  }

  getExtension<T>(type: new (...args: any[]) => T): T | null {
    // Identify by class requested
    // BasicConstraints OID 2.5.29.19, KeyUsage OID 2.5.29.15
    if (type === BasicConstraintsExtension) {
      const ext = this._cert.extensions?.find((e) => e.extnID === "2.5.29.19")
      if (!ext) return null
      try {
        const parsed: any = (ext as any).parsedValue
        if (parsed) {
          const bc = parsed as BasicConstraints
          const ca = !!bc.cA
          const pathLen = (bc as any).pathLenConstraint?.valueBlock?.valueDec
          return new BasicConstraintsExtension(ca, pathLen) as unknown as T
        }
        // Fallback parse
        const view = ext.extnValue.valueBlock.valueHexView
        const inner = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
        const bc = new BasicConstraints({ schema: fromBER(inner).result })
        const ca = !!bc.cA
        const pathLen = (bc as any).pathLenConstraint?.valueBlock?.valueDec
        return new BasicConstraintsExtension(ca, pathLen) as unknown as T
      } catch {
        return null
      }
    }
    if (type === KeyUsagesExtension) {
      const ext = this._cert.extensions?.find((e) => e.extnID === "2.5.29.15")
      if (!ext) return null
      try {
        const parsed: any = (ext as any).parsedValue
        const bitString: asn1js.BitString | null = parsed instanceof asn1js.BitString ? parsed : null
        if (bitString) {
          const mask = bitArrayToUsageFlags(bitString)
          return new KeyUsagesExtension(mask) as unknown as T
        }
        const view = ext.extnValue.valueBlock.valueHexView
        const inner = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
        const asn1 = fromBER(inner)
        const bs = asn1.result as asn1js.BitString
        const mask = bitArrayToUsageFlags(bs)
        return new KeyUsagesExtension(mask) as unknown as T
      } catch {
        return null
      }
    }
    return null
  }
}

// Re-export classes to match import style
// (classes are already exported above)

