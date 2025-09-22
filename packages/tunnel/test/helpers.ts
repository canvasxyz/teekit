import express, { Request, Response } from "express"
import type { AddressInfo } from "node:net"
import sodium from "libsodium-wrappers"
import { base64 } from "@scure/base"
import { TunnelClient, TunnelServer } from "ra-https-tunnel"
import { hex, parseTdxQuote } from "ra-https-qvl"

import {
  tappdV4Base64,
  trusteeV5Base64,
  occlumSgxBase64,
} from "./samples/samples.js"

export function loadQuote({
  sgx,
  tdxv4,
  tdxv5,
}: {
  sgx?: boolean
  tdxv4?: boolean
  tdxv5?: boolean
}): Uint8Array {
  if (sgx) {
    return base64.decode(occlumSgxBase64)
  } else if (tdxv4) {
    return base64.decode(tappdV4Base64)
  } else if (tdxv5) {
    return base64.decode(trusteeV5Base64)
  } else {
    throw new Error("loadQuote: must provide one of sgx, tdxv4, tdxv5")
  }
}

export async function startTunnelApp() {
  await sodium.ready
  const app = express()

  app.get("/hello", (_req, res) => res.status(200).send("world"))
  app.get("/ok", (_req, res) => res.status(200).send("ok"))
  app.post("/echo", (req: Request, res: Response) => {
    res.status(200).json({ received: req.body })
  })

  const quote = loadQuote({ tdxv4: true })
  const tunnelServer = await TunnelServer.initialize(app, quote)

  await new Promise<void>((resolve) => {
    tunnelServer.server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = tunnelServer.server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`

  const quoteBodyParsed = parseTdxQuote(quote).body
  const tunnelClient = await TunnelClient.initialize(origin, {
    mrtd: hex(quoteBodyParsed.mr_td),
    report_data: hex(quoteBodyParsed.report_data),
  })

  return { tunnelServer, tunnelClient, origin }
}

export async function stopTunnel(
  tunnelServer: TunnelServer,
  tunnelClient: TunnelClient,
) {
  try {
    if (tunnelClient.ws) {
      tunnelClient.ws.onclose = () => {}
      tunnelClient.ws.close()
    }
  } catch {}

  await new Promise<void>((resolve) => {
    tunnelServer.wss.close(() => resolve())
  })
  await new Promise<void>((resolve) => {
    tunnelServer.server.close(() => resolve())
  })
}

