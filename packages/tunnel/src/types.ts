import type { Express } from "express"
import type { Hono } from "hono"

export type TunnelApp = Express | Hono<any, any, any>

/** Used by trustauthority-cli to bind the public keys we provide to report_data. */
export type VerifierData = {
  val: Uint8Array
  iat: Uint8Array
  signature?: Uint8Array
}

/** Quote package including Intel VerifierData. */
export type QuoteData = {
  quote: Uint8Array
  verifier_data?: VerifierData
  runtime_data?: Uint8Array
}

/** SEV-SNP quote data. SEV-SNP reports don't embed certificates. */
export type SevSnpQuoteData = {
  quote: Uint8Array
  vcek_cert: string // required
  ask_cert?: string // optional, defaults to embedded ASK
  ark_cert?: string // optional, defaults to embedded Milan ARK
  nonce?: Uint8Array
}

export type SevSnpKXAnnounceData = {
  vcek_cert: string
  ask_cert?: string | null
  ark_cert?: string | null
}

/**
 * Encrypted channel WebSocket payloads.
 */

export type RAEncryptedHTTPRequest = {
  type: "http_request"
  requestId: string
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  timeout?: number
}

export type RAEncryptedHTTPResponse = {
  type: "http_response"
  requestId: string
  status: number
  statusText: string
  headers: Record<string, string | string[]>
  body: string | Uint8Array
  error?: string
}

export type RAEncryptedClientConnectEvent = {
  type: "ws_connect"
  connectionId: string
  url: string
  protocols?: string[]
}

export type RAEncryptedClientCloseEvent = {
  type: "ws_close"
  connectionId: string
  code?: number
  reason?: string
}

export type RAEncryptedWSMessage = {
  type: "ws_message"
  connectionId: string
  data: string | Uint8Array
  dataType: "string" | "arraybuffer"
}

export type RAEncryptedServerEvent = {
  type: "ws_event"
  connectionId: string
  eventType: "open" | "close" | "error"
  code?: number
  reason?: string
  error?: string
}

export type RAEncryptedMessage =
  | RAEncryptedHTTPRequest
  | RAEncryptedHTTPResponse
  | RAEncryptedClientConnectEvent
  | RAEncryptedClientCloseEvent
  | RAEncryptedWSMessage
  | RAEncryptedServerEvent

// Sent by the tunnel client to trigger initialization on servers
// where onOpen is unreliable.
export type ControlChannelKXClientReady = {
  type: "client_kx_ready"
}

// Sent by the tunnel server to announce its key exchange public key.
export type ControlChannelKXAnnounce = {
  type: "server_kx"
  x25519PublicKey: Uint8Array
  quote: Uint8Array
  runtime_data: Uint8Array | null // used for TDX
  verifier_data: VerifierData | null
  sev_snp_data?: SevSnpKXAnnounceData | null // used for SEV-SNP cert chain
}

// Sent by the client to deliver a symmetric key sealed to the server pubkey.
export type ControlChannelKXConfirm = {
  type: "client_kx"
  sealedSymmetricKey: Uint8Array
}

// Encrypted envelope carrying any tunneled payload after handshake.
// The contents (ciphertext) are a CBOR-encoded payload of the original
// tunnel message types, encrypted with XSalsa20-Poly1305 via crypto_secretbox.
export type ControlChannelEncryptedMessage = {
  type: "enc"
  nonce: Uint8Array
  ciphertext: Uint8Array
}
