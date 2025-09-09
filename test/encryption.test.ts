import test from "ava"
import express, { Request, Response } from "express"
import type { AddressInfo } from "node:net"

import { RA as TunnelServer } from "../tunnel/server.ts"
import { RA as TunnelClient } from "../tunnel/client.ts"

// Ensure timers don't keep the process alive (client sets reconnect timers)
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

  app.get("/ok", (_req: Request, res: Response) => {
    res.status(200).send("ok")
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

async function stopTunnel(tunnelServer: TunnelServer, tunnelClient: TunnelClient) {
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

test.serial(
  "server warns and ignores plaintext after handshake (client encrypts)",
  async (t) => {
    const { tunnelServer, tunnelClient } = await startTunnelApp()

    const originalWarn = console.warn
    const warns: any[] = []
    console.warn = (...args: any[]) => {
      warns.push(args)
      originalWarn(...args)
    }

    try {
      const res = await tunnelClient.fetch("/ok")
      t.is(res.status, 200)
      await res.text()

      // Send a bogus plaintext message directly on the socket (should be ignored)
      const ws: any = (tunnelClient as any).ws
      ws.send(
        JSON.stringify({
          type: "http_request",
          requestId: "bogus",
          method: "GET",
          url: "/ok",
          headers: {},
        })
      )

      // Give server a moment to process
      await new Promise((r) => setTimeout(r, 50))

      t.true(
        warns.some((w) => String(w[0] || "").includes("Dropping unexpected plaintext message")),
        "server should warn about plaintext"
      )
    } finally {
      console.warn = originalWarn
      await stopTunnel(tunnelServer, tunnelClient)
    }
  }
)

test.serial("client ignores unexpected plaintext from server after handshake", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelApp()

  // Once connection is established, inject a plaintext ws_event which should be ignored
  tunnelServer.wss.on("connection", (ws) => {
    // Delay to allow handshake to complete
    setTimeout(() => {
      try {
        ws.send(
          JSON.stringify({
            type: "ws_event",
            connectionId: "bogus",
            eventType: "error",
            error: "should be ignored",
          })
        )
      } catch {}
    }, 50)
  })

  try {
    // A regular fetch should still succeed
    const res = await tunnelClient.fetch("/ok")
    t.is(res.status, 200)
    const body = await res.text()
    t.is(body, "ok")
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

