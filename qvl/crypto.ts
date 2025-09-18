import { cryptoProvider } from "@peculiar/x509"

/**
 * Ensure a WebCrypto SubtleCrypto instance is available and bound to @peculiar/x509.
 * In Node.js, installs @peculiar/webcrypto. In browsers, uses the native crypto.
 */
export async function ensureSubtle(): Promise<SubtleCrypto> {
  const g = globalThis as any
  if (!g.crypto || !g.crypto.subtle) {
    const { Crypto } = await import("@peculiar/webcrypto")
    const polyfill = new Crypto()
    g.crypto = polyfill as any
  }
  // Bind provider for @peculiar/x509 to use this crypto
  cryptoProvider.set(g.crypto)
  return g.crypto.subtle as SubtleCrypto
}

