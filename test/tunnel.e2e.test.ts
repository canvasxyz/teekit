import test from "ava"
import express, { Request, Response } from "express"
import type { AddressInfo } from "node:net"
import { WebSocketServer } from "ws"

import { RA as TunnelServer } from "../tunnel/server.ts"
import { RA as TunnelClient } from "../tunnel/client.ts"

// Ensure timers don't keep the process alive (client sets 30s timeouts)
const originalSetTimeout = setTimeout
;(globalThis as any).setTimeout = ((fn: any, ms?: any, ...args: any[]) => {
  const handle: any = (originalSetTimeout as any)(fn, ms, ...args)
  if (handle && typeof handle.unref === "function") handle.unref()
  return handle
}) as any

// Minimal polyfills for DOM events used by TunnelWebSocket in Node
if (!(globalThis as any).CloseEvent) {
  class CloseEventPolyfill extends Event {
    code: number
    reason: string
    wasClean: boolean

    constructor(
      type: string,
      init?: { code?: number; reason?: string; wasClean?: boolean }
    ) {
      super(type)
      this.code = init?.code ?? 1000
      this.reason = init?.reason ?? ""
      this.wasClean = init?.wasClean ?? true
    }
  }
  ;(globalThis as any).CloseEvent = CloseEventPolyfill
}

if (!(globalThis as any).MessageEvent) {
  class MessageEventPolyfill<T = any> extends Event {
    data: T
    constructor(type: string, init?: { data?: T }) {
      super(type)
      this.data = (init as any)?.data
    }
  }
  ;(globalThis as any).MessageEvent = MessageEventPolyfill
}

// Node doesn't provide atob/btoa; provide minimal polyfills for text use
if (!(globalThis as any).btoa) {
  ;(globalThis as any).btoa = (str: string) =>
    Buffer.from(str, "binary").toString("base64")
}
if (!(globalThis as any).atob) {
  ;(globalThis as any).atob = (b64: string) =>
    Buffer.from(b64, "base64").toString("binary")
}

async function startTunnelApp() {
  const app = express()

  app.get("/hello", (_req: Request, res: Response) => {
    res.status(200).send("world")
  })

  app.post("/echo", (req: Request, res: Response) => {
    res.status(200).json({ received: (req as any).body })
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
  tunnelClient: TunnelClient
) {
  try {
    // Prevent client from scheduling reconnect timers
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

test.serial("GET fetch through tunnel", async (t) => {
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

test.serial("POST fetch through tunnel", async (t) => {
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

test.serial("WebSocket lifecycle over tunnel (terminates at server wss)", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startTunnelApp()

  // Attach an echo handler to the server's built-in WebSocketServer
  tunnelServer.wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      ws.send(data)
    })
  })

  try {
    const withTimeout = async <T>(p: Promise<T>, ms: number, label: string) => {
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
      "open"
    )

    const earlyClosed = withTimeout(
      new Promise<void>((resolve) => {
        ws.addEventListener("close", () => resolve())
      }),
      4000,
      "early close"
    )
      .then(() => true)
      .catch(() => false)

    await opened
    t.is(ws.readyState, ws.OPEN)

    const message = withTimeout(
      new Promise<string>((resolve) => {
        ws.addEventListener("message", (evt: any) => resolve(String(evt.data)))
      }),
      2000,
      "message"
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
})
