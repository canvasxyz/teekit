import test from "ava"
import express from "express"
import type { AddressInfo } from "node:net"

import { TunnelClient, TunnelServer, encryptedOnly } from "ra-https-tunnel"
import { parseTdxQuote, hex } from "ra-https-qvl"
import { loadQuote } from "./helpers/helpers.js" 

test.serial("encryptedOnly blocks direct HTTP and allows tunneled requests", async (t) => {
  const app = express()

  app.get("/public", (_req, res) => res.status(200).send("ok"))
  app.get("/secret", encryptedOnly(), (_req, res) => res.status(200).send("shh"))

  const quote = loadQuote({ tdxv4: true })
  const tunnelServer = await TunnelServer.initialize(app, quote)

  await new Promise<void>((resolve) => {
    tunnelServer.server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = tunnelServer.server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`

  // Direct HTTP should work for public and be blocked for secret
  const publicRes = await fetch(origin + "/public")
  t.is(publicRes.status, 200)
  t.is(await publicRes.text(), "ok")

  const secretRes = await fetch(origin + "/secret")
  t.is(secretRes.status, 403)

  // Tunnel client should be allowed for secret
  const quoteBodyParsed = parseTdxQuote(quote).body
  const tunnelClient = await TunnelClient.initialize(origin, {
    mrtd: hex(quoteBodyParsed.mr_td),
    report_data: hex(quoteBodyParsed.report_data),
  })
  try {
    const res = await tunnelClient.fetch("/secret")
    t.is(res.status, 200)
    t.is(await res.text(), "shh")
  } finally {
    try {
      if (tunnelClient.ws) {
        tunnelClient.ws.onclose = () => {}
        tunnelClient.ws.close()
      }
    } catch {}
  }

  await new Promise<void>((resolve) => tunnelServer.wss.close(() => resolve()))
  await new Promise<void>((resolve) => tunnelServer.server.close(() => resolve()))
})

