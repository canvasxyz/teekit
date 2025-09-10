import test from "ava"
import express, { Request, Response } from "express"
import type { AddressInfo } from "node:net"
import { WebSocketServer, WebSocket } from "ws"
import sodium from "libsodium-wrappers"

import { RA as TunnelServer } from "../tunnel/server.ts"
import { RA as TunnelClient } from "../tunnel/client.ts"

async function startTunnelApp() {
  await sodium.ready
  const app = express()

  app.get("/hello", (_req: Request, res: Response) => {
    res.status(200).send("world")
  })

  const tunnelServer = await TunnelServer.initialize(app)

  await new Promise<void>((resolve) => {
    tunnelServer.server.listen(0, "127.0.0.1", () => resolve())
  })

  const address = tunnelServer.server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`

  const tunnelClient = await TunnelClient.initialize(origin)

  return { tunnelServer, tunnelClient, origin }
}

async function stopTunnel(
  tunnelServer: TunnelServer,
  tunnelClient: TunnelClient,
) {
  try {
    const ws: any = (tunnelClient as any).ws
    if (ws) {
      ws.onclose = () => {}
      try {
        ws.close()
      } catch {}
    }
  } catch {}

  await new Promise<void>((resolve) => {
    tunnelServer.wss.close(() => resolve())
  })
  await new Promise<void>((resolve) => {
    tunnelServer.server.close(() => resolve())
  })
}

test.serial("Wire messages are encrypted after handshake", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startTunnelApp()

  // Attach echo handler on server app wss
  tunnelServer.wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send(data))
  })

  try {
    await (tunnelClient as any).ensureConnection()
    const rawWs: any = (tunnelClient as any).ws
    const wireMessages: any[] = []
    const handleWire = (data: any) => {
      try {
        const txt = typeof data === "string" ? data : data.toString()
        const msg = JSON.parse(txt)
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
})

test.serial(
  "Server enforces encryption and responds to encrypted requests",
  async (t) => {
    await sodium.ready
    const app = express()
    app.get("/hello", (_req: Request, res: Response) => {
      res.status(200).send("world")
    })

    const tunnelServer = await TunnelServer.initialize(app)
    await new Promise<void>((resolve) => {
      tunnelServer.server.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server.address() as AddressInfo
    const wsUrl = `ws://127.0.0.1:${address.port}/__ra__`

    const ws = new WebSocket(wsUrl)
    try {
      // Wait for server_kx
      const serverKx: any = await new Promise((resolve) => {
        ws.once("message", (data) => resolve(JSON.parse(data.toString())))
      })
      t.is(serverKx.type, "server_kx")

      const badPlaintextReq = {
        type: "http_request",
        requestId: "r1",
        method: "GET",
        url: "/hello",
        headers: {},
      }

      // Send plaintext before handshake; server should drop
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
      ws.send(JSON.stringify(clientKx))

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
      const plaintext = sodium.from_string(JSON.stringify(httpReq))
      const ciphertext = sodium.crypto_secretbox_easy(
        plaintext,
        nonce,
        symmetricKey,
      )
      const envelope = {
        type: "enc",
        nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
        ciphertext: sodium.to_base64(
          ciphertext,
          sodium.base64_variants.ORIGINAL,
        ),
      }
      ws.send(JSON.stringify(envelope))

      // Expect encrypted http_response
      const encResp: any = await new Promise((resolve) =>
        ws.once("message", (data) => resolve(JSON.parse(data.toString()))),
      )
      t.is(encResp.type, "enc")
      const respNonce = sodium.from_base64(
        encResp.nonce,
        sodium.base64_variants.ORIGINAL,
      )
      const respCipher = sodium.from_base64(
        encResp.ciphertext,
        sodium.base64_variants.ORIGINAL,
      )
      const respPlain = sodium.crypto_secretbox_open_easy(
        respCipher,
        respNonce,
        symmetricKey,
      )
      const resp = JSON.parse(sodium.to_string(respPlain))
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
        tunnelServer.server.close(() => resolve()),
      )
    }
  },
)
