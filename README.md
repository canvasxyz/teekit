# TEEKit

[![tests](https://github.com/canvasxyz/teekit/actions/workflows/ci.yml/badge.svg)](https://github.com/canvasxyz/teekit/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@teekit/qvl.svg)](https://www.npmjs.com/package/@teekit/qvl)
[![npm](https://img.shields.io/npm/v/@teekit/tunnel?color=33cd56&logo=npm)](https://www.npmjs.com/package/@teekit/tunnel)

A set of building blocks for end-to-end verifiable TEE applications.

## Background

Trusted execution environments make it possible to build private,
verifiable web services, that can compose with each other trustlessly
and with properties similar to those of advanced cryptography.

One significant limitation for end-user TEE applications is that web
pages in a browser cannot verify that they're connected to a
TEE. Browsers don't expose X.509 certificate information that proves a
connection terminates inside the secure environment, so proxies like
Cloudflare can trivially see and modify traffic to TEEs forwarded
through them. Anyone hosting a TEE app can use a TLS proxy to extract
session data and/or impersonate users.

To work around this, some TEE application hosts implement their own
proxy in front of the TEE, but this reintroduces trust assumptions
around their proxy. We can also use certificate log monitoring to
improve security, but this happens out-of-band and doesn't directly
protect the connection between the user and the TEE.

@teekit/tunnel implements protocols for remotely-attested HTTPS and
WSS channels, which web pages can use to establish secure connections
that verifiably terminate inside trusted execution environments.  This
makes it possible to create applications that interact with a TEE
trustlessly, especially if clients are pinned on IPFS or other
immutable hosting services. This also allows TEE developers to use
public certificate authorities like Let's Encrypt, without custom
configuration.

## Components

- @teekit/tunnel:
  - Establishes tunneled connections to a TEE through an encrypted
    WebSocket, with key exchange, quote validation, and CRL/TCB validation
  - Supports encrypted HTTP requests via a `fetch`-compatible API
  - Supports encrypted WebSockets via a `WebSocket`-compatible API
  - Includes a ServiceWorker for upgrading all HTTP requests from a
    browser page to use the encrypted channel
- @teekit/qvl:
  - WebCrypto-based SGX/TDX/SEV-SNP quote verification library
  - Validates the full chain of trust from the root CA, down to binding
    the public key of the encrypted channel in `report_data`
  - Includes optional CRL/TCB validation inside the browser. (Intel TCB
    info cannot be fetched in the browser without a CORS proxy.)
- @teekit/demo:
  - A [demo application](https://teekit.vercel.app/) that supports
    HTTPS and WSS requests over the encrypted channel, both with and without
    the embedded ServiceWorker.
- @teekit/kettle:
  - A JS runtime designed for deploying remotely-attested, user-verifiable
    code, designed to work with @teekit/tunnel and TEE environments
    (e.g. Dstack, GCP, Azure).
- @teekit/images:
  - A reproducible VM image for running @teekit/kettle applications.
  - Based on Debian 13 with a custom yocto-tiny kernel, which boots a ~200MB
    read-only ramdisk containing our JS runtime.
  - Builds are run using mkosi, and configured to automatically run nightly
    while generating RTMR and PCR measurements (MRTD measurements unavailable
    since cloud providers generally do not publish hypervisor firmware).

@teekit/tunnel and @teekit/qvl are stable, while other components are under
active development. These libraries have not been audited.

## Benchmarks

The encrypted channel adds ~3x overhead for concurrent requests, and
~6.5x for large payloads.

Some of this overhead is because we use @noble/ciphers for stream
encryption. We have tested that WASM-based cryptography provides a
~50-100% speedup and plan to integrate it (with fallback to JS-based
cryptography) in a later release.

### With Tunnel

| Test | Average | Median | 90th % | 99th % | Max |
|------|---------|--------|--------|--------|-----|
| 100 concurrent requests | 109.9ms | 109.9ms | 110.47ms | 112.32ms | 112.32ms |
| 50 serial requests | 0.96ms | 0.38ms | 0.55ms | 28.72ms | 28.72ms |
| 50 requests with 1MB up/down | 33.64ms | 33.11ms | 34.49ms | 60.4ms | 60.4ms |

### Without Tunnel

| Test | Average | Median | 90th % | 99th % | Max |
|------|---------|--------|--------|--------|-----|
| 100 concurrent requests | 32.83ms | 33.28ms | 39.13ms | 45.75ms | 45.75ms |
| 50 serial requests | 0.37ms | 0.2ms | 0.31ms | 7.67ms | 7.67ms |
| 50 requests with 1MB up/down | 5.13ms | 4.95ms | 5.56ms | 8.88ms | 8.88ms |

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
  ws.addEventListener("message", (evt) => console.log(evt.data))
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
encoded and encrypted with the XSalsa20‑Poly1305 stream cipher.

1. Client opens a control WebSocket to the server at
   `ws(s)://<host>:<port>/__ra__`.
2. Server immediately sends `server_kx` with an X25519 public key and
   a remotely attested quote.
3. Client verifies the quote (using `@teekit/qvl`), optionally
   enforces `mrtd`/`report_data` or a custom matcher, generates a
   symmetric key, and sends it sealed to the server via `client_kx`.
4. All subsequent messages are encrypted envelopes
   `{ type: "enc", nonce, ciphertext }` carrying tunneled HTTP
   and WebSocket messages.

## Limitations

- One fixed keypair per server. No key rotation (yet).
- HTTP request/response bodies are buffered end-to-end, not streamed.
- HTTP request bodies supported: `string`, `Uint8Array`, `ArrayBuffer`, `ReadableStream` (no `FormData`).
- WebSocket bodies: `Blob` is not supported, convert to `ArrayBuffer`.
- The client request timeout is 30 seconds, and this is not configurable at this time.
- WebSocket messages queued before `open` are flushed once the socket opens.

## License

@teekit/tunnel, @teekit/qvl, @teekit/demo, and @teekit/azure-vtpm-hcl
packages are made available under the
[MIT License](https://opensource.org/license/mit).

@teekit/kettle is made available under the
[AGPL V3 License](https://opensource.org/license/agpl-v3).

(C) 2025 Canvas Technologies, Inc.
