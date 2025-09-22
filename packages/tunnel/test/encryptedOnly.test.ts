import test from "ava"
import express from "express"
import type { AddressInfo } from "node:net"

import { TunnelClient, TunnelServer, encryptedOnly } from "ra-https-tunnel"
import { loadQuote } from "./helpers/helpers.js"

test.serial("encryptedOnly blocks direct HTTP but allows tunneled", async (t) => {
  const app = express()
  app.get("/secret", encryptedOnly(), (_req, res) => {
    res.status(200).send("shh")
  })

  const quote = loadQuote({ tdxv4: true })
  const tunnelServer = await TunnelServer.initialize(app, quote)
  await new Promise<void>((resolve) => {
    tunnelServer.server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = tunnelServer.server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`

  // Direct HTTP should be forbidden
  const direct = await fetch(origin + "/secret")
  t.is(direct.status, 403)

  // Tunnel request should succeed
  const tunnelClient = await TunnelClient.initialize(origin, {
    // In these tests, the helper-generated quote will be accepted by default client verification
    match: () => true,
  })
  try {
    const res = await tunnelClient.fetch("/secret")
    t.is(res.status, 200)
    t.is(await res.text(), "shh")
  } finally {
    try {
      if (tunnelClient.ws) tunnelClient.ws.close()
    } catch {}
  }

  await new Promise<void>((resolve) => {
    tunnelServer.wss.close(() => resolve())
  })
  await new Promise<void>((resolve) => {
    tunnelServer.server.close(() => resolve())
  })
})

