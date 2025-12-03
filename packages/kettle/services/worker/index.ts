export { getDb } from "./db.js"
export { serveStatic } from "./static.js"
export type { Env } from "./worker.js"

// Shared helper functions
import { base64 } from "@scure/base"
import type { QuoteData } from "@teekit/tunnel"

export async function getQuoteFromService(x25519PublicKey: Uint8Array): Promise<QuoteData> {
  const QUOTE_SERVICE_URL = "http://127.0.0.1:3002"
    
  const response = await fetch(`${QUOTE_SERVICE_URL}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: Array.from(x25519PublicKey),
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `[kettle] Failed to get quote from service: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }

  const quoteData = await response.json()
  return {
    quote: base64.decode(quoteData.quote),
    verifier_data: quoteData.verifier_data
      ? {
          iat: base64.decode(quoteData.verifier_data.iat),
          val: base64.decode(quoteData.verifier_data.val),
          signature: quoteData.verifier_data.signature
            ? base64.decode(quoteData.verifier_data.signature)
            : undefined,
        }
      : undefined,
    runtime_data: quoteData.runtime_data
      ? base64.decode(quoteData.runtime_data)
      : undefined,
  }
}
