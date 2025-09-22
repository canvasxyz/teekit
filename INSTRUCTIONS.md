## Remote-Attested Encrypted Tunnel – Developer Guide

This guide explains how to use the tunnel in `packages/tunnel` to expose an Express app over an encrypted, remote‑attested channel, and how to consume it from a client using an attested, symmetric‑key–encrypted control WebSocket. It also lists important considerations/limitations and summarizes the API surface.

### What it is
- **Server (`TunnelServer`)**: Wraps an Express app behind a control WebSocket (`/__ra__`) that performs attestation, establishes a symmetric key (XSalsa20‑Poly1305), decrypts inbound requests, executes your Express routes, and encrypts responses. It also exposes a mock `WebSocketServer` (`tunnelServer.wss`) you can use like a normal `ws` server—messages are encrypted/decrypted in flight.
- **Client (`TunnelClient`)**: Connects to the server’s control WebSocket, verifies the TDX/SGX quote, performs key exchange, and then provides `fetch` and a `WebSocket` class that tunnel all traffic over the encrypted channel.


## Installation

```bash
npm install ra-https-tunnel ra-https-qvl libsodium-wrappers
```

Notes:
- The client and server both use `libsodium-wrappers`.
- Quote verification uses `ra-https-qvl`.


## Server: wrap an Express app

```ts
import express from "express"
import { TunnelServer } from "ra-https-tunnel"

// Load or provision a TDX/SGX quote (Uint8Array)
import { loadQuote } from "./your-quote-loader"

const app = express()
// Define your routes as usual
app.get("/hello", (_req, res) => res.status(200).send("world"))

const quote = loadQuote({ /* sgx?: true | tdxv4?: true | tdxv5?: true */ })
const tunnelServer = await TunnelServer.initialize(app, quote)

// Start listening
tunnelServer.server.listen(8080, () => {
  console.log("Tunnel server listening on :8080")
})

// WebSockets (mock server that your app uses like ws)
tunnelServer.wss.on("connection", (ws) => {
  ws.send("hello")
  ws.on("message", (data: any) => ws.send(data))
})
```

Key points:
- The control channel WebSocket is mounted at the reserved path `"/__ra__"` on the same HTTP server. Only this upgrade path is accepted; other native WebSocket upgrades are rejected. Use `tunnelServer.wss` for your app’s WS needs.
- You must call `tunnelServer.server.listen(...)` to start the HTTP server.


## Client: attested encrypted channel

```ts
import { TunnelClient } from "ra-https-tunnel"
import { hex, parseTdxQuote } from "ra-https-qvl"

// The origin of your tunnel server (http/https). The client will use ws/wss
const origin = "http://127.0.0.1:8080"

// Configure attestation checks:
//  - Provide mrtd/report_data to pin values
//  - Or provide a custom match(quote) predicate
const client = await TunnelClient.initialize(origin, {
  mrtd: "<hex-encoded-mrtd>",
  report_data: "<hex-encoded-report-data>",
  // sgx: true, // set if the server is SGX rather than TDX (default TDX)
  // match: (quote) => true, // custom validator; return true to accept
})

// Encrypted HTTP
const res = await client.fetch("/hello")
console.log(await res.text()) // "world"

// Encrypted WebSocket
const TunnelWS = client.WebSocket
const ws = new TunnelWS(origin.replace(/^http/, "ws"))
ws.addEventListener("open", () => ws.send("ping"))
ws.addEventListener("message", (evt) => console.log("got:", evt.data))
```

Notes:
- The WebSocket URL must target the same host and port as `origin`. The client enforces a port match.
- The client automatically reconnects the control channel if it drops; it will signal `close` with code `1006` to all tunneled sockets and reject pending `fetch` requests.


## Usage details

### HTTP over the tunnel
- `client.fetch(input, init?)` mirrors the standard Fetch API for:
  - `input`: string URL (relative or absolute), `URL`, or `Request`
  - `init.method`: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
  - `init.headers`: `Headers`, `[key, value][]`, or object
  - `init.body`: string, `Uint8Array`, `ArrayBuffer`, or `ReadableStream`
- Responses are returned as a standard `Response` (supports `text()`, `json()`, `arrayBuffer()`, headers, status, etc.).
- Server-side streaming responses are concatenated into a single body before returning.

### WebSockets over the tunnel
- Use `const TunnelWS = client.WebSocket; const ws = new TunnelWS(url, protocols?)`.
- Event model mirrors browser WebSockets: `open`, `message`, `close`, `error` and `onopen/onmessage/onclose/onerror` properties.
- `ws.send(data)` supports strings and binary (ArrayBufferLike/DataView/Uint8Array).
- On the server, use `tunnelServer.wss` like a typical `ws` WebSocketServer: `on("connection")`, per-socket `on("message")`, `send()`, `close()`, and iterate `wss.clients` for broadcast.


## Considerations and limitations

- **Port match required (client WebSocket)**: The tunnel enforces that the WS target port equals the client’s `origin` port; mismatches produce an error event and the WS will not open.
- **Reserved path `"/__ra__"`**: Only the control channel may upgrade on this path; all other upgrade attempts are rejected. Use `tunnelServer.wss` rather than creating your own native WebSocket server.
- **HTTP request bodies are textified**:
  - Request bodies sent via `client.fetch` are coerced to text before tunneling (stringified UTF‑8). Raw binary HTTP request bodies are not preserved byte‑for‑byte. Use WebSockets for truly binary request streams.
- **Response streaming is buffered**: Server responses are accumulated in memory and returned as a whole. Very large responses increase memory usage; there is no back‑pressure to the client.
- **Header normalization**: Multi‑valued headers are joined with `", "`; header casing may be normalized. Exact duplicate header preservation is not guaranteed.
- **30s request timeout (client)**: Each `client.fetch` request times out after ~30 seconds. Currently not configurable in code.
- **Reconnect semantics**: When the control tunnel closes, the client:
  - emits a `close` with code `1006` to tunneled WebSockets and clears them
  - rejects pending `fetch` requests with `Tunnel disconnected`
  - drops the symmetric key and schedules reconnect (~1s)
- **Binary heuristics for WS from server**: The server converts outbound WS payloads to text if they look like ASCII; otherwise sends as binary. Payloads containing null bytes/high‑bit characters are treated as binary.
- **Blob unsupported in client WS send**: `Blob` is not supported; use `string` or `ArrayBuffer`/`TypedArray`/`DataView`.
- **Environment requirements (Node)**:
  - `WebSocket` global: In browsers this exists. In Node, provide a global implementation if your Node version lacks it (e.g., `globalThis.WebSocket = require("ws") as any`).
  - `CloseEvent` global: If missing in Node, polyfill it before using the client WS API.
- **Security model**:
  - Attestation is verified client‑side using `ra-https-qvl`. You can pin `mrtd` and/or `report_data`, or implement a custom `match(quote)` predicate.
  - The transport is encrypted end‑to‑end with XSalsa20‑Poly1305 using a symmetric key sealed to the server’s X25519 public key.
  - TLS is not required for confidentiality, but you may still want TLS for endpoint authentication and ecosystem compatibility.


## API summary

### Exports
```ts
export { TunnelServer } from "ra-https-tunnel"
export { TunnelClient } from "ra-https-tunnel"
export { ServerRAMockWebSocket, ServerRAMockWebSocketServer } from "ra-https-tunnel"
export { ClientRAMockWebSocket } from "ra-https-tunnel"
```

### TunnelServer
- `static initialize(app: Express, quote: Uint8Array): Promise<TunnelServer>`
- Properties:
  - `server: http.Server` — call `listen()` to start
  - `wss: ServerRAMockWebSocketServer` — mock WS server for your app
  - `quote: Uint8Array` — attestation quote provided at init
- Methods:
  - `logWebSocketConnections(): void` — logs tracked WS connections and key status

Behavior:
- Mounts a control `WebSocketServer` internally at `"/__ra__"` on the same HTTP server
- Performs KX (X25519 sealed box) and encrypts/decrypts tunneled messages using CBOR + XSalsa20‑Poly1305
- For HTTP: synthesizes requests to your Express app and returns encrypted responses
- For WS: exposes `wss` where your app handles connections/messages as usual

### TunnelClient
- `static initialize(origin: string, config: TunnelClientConfig): Promise<TunnelClient>`
- `ensureConnection(): Promise<void>` — establish/await the control connection
- `send(message)`: low‑level tunnel send (normally not needed)
- Getters:
  - `fetch: (input, init?) => Promise<Response>` — encrypted Fetch API
  - `WebSocket: { new(url: string, protocols?: string|string[]): WebSocket }` — encrypted WS class
- Config (`TunnelClientConfig`):
  - `mrtd?: string` — hex string to pin TDX/SGX MRTD
  - `report_data?: string` — hex string to pin report data
  - `match?: (quote) => boolean` — custom quote validation
  - `sgx?: boolean` — set true for SGX; defaults to TDX

### ServerRAMockWebSocketServer
- Events: `"connection"` — `(ws: ServerRAMockWebSocket) => void`
- Properties: `clients: Set<ServerRAMockWebSocket>`
- Methods: `close(cb?)` (closes all clients)

### ServerRAMockWebSocket
- Properties: `readyState`, constants `CONNECTING|OPEN|CLOSING|CLOSED`
- Methods: `send(data: string|Buffer)`, `close(code?, reason?)`
- Events: `"message"`, `"close"`

### ClientRAMockWebSocket
- Constructor: `new client.WebSocket(url, protocols?)`
- Properties: `readyState`, `bufferedAmount`, `binaryType`, `protocol`, `extensions`
- Methods: `send(data)`, `close(code?, reason?)`, `addEventListener`, `removeEventListener`
- Events: `open`, `message`, `close`, `error`


## Troubleshooting
- Enable debug logs: `DEBUG=ra-https:* node your-app.js`
- WS port mismatch → ensure your WS URL’s port equals the client `origin` port.
- Missing `WebSocket`/`CloseEvent` in Node → polyfill globals before initializing the client.
- Large responses or streamed endpoints → expect full buffering; consider chunking over WebSockets instead of HTTP.


## Test references
See `packages/tunnel/test/*.test.ts` for end‑to‑end examples of fetch and WebSocket usage, including binary payloads, broadcasts, server‑initiated closes, and error handling.

