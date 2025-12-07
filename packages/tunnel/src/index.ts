export { TunnelServer } from "./server.js"
export { TunnelClient } from "./client.js"

// Mocks for typing
export {
  ServerRAMockWebSocket,
  ServerRAMockWebSocketServer,
} from "./ServerRAWebSocket.js"
export { ClientRAMockWebSocket } from "./ClientRAWebSocket.js"

// Express middleware for enforcing encryption
export {
  encryptedOnly,
  isEncryptedRequest,
  ENCRYPTED_REQUEST,
} from "./encryptedOnly.js"

// Hono middleware for enforcing encryption
export { encryptedOnlyHono } from "./encryptedOnlyHono.js"

export type {
  IntelQuoteData as IntelQuoteData,
  SevSnpQuoteData,
  VerifierNonce,
} from "./types.js"

// Sample quotes for testing
export {
  tappdV4Base64,
  sevSnpGcpX25519Base64,
  sevSnpGcpVcekPem,
  sevSnpGcpAskPem,
  sevSnpGcpArkPem,
  sevSnpGcpX25519Nonce,
} from "./samples.js"
