export type TunnelHTTPRequest = {
  type: "http_request"
  requestId: string
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  timeout?: number
}

export type TunnelHTTPResponse = {
  type: "http_response"
  requestId: string
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  error?: string
}

export type TunnelWSClientConnect = {
  type: "ws_connect"
  connectionId: string
  url: string
  protocols?: string[]
}

export type TunnelWSClientClose = {
  type: "ws_close"
  connectionId: string
  code?: number
  reason?: string
}

export type TunnelWSMessage = {
  type: "ws_message"
  connectionId: string
  data: string
  dataType: "string" | "arraybuffer"
}

export type TunnelWSServerEvent = {
  type: "ws_event"
  connectionId: string
  eventType: "open" | "close" | "error"
  code?: number
  reason?: string
  error?: string
}

// Sent by the tunnel server to announce its key exchange public key.
// The public key is X25519, base64-encoded.
export type TunnelServerKX = {
  type: "server_kx"
  x25519PublicKey: string
}

// Sent by the client to deliver a symmetric key sealed to the server pubkey.
export type TunnelClientKX = {
  type: "client_kx"
  sealedSymmetricKey: string
}

// Encrypted envelope used for all tunneled messages after handshake
export type EncryptedEnvelope = {
  type: "enc"
  nonce: string
  box: string
}
