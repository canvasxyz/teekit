## RA HTTPS Tunnel – Developer Guide

### What this is
An encrypted, remote‑attested tunnel that exposes:
- Encrypted HTTP requests via a `fetch`-compatible client API
- Encrypted WebSockets via a browser-like `WebSocket` client API

The tunnel performs a key exchange and attestation check before allowing any traffic. After the handshake, all payloads are CBOR-encoded and encrypted with XSalsa20‑Poly1305 (libsodium `crypto_secretbox`).

Package name to import in code: `ra-https-tunnel`.

### How it works (high level)
1. Client opens a control WebSocket to the server at `ws(s)://<host>:<port>/__ra__`.
2. Server immediately sends `server_kx` with an X25519 public key and a TDX/SGX attestation quote.
3. Client verifies the quote (using `ra-https-qvl`), optionally enforces `mrtd`/`report_data` or a custom matcher, generates a symmetric key, and sends it sealed to the server via `client_kx` (libsodium `crypto_box_seal`).
4. All subsequent messages are encrypted envelopes `{ type: "enc", nonce, ciphertext }` carrying tunneled HTTP and WebSocket messages.

---

## Quick start

### Server (Node, Express)
```ts
import express from "express"
import { TunnelServer } from "ra-https-tunnel"
// Obtain a TDX/SGX attestation quote as a Uint8Array
// e.g. from your TEE runtime or test helper

async function main() {
  const app = express()
  app.get("/hello", (_req, res) => res.status(200).send("world"))

  const quote: Uint8Array = /* load from your TEE */
  const tunnelServer = await TunnelServer.initialize(app, quote)

  // Optional: WebSocket support via the built-in mock server
  tunnelServer.wss.on("connection", (ws) => {
    ws.on("message", (data: any) => ws.send(data))
  })

  tunnelServer.server.listen(3000, () => {
    console.log("RA HTTPS Tunnel listening on :3000")
  })
}

main()
```

### Client (browser or Node 20.11+)
```ts
import { TunnelClient } from "ra-https-tunnel"
import { hex, parseTdxQuote } from "ra-https-qvl"

async function run() {
  const origin = "http://127.0.0.1:3000"

  // You can validate against expected mrtd/report_data or provide a custom matcher.
  // Below shows fixed values; compute these from an expected quote if you have one.
  const expectedMrtd = /* hex string */
  const expectedReportData = /* hex string */

  const client = await TunnelClient.initialize(origin, {
    mrtd: expectedMrtd,
    report_data: expectedReportData,
    // sgx: true // set if the server quote is SGX; defaults to TDX otherwise
  })

  // HTTP over tunnel
  const res = await client.fetch("/hello")
  console.log(await res.text()) // "world"

  // WebSocket over tunnel
  const TunnelWS = client.WebSocket
  const ws = new TunnelWS(origin.replace(/^http/, "ws"))
  ws.addEventListener("open", () => ws.send("ping"))
  ws.addEventListener("message", (evt: any) => console.log(String(evt.data)))
}

run()
```

---

## HTTP over the tunnel
- Use `client.fetch(resource, init?)` where `resource` can be a string path (e.g. `"/route"`), a full URL, or a `Request` object.
- `init.headers` accepts a `Headers` instance, an array of tuples, or a plain object.
- Request bodies supported: string, `Uint8Array`, `ArrayBuffer`, and `ReadableStream` (if supported by the runtime). Form data is not automatically encoded; send a prebuilt multipart string when needed.
- Responses come back as a standard `Response`. Use `text()`, `json()`, or `arrayBuffer()`.
- A single `TunnelClient` reuses one encrypted control channel; each `fetch` is multiplexed over it.

Notes:
- Requests time out after 30s (hard-coded). If a response is not received, the promise rejects with `Error("Request timeout")`.
- Server-side streaming responses are buffered and delivered as a complete body (no incremental client streaming).

---

## WebSockets over the tunnel
- Use `const TunnelWS = client.WebSocket; const ws = new TunnelWS(url, protocols?)`.
- The target WebSocket URL must use the same host and port as the client’s `origin` passed to `TunnelClient.initialize`. A port mismatch triggers a client error and the socket stays in CONNECTING.
- Events and properties supported: `onopen`, `onmessage`, `onclose`, `onerror`, `readyState`, `bufferedAmount`, `binaryType`, `addEventListener/removeEventListener`.
- `send(...)` accepts strings and binary data (`ArrayBuffer`, `ArrayBufferView` like `Uint8Array`/`DataView`). `Blob` is not supported.
- Messages from server arrive as `string` when data is likely text; otherwise as `ArrayBuffer`.
- Messages queued before `open` are automatically flushed once the socket opens.

On the server side, use `tunnelServer.wss` just like a typical `ws` server:
```ts
tunnelServer.wss.on("connection", (ws) => {
  ws.on("message", (data: any) => ws.send(data))
  ws.on("close", (code: number, reason: string) => {
    console.log("closed", code, reason)
  })
})
```

---

## Attestation and security
- Handshake messages:
  - `server_kx`: `{ type: "server_kx", x25519PublicKey: base64, quote: base64 }`
  - `client_kx`: `{ type: "client_kx", sealedSymmetricKey: base64 }`
  - After handshake: `{ type: "enc", nonce: Uint8Array, ciphertext: Uint8Array }`
- Client verification (TDX default; set `sgx: true` for SGX):
  - Verifies quote using `ra-https-qvl` (`verifyTdx`/`verifySgx`).
  - Optional enforcement via config:
    - `mrtd`: expected measurement as hex (TDX: `mr_td`, SGX: `mr_enclave`)
    - `report_data`: expected `report_data` as hex
    - `match(quote)`: custom predicate for additional checks
- Crypto:
  - Symmetric key generated client-side and sealed to server X25519 pubkey with `crypto_box_seal`.
  - Payloads encrypted with `crypto_secretbox_easy` (XSalsa20‑Poly1305) and CBOR-encoded.
  - Server drops plaintext messages both before and after handshake.
- Key lifecycle & reconnects:
  - If the control WebSocket closes, client clears the symmetric key and will attempt to reconnect after 1s; a new handshake runs on reconnect.

Security considerations:
- If you omit `mrtd`, `report_data`, and `match`, the client still verifies the quote is valid, but it won’t pin to an expected identity.
- One keypair is generated per server process; there’s no session resumption across processes. Use sticky sessions if load balancing.

---

## Operational considerations and limitations
- Control channel path is reserved at `/__ra__`.
- All WebSocket upgrades to the HTTP server (other than `/__ra__`) are rejected. Application WebSockets must use `tunnelServer.wss`.
- Client WebSocket targets must use the same port as the tunnel `origin`.
- HTTP request/response bodies are buffered end-to-end; very large payloads will increase memory usage.
- Default client request timeout is 30s and not currently configurable.
- Client `WebSocket.send` does not accept `Blob`.
- Client `fetch` does not natively serialize `FormData`; send a prepared multipart string if needed.
- Runtime requirements:
  - Server: Node.js with `ws` installed (handled by this package), libsodium ready.
  - Client: Browser with standard `WebSocket`, or Node 20.11+ where `WebSocket` is available globally. `fetch`/`Response` should be present (Node 18+ or a polyfill).

---

## API summary

### Imports
```ts
import {
  TunnelServer,
  TunnelClient,
  ServerRAMockWebSocket,
  ServerRAMockWebSocketServer,
  ClientRAMockWebSocket,
} from "ra-https-tunnel"
```

### TunnelServer
- `static initialize(app: Express, quote: Uint8Array): Promise<TunnelServer>`
  - Creates the HTTP server, control WebSocket server, and in-memory WS server (`wss`).
- Properties:
  - `server: http.Server` – call `server.listen(...)` to bind a port.
  - `wss: ServerRAMockWebSocketServer` – emit `"connection"` and manage `ServerRAMockWebSocket` clients.
- Methods:
  - `logWebSocketConnections(): void` – logs connection states and key presence (debug utility).

### TunnelClient
- `static initialize(origin: string, config: TunnelClientConfig): Promise<TunnelClient>`
  - `origin`: `http(s)://host:port` that your server listens on.
  - `config`: `{ mrtd?: string; report_data?: string; match?: (quote) => boolean; sgx?: boolean }`.
- `ensureConnection(): Promise<void>` – opens control channel and completes handshake if needed.
- `fetch(input, init?): Promise<Response>` – tunneling HTTP API; mirrors the standard Fetch signature for common cases.
- `WebSocket: typeof ClientRAMockWebSocket` – class to `new` for tunneled WebSockets.
- Properties:
  - `ws: WebSocket | null` – the underlying control channel (not for app traffic).

### Message and envelope types (informational)
- HTTP:
  - Request `{ type: "http_request", requestId, method, url, headers, body? }`
  - Response `{ type: "http_response", requestId, status, statusText, headers, body, error? }`
- WebSocket:
  - Client connect `{ type: "ws_connect", connectionId, url, protocols? }`
  - Client close `{ type: "ws_close", connectionId, code?, reason? }`
  - Message `{ type: "ws_message", connectionId, data, dataType: "string" | "arraybuffer" }`
  - Server event `{ type: "ws_event", connectionId, eventType: "open" | "close" | "error", code?, reason?, error? }`
- Control channel:
  - `server_kx`, `client_kx`, and post-handshake `{ type: "enc", nonce, ciphertext }`

---

## Troubleshooting
- Client WebSocket never opens and an `error` event fires immediately:
  - Ensure the target WS URL uses the same port as the client `origin`.
- `Request timeout` after 30 seconds:
  - Server handler may not be responding; confirm your Express route returns a response and that the tunnel server is running.
- Seeing plaintext messages on the wire:
  - Only `server_kx` and `client_kx` are plaintext; everything else must be `{ type: "enc", ... }`.
- `Blob` not supported when sending through WebSocket:
  - Convert to `ArrayBuffer`/`Uint8Array` first.

---

## Examples in this repo
- See `packages/tunnel/test/*.test.ts` for comprehensive HTTP and WebSocket examples.
- Minimal end-to-end demo app is under `packages/demo`.

