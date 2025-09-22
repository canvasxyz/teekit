import test from "ava"
import express, { Request, Response } from "express"
import type { AddressInfo } from "node:net"
import sodium from "libsodium-wrappers"

import { TunnelClient, TunnelServer } from "../src/index.js"
import {
  tappdV4Base64,
  trusteeV5Base64,
  occlumSgxBase64,
} from "./samples/samples.js"
import { base64 } from "@scure/base"
import { hex, parseTdxQuote } from "../../qvl/src/index.js"

// Ensure timers don't keep `npx ava --watch` alive (client sets 30s timeouts)
const originalSetTimeout = setTimeout
;(globalThis as any).setTimeout = ((fn: any, ms?: any, ...args: any[]) => {
  const handle: any = (originalSetTimeout as any)(fn, ms, ...args)
  if (handle && typeof handle.unref === "function") handle.unref()
  return handle
}) as any

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

  // Additional routes for comprehensive fetch tests
  app.all("/echo-all", (req: Request, res: Response) => {
    res.status(200).json({
      method: req.method,
      url: (req as any).originalUrl ?? req.url,
      headers: req.headers,
      query: (req as any).query || {},
      body: (req as any).body,
    })
  })

  app.post("/echo-urlencoded", (req: Request, res: Response) => {
    res.status(200).json({ received: (req as any).body })
  })

  // For multipart/form-data we just echo the raw body back
  app.post("/echo-formdata", (req: Request, res: Response) => {
    res.status(200).send((req as any).body)
  })

  app.get("/json", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, nested: { a: 1, b: "two" } })
  })

  app.get("/text", (_req: Request, res: Response) => {
    res.status(200).send("text-ok")
  })

  app.get("/binary", (_req: Request, res: Response) => {
    const bytes = Uint8Array.from([0, 1, 2, 255])
    res.status(200).setHeader("content-type", "application/octet-stream")
    res.send(Buffer.from(bytes))
  })

  app.get("/set-cookie", (_req: Request, res: Response) => {
    res.setHeader("set-cookie", [
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/; SameSite=Strict",
    ])
    res.status(200).send("ok")
  })

  app.get("/redirect", (_req: Request, res: Response) => {
    res.redirect(302, "/hello")
  })

  app.head("/head", (_req: Request, res: Response) => {
    res.setHeader("x-head", "1")
    res.status(204).end()
  })

  app.get("/stream", (_req: Request, res: Response) => {
    res.setHeader("content-type", "text/plain; charset=utf-8")
    res.write("chunk-1:")
    res.write("chunk-2:")
    res.end("done")
  })

  app.get("/status/:code", (req: Request, res: Response) => {
    const code = Number((req as any).params.code)
    res.status(Number.isFinite(code) ? code : 500).send(`status-${code}`)
  })

  app.post("/echo-large-len", (req: Request, res: Response) => {
    let length = 0
    const body: any = (req as any).body
    if (typeof body === "string") length = body.length
    else if (Buffer.isBuffer(body)) length = body.length
    else if (body != null) length = Buffer.byteLength(JSON.stringify(body))
    res.status(200).json({ length })
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

test.serial("GET through tunnel", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelApp()

  try {
    const response = await tunnelClient.fetch("/hello")
    t.is(response.status, 200)
    const text = await response.text()
    t.is(text, "world")
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("POST through tunnel", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelApp()

  try {
    const payload = { name: "Ada", answer: 42 }
    const response = await tunnelClient.fetch("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    t.is(response.status, 200)
    const json = await response.json()
    t.deepEqual(json, { received: payload })
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial(
  "WebSocket lifecycle over tunnel (terminates at server wss)",
  async (t) => {
    const { tunnelServer, tunnelClient, origin } = await startTunnelApp()

    // Attach an echo handler to the server's built-in WebSocketServer
    tunnelServer.wss.on("connection", (ws) => {
      ws.on("message", (data: any) => ws.send(data))
    })

    try {
      const withTimeout = async <T>(
        p: Promise<T>,
        ms: number,
        label: string,
      ) => {
        let to: any
        const timeout = new Promise<never>((_, reject) => {
          to = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
        })
        try {
          return (await Promise.race([p, timeout])) as T
        } finally {
          clearTimeout(to)
        }
      }

      const TunnelWS = tunnelClient.WebSocket
      const ws = new TunnelWS(origin.replace(/^http/, "ws"))

      t.is(ws.readyState, ws.CONNECTING)

      const opened = withTimeout(
        new Promise<void>((resolve) => {
          ws.addEventListener("open", () => resolve())
        }),
        2000,
        "open",
      )

      const earlyClosed = withTimeout(
        new Promise<void>((resolve) => {
          ws.addEventListener("close", () => resolve())
        }),
        4000,
        "early close",
      )
        .then(() => true)
        .catch(() => false)

      await opened
      t.is(ws.readyState, ws.OPEN)

      const message = withTimeout(
        new Promise<string>((resolve) => {
          ws.addEventListener("message", (evt: any) =>
            resolve(String(evt.data)),
          )
        }),
        2000,
        "message",
      )

      ws.send("ping")
      const echoed = await message
      t.is(echoed, "ping")

      const wasEarlyClosed = await earlyClosed
      if (!wasEarlyClosed) {
        const closeEvent = new Promise<void>((resolve) => {
          ws.addEventListener("close", () => resolve())
        })
        ws.close(1000, "done")
        // Wait up to 2s for close event; if not received, assert CLOSING state
        await Promise.race([
          closeEvent,
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ])
        if (ws.readyState !== ws.CLOSED) {
          t.is(ws.readyState, ws.CLOSING)
        }
      }
    } finally {
      await stopTunnel(tunnelServer, tunnelClient)
    }
  },
)
