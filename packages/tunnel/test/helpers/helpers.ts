import express, { type Request, type Response } from "express"
import { Context, Hono } from "hono"
import { createNodeWebSocket } from "@hono/node-ws"
import { serve } from "@hono/node-server"
import type { AddressInfo } from "node:net"
import sodium from "libsodium-wrappers"

import { TunnelClient, TunnelServer } from "@teekit/tunnel"
import { tappdV4Base64, trusteeV5Base64, occlumSgxBase64 } from "./samples.js"
import { base64 } from "@scure/base"
import { hex, parseTdxQuote } from "@teekit/qvl"

// Ensure timers don't keep `npx ava --watch` alive (client sets 30s timeouts)
const originalSetTimeout = setTimeout
;(globalThis as any).setTimeout = ((fn: any, ms?: any, ...args: any[]) => {
  const handle: any = (originalSetTimeout as any)(fn, ms, ...args)
  if (handle && typeof handle.unref === "function") handle.unref()
  return handle
}) as any

// Polyfill CloseEvent for Node if missing
if (!(globalThis as any).CloseEvent) {
  class PolyfillCloseEvent extends Event {
    code: number
    reason: string
    wasClean: boolean
    constructor(type: string, init?: any) {
      super(type)
      this.code = init?.code ?? 1000
      this.reason = init?.reason ?? ""
      this.wasClean = Boolean(init?.wasClean)
    }
  }
  ;(globalThis as any).CloseEvent = PolyfillCloseEvent as any
}

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

export async function startExpressTunnelApp() {
  await sodium.ready
  const app = express()
  // Provide a simple default route used by several tests
  app.get("/hello", (_req, res) => res.status(200).send("world"))

  app.get("/hello", (_req, res) => res.status(200).send("world"))
  app.get("/ok", (_req, res) => res.status(200).send("ok"))
  app.post("/echo", (req: Request, res: Response) => {
    res.status(200).json({ received: req.body })
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

  const quoteBodyParsed = parseTdxQuote(quote).body
  const tunnelClient = await TunnelClient.initialize(origin, {
    mrtd: hex(quoteBodyParsed.mr_td),
    report_data: hex(quoteBodyParsed.report_data),
    customVerifyX25519Binding: () => true,
  })

  return { tunnelServer, tunnelClient, origin }
}

export async function startHonoTunnelApp() {
  await sodium.ready
  const app = new Hono()
  // Provide a simple default route used by several tests
  app.get("/hello", (c) => c.text("world", 200))
  app.get("/ok", (c) => c.text("ok", 200))
  // The purpose of the /echo test is to check that different types of encoding
  // work over the tunnel. This is easy in Express, but more complex in Hono.
  // Emulate express behavior:
  app.post("/echo", async (c) => {
    const body = await (async () => {
      const ct = c.req.header("content-type") || ""
      // echo json
      if (ct.includes("application/json")) return await c.req.json()
      // echo url-encoded form data
      if (ct.includes("application/x-www-form-urlencoded")) {
        const text = await c.req.text()
        const params = new URLSearchParams(text)
        const obj: Record<string, string> = {}
        params.forEach((v, k) => (obj[k] = v))
        return obj
      }
      // echo text
      return await c.req.text()
    })()
    const headers = Object.fromEntries(c.req.raw.headers.entries())
    return c.json({ method: c.req.method, headers, body }, 200)
  })

  const echo = async (c: Context) => {
    const text = await c.req.text()
    const headers = Object.fromEntries(c.req.raw.headers.entries())
    return c.json({ method: c.req.method, headers, body: text }, 200)
  }
  app.put("/echo", echo)
  app.patch("/echo", echo)
  app.delete("/echo", echo)

  // Additional endpoints to mirror Express fetch tests
  app.get("/text", (c) => c.text("hello text", 200))
  app.get("/json", (c) => c.json({ ok: true }, 200))
  app.get("/query", (c) => c.json({ query: c.req.query() }, 200))
  app.get(
    "/status/:code",
    (c) => new Response("", { status: Number(c.req.param("code")) }),
  )
  // Register GET handler; Hono will serve HEAD with same headers and no body
  app.get("/head", () => {
    const headers = new Headers()
    headers.set("x-head", "true")
    return new Response("", { status: 200, headers })
  })
  app.options("/anything", () => {
    const headers = new Headers()
    headers.set("Allow", "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS")
    return new Response(null, { status: 204, headers })
  })
  app.get("/set-headers", () => {
    const headers = new Headers()
    headers.set("X-Custom-A", "A")
    headers.append("X-Custom-B", "B1")
    headers.append("X-Custom-B", "B2")
    // Also set multiple cookies to exercise multi-value special-case
    headers.append("set-cookie", "a=1; Path=/; HttpOnly")
    headers.append("set-cookie", "b=2; Path=/; HttpOnly")
    return new Response("ok", { status: 200, headers })
  })
  app.get("/bytes/:size", (c) => {
    const size = Math.min(
      2 * 1024 * 1024,
      Math.max(0, Number(c.req.param("size")) || 0),
    )
    const buf = new Uint8Array(size)
    for (let i = 0; i < size; i++) buf[i] = i % 256
    const headers = new Headers()
    headers.set("content-type", "application/octet-stream")
    return new Response(buf, { status: 200, headers })
  })
  app.get("/stream", (_c) => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("part1-"))
        await new Promise((r) => setTimeout(r, 10))
        controller.enqueue(encoder.encode("part2-"))
        await new Promise((r) => setTimeout(r, 10))
        controller.enqueue(encoder.encode("end"))
        controller.close()
      },
    })
    const headers = new Headers()
    headers.set("content-type", "text/plain")
    return new Response(stream, { status: 200, headers })
  })

  const nodeWS = createNodeWebSocket({ app })
  const { injectWebSocket, upgradeWebSocket } = nodeWS
  const quote = loadQuote({ tdxv4: true })
  const tunnelServer = await TunnelServer.initialize(
    app,
    async () => ({
      quote,
    }),
    { upgradeWebSocket },
  )

  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  injectWebSocket(server)

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve)
    server.once("error", reject)
  })

  const address = server.address()
  if (typeof address === "string" || address === null) throw new Error()
  const origin = `http://127.0.0.1:${address.port}`

  const quoteBodyParsed = parseTdxQuote(quote).body
  const tunnelClient = await TunnelClient.initialize(origin, {
    mrtd: hex(quoteBodyParsed.mr_td),
    report_data: hex(quoteBodyParsed.report_data),
    customVerifyX25519Binding: () => true,
  })

  // Attach underlying Hono server and ws server for proper shutdown
  ;(tunnelServer as any).__honoServer = server
  ;(tunnelServer as any).__honoWss = nodeWS.wss

  return { tunnelServer, tunnelClient, origin }
}

// Back-compat for existing tests
export const startTunnelApp = startExpressTunnelApp

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

  // Close Hono ws server if present (Node adapter)
  try {
    const honoWss: any = (tunnelServer as any).__honoWss
    if (honoWss && typeof honoWss.close === "function") {
      await new Promise<void>((resolve) => honoWss.close(() => resolve()))
    }
  } catch {}

  // Close underlying server that may have been created by helpers (Hono)
  try {
    const honoServer: any = (tunnelServer as any).__honoServer
    if (honoServer && typeof honoServer.close === "function") {
      await new Promise<void>((resolve) => honoServer.close(() => resolve()))
    }
  } catch {}

  // Close tunnelServer.server if it exists (Express mode)
  if (tunnelServer.server) {
    await new Promise<void>((resolve) => {
      tunnelServer.server!.close(() => resolve())
    })
  }
}
