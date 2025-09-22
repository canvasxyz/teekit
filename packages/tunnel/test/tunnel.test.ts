import test from "ava"
import express, { Request, Response } from "express"
import type { AddressInfo } from "node:net"
import sodium from "libsodium-wrappers"

import { TunnelClient, TunnelServer } from "ra-https-tunnel"
import {
  tappdV4Base64,
  trusteeV5Base64,
  occlumSgxBase64,
} from "./samples/samples.js"
import { base64 } from "@scure/base"
import { hex, parseTdxQuote } from "ra-https-qvl"

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

// Polyfills for CloseEvent used by ClientRAMockWebSocket in Node
if (!(globalThis as any).CloseEvent) {
  class CloseEventPolyfill extends Event {
    public code: number
    public reason: string
    public wasClean: boolean
    constructor(type: string, init?: any) {
      super(type)
      this.code = init?.code ?? 0
      this.reason = init?.reason ?? ""
      this.wasClean = !!init?.wasClean
    }
  }
  ;(globalThis as any).CloseEvent = CloseEventPolyfill as any
}

test.serial(
  "WebSocket binary payloads (string, Uint8Array, DataView, ArrayBuffer)",
  async (t) => {
    const { tunnelServer, tunnelClient, origin } = await startTunnelApp()

    // Echo handler on server side
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
      const ws: any = new TunnelWS(origin.replace(/^http/, "ws"))

      await withTimeout(
        new Promise<void>((resolve) =>
          ws.addEventListener("open", () => resolve()),
        ),
        3000,
        "open",
      )

      // 1) String round-trip
      const m1P = withTimeout(
        new Promise<any>((resolve) =>
          ws.addEventListener("message", (evt: any) => resolve(evt)),
        ),
        2000,
        "message1",
      )
      ws.send("hello")
      const m1 = await m1P
      t.is(String(m1.data), "hello")

      // 2) ASCII bytes should come back as text
      const ascii = new TextEncoder().encode("ascii-bytes")
      const m2P = withTimeout(
        new Promise<any>((resolve) =>
          ws.addEventListener("message", (evt: any) => resolve(evt)),
        ),
        2000,
        "message2",
      )
      ws.send(ascii)
      const m2 = await m2P
      t.is(typeof m2.data, "string")
      t.is(m2.data, "ascii-bytes")

      // 3) Non-text bytes should come back as binary
      const bin = new Uint8Array([0, 255, 1, 2, 3])
      const m3P = withTimeout(
        new Promise<any>((resolve) =>
          ws.addEventListener("message", (evt: any) => resolve(evt)),
        ),
        2000,
        "message3",
      )
      ws.send(bin)
      const m3 = await m3P
      t.true(m3.data instanceof ArrayBuffer)
      t.deepEqual(new Uint8Array(m3.data), bin)

      // 4) DataView round-trip as binary
      const buf = new Uint8Array([0, 128, 7]).buffer
      const dv = new DataView(buf)
      const m4P = withTimeout(
        new Promise<any>((resolve) =>
          ws.addEventListener("message", (evt: any) => resolve(evt)),
        ),
        2000,
        "message4",
      )
      ws.send(dv)
      const m4 = await m4P
      t.true(m4.data instanceof ArrayBuffer)
      t.deepEqual(new Uint8Array(m4.data), new Uint8Array(buf))

      // 5) ArrayBuffer round-trip
      const ab = new Uint8Array([0, 5, 6, 7]).buffer
      const m5P = withTimeout(
        new Promise<any>((resolve) =>
          ws.addEventListener("message", (evt: any) => resolve(evt)),
        ),
        2000,
        "message5",
      )
      ws.send(ab)
      const m5 = await m5P
      t.true(m5.data instanceof ArrayBuffer)
      t.deepEqual(new Uint8Array(m5.data), new Uint8Array(ab))

      // Close
      // Initiate close and do not wait for client-side close event,
      // as the mocked server may already have transitioned state.
      try {
        ws.close(1000, "done")
      } catch {}
    } finally {
      await stopTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial("Server broadcast and server-initiated close", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startTunnelApp()

  // Echo handler on server side
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
    const ws1: any = new TunnelWS(origin.replace(/^http/, "ws"))
    const ws2: any = new TunnelWS(origin.replace(/^http/, "ws"))

    await Promise.all([
      withTimeout(
        new Promise<void>((r) => ws1.addEventListener("open", () => r())),
        3000,
        "open1",
      ),
      withTimeout(
        new Promise<void>((r) => ws2.addEventListener("open", () => r())),
        3000,
        "open2",
      ),
    ])

    // Broadcast
    for (const client of Array.from(tunnelServer.wss.clients)) {
      client.send("hello-all")
    }

    const m1 = withTimeout(
      new Promise<any>((r) => ws1.addEventListener("message", (e: any) => r(e))),
      2000,
      "m1",
    )
    const m2 = withTimeout(
      new Promise<any>((r) => ws2.addEventListener("message", (e: any) => r(e))),
      2000,
      "m2",
    )
    t.is(String((await m1).data), "hello-all")
    t.is(String((await m2).data), "hello-all")

    // Server closes one
    const [serverWs] = Array.from(tunnelServer.wss.clients)
    const c1 = withTimeout(
      new Promise<any>((r) => ws1.addEventListener("close", (e: any) => r(e))),
      2000,
      "c1",
    )
    serverWs.close(1001, "server closing")
    const ev = await c1
    t.is(ev.code, 1001)
    t.is(ev.reason, "server closing")

    // Close remaining via wss.close
    const c2 = withTimeout(
      new Promise<void>((r) => ws2.addEventListener("close", () => r())),
      2000,
      "c2",
    )
    await new Promise<void>((resolve) => tunnelServer.wss.close(() => resolve()))
    await c2
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})
