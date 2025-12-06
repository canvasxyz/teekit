import { fromBER } from "asn1js"
import {
  Certificate,
  BasicConstraints,
  RelativeDistinguishedNames,
} from "pkijs"
import { base64 as scureBase64, hex as scureHex } from "@scure/base"

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
  return scureBase64.decode(b64)
}

function nameToX509ComparableString(name: RelativeDistinguishedNames): string {
  try {
    const parts = name.typesAndValues.map((atv) => {
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
  private _cert: Certificate
  public rawData: Uint8Array

  constructor(pem: string) {
    const derBytes = pemToDerBytes(pem)
    const asn1 = fromBER(derBytes)
    if (asn1.offset === -1) {
      throw new Error("Failed to parse certificate")
    }
    const cert = new Certificate({ schema: asn1.result })
    this._cert = cert
    this.rawData = derBytes
  }

  get subject(): string {
    return nameToX509ComparableString(this._cert.subject)
  }

  get issuer(): string {
    return nameToX509ComparableString(this._cert.issuer)
  }

  get serialNumber(): string {
    // Uppercase hex without leading 0x
    const value = this._cert.serialNumber.valueBlock.valueHexView
    const s = scureHex.encode(value)
    return s.toUpperCase()
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

  async verify(issuerCert: QV_X509Certificate): Promise<boolean> {
    try {
      const sigOid = this._cert.signatureAlgorithm.algorithmId
      const tbs = this._cert.encodeTBS().toBER(false) as ArrayBuffer
      const sigBytes = new Uint8Array(
        this._cert.signatureValue.valueBlock.valueHex,
      )
      const spki = issuerCert._cert.subjectPublicKeyInfo.toSchema().toBER(false)

      // Check if this is RSA-PSS (OID 1.2.840.113549.1.1.10)
      if (sigOid === "1.2.840.113549.1.1.10") {
        return await this._verifyRsaPss(tbs, sigBytes, spki)
      }

      // Check if this is RSASSA-PKCS1-v1_5
      if (sigOid.startsWith("1.2.840.113549.1.1.")) {
        return await this._verifyRsaPkcs1(sigOid, tbs, sigBytes, spki)
      }

      // Otherwise assume ECDSA
      return await this._verifyEcdsa(sigOid, tbs, sigBytes, spki, issuerCert)
    } catch {
      return false
    }
  }

  private async _verifyRsaPss(
    tbs: ArrayBuffer,
    sigBytes: Uint8Array,
    spki: ArrayBuffer,
  ): Promise<boolean> {
    try {
      // Parse RSA-PSS parameters from signatureAlgorithm
      const params = this._cert.signatureAlgorithm.algorithmParams
      let hash: "SHA-256" | "SHA-384" | "SHA-512" = "SHA-384" // AMD default
      let saltLength = 48 // Default for SHA-384

      if (params) {
        // Parse the RSA-PSS-params ASN.1 structure
        try {
          const paramsView = params.valueBeforeDecodeView || params.valueBeforeDecode
          if (paramsView) {
            const bytes = paramsView instanceof ArrayBuffer
              ? new Uint8Array(paramsView)
              : new Uint8Array(paramsView.buffer, paramsView.byteOffset, paramsView.byteLength)
            const decoded = fromBER(bytes)
            if (decoded.offset !== -1) {
              const seq = decoded.result as any
              const entries = Array.isArray(seq.valueBlock?.value) ? seq.valueBlock.value : []
              for (const entry of entries) {
                if (entry.idBlock?.tagClass !== 3) continue
                const tagNo = entry.idBlock.tagNumber
                const inner = entry.valueBlock?.value?.[0]
                if (!inner) continue
                if (tagNo === 0) {
                  // Hash algorithm [0]
                  const oidNode = inner.valueBlock?.value?.[0]
                  const oid = oidNode?.valueBlock?.toString?.() || ""
                  if (oid === "2.16.840.1.101.3.4.2.1") { hash = "SHA-256"; saltLength = 32 }
                  else if (oid === "2.16.840.1.101.3.4.2.2") { hash = "SHA-384"; saltLength = 48 }
                  else if (oid === "2.16.840.1.101.3.4.2.3") { hash = "SHA-512"; saltLength = 64 }
                } else if (tagNo === 2) {
                  // Salt length [2]
                  const intNode = inner.valueBlock?.value?.[0] ?? inner
                  const value = intNode?.valueBlock?.valueDec ?? inner.valueBlock?.valueDec
                  if (typeof value === "number") saltLength = value
                }
              }
            }
          }
        } catch {
          // Use defaults
        }
      }

      const publicKey = await crypto.subtle.importKey(
        "spki",
        spki,
        { name: "RSA-PSS", hash },
        false,
        ["verify"],
      )

      return await crypto.subtle.verify(
        { name: "RSA-PSS", saltLength },
        publicKey,
        sigBytes as BufferSource,
        tbs,
      )
    } catch {
      return false
    }
  }

  private async _verifyRsaPkcs1(
    sigOid: string,
    tbs: ArrayBuffer,
    sigBytes: Uint8Array,
    spki: ArrayBuffer,
  ): Promise<boolean> {
    try {
      let hash: "SHA-256" | "SHA-384" | "SHA-512" = "SHA-256"
      if (sigOid === "1.2.840.113549.1.1.11") hash = "SHA-256"
      else if (sigOid === "1.2.840.113549.1.1.12") hash = "SHA-384"
      else if (sigOid === "1.2.840.113549.1.1.13") hash = "SHA-512"

      const publicKey = await crypto.subtle.importKey(
        "spki",
        spki,
        { name: "RSASSA-PKCS1-v1_5", hash },
        false,
        ["verify"],
      )

      return await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        sigBytes as BufferSource,
        tbs,
      )
    } catch {
      return false
    }
  }

  private async _verifyEcdsa(
    sigOid: string,
    tbs: ArrayBuffer,
    sigDer: Uint8Array,
    spki: ArrayBuffer,
    issuerCert: QV_X509Certificate,
  ): Promise<boolean> {
    try {
      // Determine hash
      let hash: "SHA-256" | "SHA-384" | "SHA-512" = "SHA-256"
      if (sigOid.includes("1.2.840.10045.4.3.3")) hash = "SHA-384"
      else if (sigOid.includes("1.2.840.10045.4.3.4")) hash = "SHA-512"

      // Named curve from issuer public key
      let namedCurve: "P-256" | "P-384" | "P-521" = "P-256"
      try {
        const params =
          issuerCert._cert.subjectPublicKeyInfo.algorithm.algorithmParams
        const curveOid = params?.valueBlock?.toString?.() || ""
        if (curveOid === "1.3.132.0.34") namedCurve = "P-384"
        else if (curveOid === "1.3.132.0.35") namedCurve = "P-521"
        else namedCurve = "P-256"
      } catch {
        namedCurve = "P-256"
      }

      const curveLen =
        namedCurve === "P-256" ? 32 : namedCurve === "P-384" ? 48 : 66

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
          sigDer as BufferSource,
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
      const ext = this._cert.extensions?.find((e) => e.extnID === "2.5.29.19")
      if (!ext) return null
      try {
        const parsed = ext.parsedValue
        if (parsed) {
          const bc = parsed as BasicConstraints
          const ca = !!bc.cA
          const pathLen =
            typeof bc.pathLenConstraint === "number"
              ? bc.pathLenConstraint
              : bc.pathLenConstraint?.valueBlock?.valueDec
          return new BasicConstraintsExtension(ca, pathLen) as unknown as T
        }
        // Fallback parse
        const view = ext.extnValue.valueBlock.valueHexView
        const innerView = new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        )
        const bc = new BasicConstraints({ schema: fromBER(innerView).result })
        const ca = !!bc.cA
        const pathLen =
          typeof bc.pathLenConstraint === "number"
            ? bc.pathLenConstraint
            : bc.pathLenConstraint?.valueBlock?.valueDec
        return new BasicConstraintsExtension(ca, pathLen) as unknown as T
      } catch {
        return null
      }
    }
    return null
  }

  /**
   * Extract the Intel FMSPC (6 bytes) from the PCK certificate extension.
   * Intel SGX/TDX PCK certificates carry FMSPC under OID 1.2.840.113741.1.13.1.4
   * Returns an uppercase 12-hex-character string, or null if not present.
   */
  getFmspcHex(): string | null {
    try {
      const oid = "1.2.840.113741.1.13.1"
      const ext = this._cert.extensions?.find((e) => e.extnID === oid)
      if (!ext) return null

      // Decode the Intel SGX extension, which is a DER-encoded sequence:
      const outerView = ext.extnValue.valueBlock.valueHexView
      const inner = new Uint8Array(
        outerView.buffer,
        outerView.byteOffset,
        outerView.byteLength,
      )
      const decoded = fromBER(inner)
      if (decoded.offset === -1) return null

      const seq: any = decoded.result
      const children = Array.isArray(seq?.valueBlock?.value)
        ? seq.valueBlock.value
        : []

      // Iterate over extensions to find FMSPC.
      for (const entry of children) {
        const parts: any[] = Array.isArray(entry?.valueBlock?.value)
          ? entry.valueBlock.value
          : []
        if (parts.length < 2) continue

        const subOid = parts[0]?.valueBlock?.toString?.()
        if (subOid !== "1.2.840.113741.1.13.1.4") continue

        // Extract the value bytes for FMSPC (expected 6 bytes)
        const valueNode: any = parts[1]
        let bytes: Uint8Array | null = null

        // Direct primitive value
        const direct = valueNode?.valueBlock?.valueHex
        if (direct && direct.byteLength !== undefined) {
          bytes = new Uint8Array(direct)
          return scureHex.encode(bytes)
        }
      }

      // Return if we didn't find anything.
      return null
    } catch {
      return null
    }
  }

  /**
   * Extract the PCESVN value from the PCK certificate extension.
   * Intel SGX/TDX PCK certificates carry PCESVN under OID 1.2.840.113741.1.13.1.2.17
   * (nested within the TCB sub-extension 1.2.840.113741.1.13.1.2)
   * Returns the PCESVN as a number, or null if not present.
   */
  getPcesvn(): number | null {
    try {
      const oid = "1.2.840.113741.1.13.1"
      const ext = this._cert.extensions?.find((e) => e.extnID === oid)
      if (!ext) return null

      // Decode the Intel SGX extension, which is a DER-encoded sequence:
      const outerView = ext.extnValue.valueBlock.valueHexView
      const inner = new Uint8Array(
        outerView.buffer,
        outerView.byteOffset,
        outerView.byteLength,
      )
      const decoded = fromBER(inner)
      if (decoded.offset === -1) return null

      const seq: any = decoded.result
      const children = Array.isArray(seq?.valueBlock?.value)
        ? seq.valueBlock.value
        : []

      // First find the TCB sub-extension (1.2.840.113741.1.13.1.2)
      for (const entry of children) {
        const parts: any[] = Array.isArray(entry?.valueBlock?.value)
          ? entry.valueBlock.value
          : []
        if (parts.length < 2) continue

        const subOid = parts[0]?.valueBlock?.toString?.()
        if (subOid !== "1.2.840.113741.1.13.1.2") continue

        // The TCB extension is a SEQUENCE containing more sub-extensions
        const tcbValueNode: any = parts[1]
        const tcbChildren = Array.isArray(tcbValueNode?.valueBlock?.value)
          ? tcbValueNode.valueBlock.value
          : []

        // Now look for PCESVN (1.2.840.113741.1.13.1.2.17)
        for (const tcbEntry of tcbChildren) {
          const tcbParts: any[] = Array.isArray(tcbEntry?.valueBlock?.value)
            ? tcbEntry.valueBlock.value
            : []
          if (tcbParts.length < 2) continue

          const tcbOid = tcbParts[0]?.valueBlock?.toString?.()
          if (tcbOid !== "1.2.840.113741.1.13.1.2.17") continue

          // Extract the value bytes for PCESVN (expected 1 byte for integer value)
          const pcesvnValueNode: any = tcbParts[1]
          const pcesvnBytes = pcesvnValueNode?.valueBlock?.valueHex
          if (pcesvnBytes && pcesvnBytes.byteLength !== undefined) {
            const bytes = new Uint8Array(pcesvnBytes)
            if (bytes.length === 1) {
              return bytes[0]
            } else if (bytes.length === 2) {
              // In case it's encoded as 2 bytes, decode it as a little-endian integer
              return bytes[0] | (bytes[1] << 8)
            }
          }
        }
      }

      return null
    } catch {
      return null
    }
  }
}
