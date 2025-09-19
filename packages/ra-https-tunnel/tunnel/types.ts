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
  headers: Record<string, string>
  body: string
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
  data: string
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

// Sent by the tunnel server to announce its key exchange public key.
export type ControlChannelKXAnnounce = {
  type: "server_kx"
  x25519PublicKey: string // base64
}

// Sent by the client to deliver a symmetric key sealed to the server pubkey.
export type ControlChannelKXConfirm = {
  type: "client_kx"
  sealedSymmetricKey: string // base64
}

// Encrypted envelope carrying any tunneled payload after handshake.
// The contents (ciphertext) are a JSON-encoded payload of the original
// tunnel message types, encrypted with XSalsa20-Poly1305 via crypto_secretbox.
export type ControlChannelEncryptedMessage = {
  type: "enc"
  nonce: string // base64
  ciphertext: string // base64
}
