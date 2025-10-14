# TEEKit

[![tests](https://github.com/canvasxyz/teekit/actions/workflows/ci.yml/badge.svg)](https://github.com/canvasxyz/teekit/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@teekit/qvl.svg)](https://www.npmjs.com/package/@teekit/qvl)
[![npm](https://img.shields.io/npm/v/@teekit/tunnel?color=33cd56&logo=npm)](https://www.npmjs.com/package/@teekit/tunnel)

A set of building blocks for end-to-end verifiable TEE applications.

_Note: Under active development, has not been audited._

## Background

Trusted execution environments make it possible to build private,
verifiable web services, but one issue that makes this harder is that
web pages cannot natively verify that they're connected to a TEE.
Browsers don't expose X.509 certificate extensions that can be used to
prove a connection terminates inside the secured environment. This
means proxies like Cloudflare can trivially see and modify traffic to
TEEs forwarded through them. Anyone hosting a TEE app can easily
insert their own TLS proxy in front of it, and extract session data
that lets them impersonate users.

To work around this, TEE application hosts may implement their own
proxy in front of the TEE, but this reintroduces trust assumptions
around the proxy. Hosts can also use certificate log monitoring to
boost security, but this happens out-of-band and doesn't directly
protect the connection between the user and the TEE.

@teekit/tunnel implements protocols for remotely-attested HTTPS and
WSS channels, which web pages can use to establish secure connections
that verifiably terminate inside trusted execution environments
(currently Intel TDX/SGX).

Applications using teekit can treat TEEs like a regular web server,
and use public certificate authorities like Let's Encrypt and
Cloudflare without custom configuration. Developers can also host copies
of the same application on IPFS or other immutable cloud services.

## Components

- @teekit/tunnel:
  - Establishes tunneled connections to a TEE through an encrypted
    WebSocket, with key exchange, quote validation, and CRL/TCB validation
  - Supports encrypted HTTP requests via a `fetch`-compatible API
  - Supports encrypted WebSockets via a `WebSocket`-compatible API
  - Includes a ServiceWorker for upgrading all HTTP requests from a
    browser page to use the encrypted channel
- @teekit/qvl:
  - WebCrypto-based SGX/TDX quote verification library
  - Validates the full chain of trust from the root CA, down to binding
    the public key of the encrypted channel in `report_data`
  - Includes optional CRL/TCB validation inside the browser. (TCB info
    cannot be fetched from Intel in the browser without a CORS proxy.)
- @teekit/demo:
  - A [demo application](https://teekit.vercel.app/) that supports
    HTTPS and WSS requests over the encrypted channel, both with and without
    the embedded ServiceWorker.
- 🚧 @teekit/kettle:
  - A workerd-based runtime that supports arbitrary JS applications,
    executed inside V8 isolates.

## Performance

| Test | Average (ms) | Median (ms) | 90th % (ms) | Max (ms) |
|------|--------------|-------------|-------------|-------------|
| 100 concurrent requests (tunneled) | 67.31 | 67.32 | 67.70 | 69.75 |
| 100 concurrent requests (no tunnel) | 31.59 | 32.83 | 37.00 | 37.79 |
| 50 requests (tunneled) | 0.68 | 0.32 | 0.44 | 16.94 |
| 50 requests (no tunnel) | 0.35 | 0.17 | 0.40 | 6.75 |
| 50 requests, 1MB up/down (tunneled) | 22.08 | 21.43 | 23.55 | 40.83 |
| 50 requests, 1MB up/down (no tunnel) | 5.09 | 4.78 | 7.24 | 9.00 |

Several optimizations for large payloads are planned for the next release.

## Usage

On the client, create a `TunnelClient()` object. You should switch out
unencrypted Node.js `fetch` and `WebSocket` instances for our `fetch` and
`WebSocket` wrappers, exposed on the `TunnelClient()`.

It is your responsibility to configure TunnelClient with the expected
`mrtd` and `report_data` measurements, certificate revocation lists,
and manually verify the TCB inside any custom quote validator.

Your client will validate all measurements, quote signatures, and
additional CRL/TCB info before opening a connection.

```ts
import { TunnelClient } from "@teekit/tunnel"
import { hex, parseTdxQuote } from "@teekit/qvl"

async function main() {
  const origin = "http://127.0.0.1:3000"

  // You can validate against expected mrtd/report_data or provide a custom matcher.
  // Below shows fixed values; compute these from an expected quote if you have one.
  const expectedMrtd = '...' /* hex string */
  const expectedReportData = '...' /* hex string */

  const client = await TunnelClient.initialize(origin, {
    mrtd: expectedMrtd,
    report_data: expectedReportData,
    crl: [], // certificate revocation list
    verifyTcb: ({ fmspc, cpuSvn, pceSvn, quote }) => {
      // Check for TCB freshness and return true if valid
      return true
    },
    // sgx: true // defaults to TDX otherwise
  })

  // HTTP over tunnel
  const res = await client.fetch("/hello")
  console.log(await res.text()) // server replies "world"

  // WebSocket over tunnel
  const ws = new client.WebSocket(origin.replace(/^http/, "ws"))
  ws.addEventListener("open", () => ws.send("ping"))
  ws.addEventListener("message", (evt: any) => console.log(String(evt.data)))
}

main()
```

On the server, add a `TunnelServer` middleware to your Node.js/Express
server. We only support Node.js now, but future versions will support
arbitrary backends through Nginx.

```ts
import express from "express"
import { TunnelServer } from "@teekit/tunnel"

async function main() {
  const app = express()
  app.get("/hello", (_req, res) => res.status(200).send("world"))

  async function getQuote(x25519PublicKey: Uint8Array): Promise<Uint8Array> {
    // Return a Uint8Array bound to x25519PublicKey. See packages/demo/server
    // for an example that uses `trustauthority-cli` and --user-data binding.
    return new Uint8Array(Buffer.from('...', 'hex'))
  }
  const tunnelServer = await TunnelServer.initialize(app, getQuote)

  // Optional: WebSocket support via the built-in mock server
  tunnelServer.wss.on("connection", (ws) => {
    ws.on("message", (data: any) => ws.send(data))
  })

  tunnelServer.server.listen(3000, () => {
    console.log("teekit service listening on :3000")
  })
}

main()
```

## ServiceWorker

You may also use the included ServiceWorker to transparently upgrade
HTTP GET/POST requests to go over the encrypted channel to your
`TunnelServer`.

To do this, first add the ServiceWorker plugin to your bundler. You
can use an included Vite plugin to handle this, or manually serve
`__ra-serviceworker__.js` at your web root from
`node_modules/@teekit/tunnel/lib/sw.build.js`:

```js
// vite.config.js
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { includeRaServiceWorker } from "@teekit/tunnel/sw"

export default defineConfig({
  plugins: [react(), includeRaServiceWorker()],
})
```

Then, register the ServiceWorker at app startup, pointed at your
tunnel origin:

```ts
// src/main.tsx (or similar)
import { registerServiceWorker } from "@teekit/tunnel/register"

const baseUrl = "http://127.0.0.1:3000" // your TunnelServer origin
registerServiceWorker(baseUrl)
```

Note that different browsers vary in their support of ServiceWorkers,
and some browsers may block ServiceWorkers from being installed, in
which case your application will be silently downgraded to lose privacy.
For this reason we recommend using the default @teekit/tunnel APIs
whenever possible.

By default, ServiceWorkers intercept link clicks, location.assign()
calls, subresource requests, and fetch() / XMLHttpRequest requests
(but not WebSockets).

## Demo

The packages/demo directory contains a demo of a chat app that relays
WebSocket messages and fetch requests over an encrypted channel.

Node v22 is expected.

Run the client using `tsx`:

```
npm run dev
```

Run the server using Node.js:

```
npm run server
```

## Architecture

The tunnel performs a key exchange and attestation check before
allowing any traffic. After the handshake, all payloads are CBOR
encoded and encrypted with the XSalsa20‑Poly1305 stream cipher
(libsodium `crypto_secretbox`).

1. Client opens a control WebSocket to the server at
   `ws(s)://<host>:<port>/__ra__`.
2. Server immediately sends `server_kx` with an X25519 public key and
   a TDX/SGX attestation quote.
3. Client verifies the quote (using `@teekit/qvl`), optionally
   enforces `mrtd`/`report_data` or a custom matcher, generates a
   symmetric key, and sends it sealed to the server via `client_kx`
   (libsodium `crypto_box_seal`).
4. All subsequent messages are encrypted envelopes
   `{ type: "enc", nonce, ciphertext }` carrying tunneled HTTP
   and WebSocket messages.

## Limitations

- For security reasons, we currently require that all WebSocket connections to the HTTP server go through the encrypted channel. Mixing and matching unencrypted WebSockets and @teekit/tunnel is not supported.
- One keypair is generated per server. No key rotation (yet) or support for load balancing across TEEs.
- HTTP request/response bodies are buffered end-to-end; very large payloads cannot be streamed.
- HTTP request bodies: string, `Uint8Array`, `ArrayBuffer`, `ReadableStream` (no `FormData`).
- Our `WebSocket.send` does not accept `Blob`. Convert blobs to `ArrayBuffer` or `Uint8Array` first.
- The default client request timeout is 30 seconds, and this is not configurable at this time.
- WebSocket messages queued before `open` are automatically flushed once the socket opens.

## License

MIT (C) 2025