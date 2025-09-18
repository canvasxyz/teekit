export * from "./formatters.js"
export * from "./structs.js"
export * from "./utils.js"
export * from "./verifyTdx.js"
export * from "./verifySgx.js"
export type * from "./verifyTdx.js"
export type * from "./verifySgx.js"
import { cryptoProvider } from "@peculiar/x509"
import { Crypto } from "@peculiar/webcrypto"

// Initialize WebCrypto provider for @peculiar/x509 in Node.js and browsers
try {
  const anyGlobal = globalThis as any
  const hasSubtle = !!(anyGlobal.crypto && anyGlobal.crypto.subtle)
  if (!hasSubtle) {
    const webcrypto = new Crypto()
    ;(anyGlobal as any).crypto = webcrypto as unknown as Crypto
    cryptoProvider.set(webcrypto as unknown as Crypto)
  } else {
    // Use existing global crypto (browser/Node >=19), but ensure x509 uses it
    cryptoProvider.set(anyGlobal.crypto as Crypto)
  }
} catch {
  // Best-effort init; consumers can call set again if they replace crypto
}
