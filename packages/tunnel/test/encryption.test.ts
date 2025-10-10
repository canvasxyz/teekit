import test from "ava"
import express, { Request, Response } from "express"
import type { AddressInfo } from "node:net"
import { WebSocket } from "ws"
import sodium from "libsodium-wrappers"
import { encode, decode } from "cbor-x"

import { TunnelClient, TunnelServer, encryptedOnly } from "@teekit/tunnel"
import { loadQuote, startTunnelApp, stopTunnel } from "./helpers/helpers.js"

test.serial(
  "Server sends only encrypted envelope messages after handshake",
  async (t) => {
    const { tunnelServer, tunnelClient, origin } = await startTunnelApp()

    // Attach echo handler on server app wss
    tunnelServer.wss.on("connection", (ws) => {
      ws.on("message", (data: any) => ws.send(data))
    })

    try {
      await tunnelClient.ensureConnection()
      const rawWs: any = tunnelClient.ws
      const wireMessages: any[] = []
      const handleWire = (data: any) => {
        try {
          const bytes =
            typeof data === "string"
              ? new TextEncoder().encode(data)
              : new Uint8Array(data)
          const msg = decode(bytes)
          wireMessages.push(msg)
        } catch {}
      }
      if (typeof rawWs.on === "function") {
        rawWs.on("message", handleWire)
      } else if (typeof rawWs.addEventListener === "function") {
        rawWs.addEventListener("message", (evt: any) => handleWire(evt.data))
      }

      // Perform a fetch and a ws roundtrip
      const response = await tunnelClient.fetch("/hello")
      t.is(response.status, 200)
      await response.text()

      const TunnelWS = tunnelClient.WebSocket
      const ws = new TunnelWS(origin.replace(/^http/, "ws"))
      await new Promise<void>((resolve) =>
        ws.addEventListener("open", () => resolve()),
      )
      const echoed = new Promise<string>((resolve) =>
        ws.addEventListener("message", (evt: any) => resolve(String(evt.data))),
      )
      ws.send("ping")
      t.is(await echoed, "ping")
      ws.close(1000, "done")

      // Give wire a brief moment to flush
      await new Promise((r) => setTimeout(r, 100))

      // All observed wire messages (after hooking) must be encrypted envelopes
      const types = wireMessages.map((m) => m?.type)
      t.true(types.length > 0)
      t.true(types.every((tpe) => tpe === "enc"))
    } finally {
      await stopTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "Server drops plaintext requests, handles encrypted requests",
  async (t: any) => {
    await sodium.ready
    const app = express()
    app.get("/hello", (_req: Request, res: Response) => {
      res.status(200).send("world")
    })

    const quote = loadQuote({ tdxv4: true })
    const tunnelServer = await TunnelServer.initialize(app, async () => ({
      quote,
    }))
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const wsUrl = `ws://127.0.0.1:${address.port}/__ra__`

    const ws = new WebSocket(wsUrl)
    try {
      // Wait for server_kx
      const serverKx: any = await new Promise((resolve) => {
        ws.once("message", (data) =>
          resolve(decode(new Uint8Array(data as any))),
        )
      })
      t.is(serverKx.type, "server_kx")

      // Send plaintext before handshake; server should drop
      const badPlaintextReq = {
        type: "http_request",
        requestId: "r1",
        method: "GET",
        url: "/hello",
        headers: {},
      }
      ws.send(JSON.stringify(badPlaintextReq))
      const noReplyEarly = await Promise.race([
        new Promise<boolean>((resolve) =>
          ws.once("message", () => resolve(false)),
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 150)),
      ])
      t.true(noReplyEarly)

      // Complete handshake
      const serverPub = sodium.from_base64(
        serverKx.x25519PublicKey,
        sodium.base64_variants.ORIGINAL,
      )
      const symmetricKey = sodium.crypto_secretbox_keygen()
      const sealed = sodium.crypto_box_seal(symmetricKey, serverPub)
      const clientKx = {
        type: "client_kx",
        sealedSymmetricKey: sodium.to_base64(
          sealed,
          sodium.base64_variants.ORIGINAL,
        ),
      }
      ws.send(encode(clientKx))

      // Send plaintext after handshake; server should drop
      ws.send(JSON.stringify({ ...badPlaintextReq, requestId: "r2" }))
      const noReplyPost = await Promise.race([
        new Promise<boolean>((resolve) =>
          ws.once("message", () => resolve(false)),
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 150)),
      ])
      t.true(noReplyPost)

      // Send encrypted request
      const httpReq = {
        type: "http_request",
        requestId: "r3",
        method: "GET",
        url: "/hello",
        headers: {},
      }
      const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
      const plaintext = encode(httpReq)
      const ciphertext = sodium.crypto_secretbox_easy(
        plaintext,
        nonce,
        symmetricKey,
      )
      const envelope = {
        type: "enc",
        nonce: nonce,
        ciphertext: ciphertext,
      }
      ws.send(encode(envelope))

      // Expect encrypted http_response, use any types since this is a test
      const encResp: any = await new Promise((resolve) =>
        ws.once("message", (data) =>
          resolve(decode(new Uint8Array(data as any))),
        ),
      )
      t.is(encResp.type, "enc")
      const respNonce = encResp.nonce as Uint8Array
      const respCipher = encResp.ciphertext as Uint8Array
      const respPlain = sodium.crypto_secretbox_open_easy(
        respCipher,
        respNonce,
        symmetricKey,
      )
      const resp = decode(respPlain)
      t.is(resp.type, "http_response")
      t.is(resp.requestId, "r3")
      t.is(resp.status, 200)
      t.is(resp.statusText, "OK")
      t.is(resp.body, "world")
    } finally {
      await new Promise<void>((resolve) => {
        ws.close()
        resolve()
      })
      await new Promise<void>((resolve) =>
        tunnelServer.wss.close(() => resolve()),
      )
      await new Promise<void>((resolve) =>
        tunnelServer.server!.close(() => resolve()),
      )
    }
  },
)

test.serial("Client send fails when symmetric key is missing", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelApp()
  try {
    await tunnelClient.ensureConnection()
    // Drop the key to simulate corruption/forgetting
    ;(tunnelClient as any).symmetricKey = undefined

    // fetch should reject because send() requires encryption
    const fetchErr = await t.throwsAsync(async () => {
      await tunnelClient.fetch("/ok")
    })
    t.truthy(fetchErr)
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial(
  "Server encryptedOnly() routes blocks direct HTTP, allows tunneled HTTP",
  async (t) => {
    const app = express()
    app.get("/secret", encryptedOnly(), (_req, res) => {
      res.status(200).send("shh")
    })

    const quote = loadQuote({ tdxv4: true })
    const tunnelServer = await TunnelServer.initialize(app, async () => ({
      quote,
    }))
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    // Direct HTTP should be forbidden
    const direct = await fetch(origin + "/secret")
    t.is(direct.status, 403)

    // Tunnel request should succeed
    const tunnelClient = await TunnelClient.initialize(origin, {
      customVerifyQuote: () => true,
      customVerifyX25519Binding: () => true,
    })

    const res = await tunnelClient.fetch("/secret")
    t.is(res.status, 200)
    t.is(await res.text(), "shh")

    if (tunnelClient.ws) {
      tunnelClient.ws.close()
    }

    await new Promise<void>((resolve) => {
      tunnelServer.wss.close(() => resolve())
    })
    await new Promise<void>((resolve) => {
      tunnelServer.server!.close(() => resolve())
    })
  },
)
