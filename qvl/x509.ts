import { fromBER } from "asn1js"
import {
  Certificate,
  BasicConstraints,
  RelativeDistinguishedNames,
} from "pkijs"
import { toString as u8aToString, fromString as u8aFromString } from "uint8arrays"

// Adapters to be API-compatible with previous code
export class BasicConstraintsExtension {
  public ca: boolean
  public pathLength?: number
  constructor(ca: boolean, pathLength?: number) {
    this.ca = ca
    this.pathLength = pathLength
  }
}

function pemToDerBytes(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "")
  return u8aFromString(b64, "base64pad")
}

function nameToComparableString(name: RelativeDistinguishedNames): string {
  try {
    const parts = (name as any).typesAndValues.map((atv: any) => {
      const oid = atv.type
      const val = String(atv.value.valueBlock.value)
      return `${oid}=${val}`
    })
    return parts.join(",")
  } catch {
    return ""
  }
}

export class QV_X509Certificate {
  private _cert: any
  public rawData: Uint8Array

  constructor(pem: string) {
    const derBytes = pemToDerBytes(pem)
    const asn1 = fromBER(derBytes)
    if (asn1.offset === -1) {
      throw new Error("Failed to parse certificate")
    }
    const cert = new (Certificate as any)({ schema: asn1.result })
    this._cert = cert
    this.rawData = derBytes
  }

  get subject(): string {
    return nameToComparableString(this._cert.subject as any)
  }

  get issuer(): string {
    return nameToComparableString(this._cert.issuer as any)
  }

  get serialNumber(): string {
    // Uppercase hex without leading 0x
    const hex = u8aToString(
      (this._cert.serialNumber as any).valueBlock.valueHexView,
      "hex",
    )
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
    const spki = (this._cert.subjectPublicKeyInfo as any).toSchema().toBER(false)
    return { rawData: spki }
  }

  async verify(issuerCert: QV_X509Certificate): Promise<boolean> {
    try {
      // Determine hash and curve
      const sigOid = (this._cert.signatureAlgorithm as any).algorithmId
      let hash: "SHA-256" | "SHA-384" | "SHA-512" = "SHA-256"
      if (sigOid.includes("1.2.840.10045.4.3.3")) hash = "SHA-384"
      else if (sigOid.includes("1.2.840.10045.4.3.4")) hash = "SHA-512"

      // Named curve from issuer public key
      let namedCurve: "P-256" | "P-384" | "P-521" = "P-256"
      try {
        const params = (issuerCert._cert.subjectPublicKeyInfo as any).algorithm
          .algorithmParams
        const curveOid = params?.valueBlock?.toString?.() || ""
        if (curveOid === "1.3.132.0.34") namedCurve = "P-384"
        else if (curveOid === "1.3.132.0.35") namedCurve = "P-521"
        else namedCurve = "P-256"
      } catch {
        namedCurve = "P-256"
      }

      const curveLen =
        namedCurve === "P-256" ? 32 : namedCurve === "P-384" ? 48 : 66

      const tbs = (this._cert as any).encodeTBS().toBER(false) as ArrayBuffer
      const sigDer = new Uint8Array(
        (this._cert.signatureValue as any).valueBlock.valueHex,
      )
      const spki = (issuerCert._cert.subjectPublicKeyInfo as any)
        .toSchema()
        .toBER(false)
      const publicKey = await crypto.subtle.importKey(
        "spki",
        spki,
        { name: "ECDSA", namedCurve },
        false,
        ["verify"],
      )

      // Try verifying with DER signature directly
      let ok = false
      try {
        ok = await crypto.subtle.verify(
          { name: "ECDSA", hash },
          publicKey,
          sigDer,
          tbs,
        )
      } catch {
        ok = false
      }
      if (ok) return true

      // Fallback: convert DER -> raw (r||s)
      try {
        const asn1sig = fromBER(sigDer)
        const seq = asn1sig.result as any
        const r: Uint8Array = new Uint8Array(
          seq.valueBlock.value[0].valueBlock.valueHex,
        )
        const s: Uint8Array = new Uint8Array(
          seq.valueBlock.value[1].valueBlock.valueHex,
        )
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
        ok = await crypto.subtle.verify(
          { name: "ECDSA", hash },
          publicKey,
          raw,
          tbs,
        )
        return !!ok
      } catch {
        return false
      }
    } catch {
      return false
    }
  }

  getExtension<T>(type: new (...args: any[]) => T): T | null {
    // Support BasicConstraints extension
    // OID 2.5.29.19, KeyUsage OID 2.5.29.15
    if (type === BasicConstraintsExtension) {
      const ext = (this._cert.extensions as any)?.find(
        (e: any) => e.extnID === "2.5.29.19",
      )
      if (!ext) return null
      try {
        const parsed = ext.parsedValue
        if (parsed) {
          const bc = parsed as any
          const ca = !!bc.cA
          const pathLen =
            typeof bc.pathLenConstraint === "number"
              ? bc.pathLenConstraint
              : bc.pathLenConstraint?.valueBlock?.valueDec
          return new (BasicConstraintsExtension as any)(
            ca,
            pathLen,
          ) as unknown as T
        }
        // Fallback parse
        const view = ext.extnValue.valueBlock.valueHexView
        const innerView = new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        )
        const bc = new (BasicConstraints as any)({ schema: fromBER(innerView).result })
        const ca = !!bc.cA
        const pathLen =
          typeof bc.pathLenConstraint === "number"
            ? bc.pathLenConstraint
            : bc.pathLenConstraint?.valueBlock?.valueDec
        return new (BasicConstraintsExtension as any)(
          ca,
          pathLen,
        ) as unknown as T
      } catch {
        return null
      }
    }
    return null
  }
}
