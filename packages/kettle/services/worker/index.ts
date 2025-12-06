export { getDb } from "./db.js"
export { serveStatic } from "./static.js"
export type { Env } from "./worker.js"

// Shared helper functions
import { base64 } from "@scure/base"
import type { IntelQuoteData, SevSnpQuoteData } from "@teekit/tunnel"

interface FetcherLike {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>
}

export async function getQuoteFromService(
  x25519PublicKey: Uint8Array,
  env?: unknown,
): Promise<IntelQuoteData | SevSnpQuoteData> {
  let response: Response

  const quoteService = (env as { QUOTE_SERVICE?: FetcherLike } | undefined)
    ?.QUOTE_SERVICE
  if (quoteService) {
    // Use the QUOTE_SERVICE binding (required in workerd)
    response = await quoteService.fetch(
      new Request("http://quote-service/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey: Array.from(x25519PublicKey),
        }),
      }),
    )
  } else {
    // Fallback to direct fetch (for Node.js environments)
    const QUOTE_SERVICE_URL = "http://127.0.0.1:3002"
    response = await fetch(`${QUOTE_SERVICE_URL}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: Array.from(x25519PublicKey),
      }),
    })
  }

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `[kettle] Failed to get quote from service: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }

  const quoteData = await response.json()

  // Check if this is SEV-SNP quote data (has vcek_cert)
  if (quoteData.vcek_cert) {
    return {
      quote: base64.decode(quoteData.quote),
      vcek_cert: quoteData.vcek_cert,
      ask_cert: quoteData.ask_cert,
      ark_cert: quoteData.ark_cert,
      nonce: quoteData.nonce ? base64.decode(quoteData.nonce) : undefined,
    }
  }

  // TDX quote data
  return {
    quote: base64.decode(quoteData.quote),
    verifier_data: quoteData.verifier_data
      ? {
          iat: base64.decode(quoteData.verifier_data.iat),
          val: base64.decode(quoteData.verifier_data.val),
          signature: base64.decode(quoteData.verifier_data.signature),
        }
      : undefined,
    runtime_data: quoteData.runtime_data
      ? base64.decode(quoteData.runtime_data)
      : undefined,
  }
}
