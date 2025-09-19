import test from "ava"
import express from "express"
import type { AddressInfo } from "node:net"

import { RA as TunnelServer } from "../tunnel/server.ts"
import { RA as TunnelClient } from "../tunnel/client.ts"

async function startTunnelApp() {
  const app = express()
  app.get("/ok", (_req, res) => res.status(200).send("ok"))
  const tunnelServer = await TunnelServer.initialize(app)
  await new Promise<void>((resolve) => {
    tunnelServer.server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = tunnelServer.server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`
  const tunnelClient = await TunnelClient.initialize(origin)
  return { tunnelServer, tunnelClient }
}

async function stopTunnel(server: TunnelServer, client: TunnelClient) {
  try {
    const ws: any = (client as any).ws
    if (ws) {
      ws.onclose = () => {}
      try {
        ws.close()
      } catch {}
    }
  } catch {}
  await new Promise<void>((resolve) => server.wss.close(() => resolve()))
  await new Promise<void>((resolve) => server.server.close(() => resolve()))
}

test.serial("Client send fails when symmetric key missing", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelApp()
  try {
    // Establish connection so ws is OPEN
    await (tunnelClient as any).ensureConnection()
    // Drop the key to simulate corruption/forgetting
    ;(tunnelClient as any).symmetricKey = undefined

    // fetch should reject because send() requires encryption
    const fetchErr = await t.throwsAsync(async () => {
      await tunnelClient.fetch("/ok")
    })
    t.truthy(fetchErr)

    // Also verify that low-level send rejects when key is missing
    await (tunnelClient as any).ensureConnection()
    ;(tunnelClient as any).symmetricKey = undefined
    const sendErr = t.throws(() => (tunnelClient as any).send({ type: "noop" }))
    t.truthy(sendErr)
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})
