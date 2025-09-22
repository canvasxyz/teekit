import test from "ava"
import type { AddressInfo } from "node:net"

import { TunnelClient, TunnelServer } from "ra-https-tunnel"
import { startTunnelApp, stopTunnel } from "./tunnel.test.js"

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

function withTimeout<T>(p: Promise<T>, ms: number, label: string) {
  let to: any
  const timeout = new Promise<never>((_, reject) => {
    to = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(to)) as Promise<T>
}

test.serial("Client WS API: text, binary, events, queueing, bufferedAmount", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startTunnelApp()

  // Echo server and initial greeting
  tunnelServer.wss.on("connection", (ws) => {
    ws.send("hello")
    ws.on("message", (data: any) => ws.send(data))
  })

  try {
    const TunnelWS = tunnelClient.WebSocket
    const ws = new TunnelWS(origin.replace(/^http/, "ws"))

    // Ready state constants
    t.is(ws.CONNECTING, 0)
    t.is(ws.OPEN, 1)
    t.is(ws.CLOSING, 2)
    t.is(ws.CLOSED, 3)

    // Queue some messages before open
    ws.send("early1")
    ws.send(new Uint8Array([9, 8, 7]))

    // Support both onopen and addEventListener
    // Attach message listener BEFORE awaiting open to not miss server greeting
    const gotThree = withTimeout(
      new Promise<string[]>((resolve) => {
        const msgs: string[] = []
        const handler = (evt: any) => {
          const v = typeof evt.data === "string" ? evt.data : "<bin>"
          msgs.push(v)
          if (msgs.length >= 3) {
            ws.removeEventListener("message", handler as any)
            resolve(msgs)
          }
        }
        ws.addEventListener("message", handler as any)
      }),
      2000,
      "first messages",
    )

    const opened = withTimeout(
      new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      }),
      2000,
      "open",
    )
    await opened
    t.is(ws.readyState, ws.OPEN)
    const first = await gotThree
    t.deepEqual(first.slice(0, 2), ["hello", "early1"]) // greeting + first queued

    // bufferedAmount should have increased (monotonic in this mock)
    const before = ws.bufferedAmount

    // Prepare listeners BEFORE sending to avoid races
    const gotPing = withTimeout(
      new Promise<string>((resolve) => {
        const handler = (evt: any) => {
          if (typeof evt.data === "string" && evt.data === "ping") {
            ws.removeEventListener("message", handler as any)
            resolve("ping")
          }
        }
        ws.addEventListener("message", handler as any)
      }),
      2000,
      "ping echo",
    )
    const gotBin = withTimeout(
      new Promise<ArrayBuffer>((resolve) => {
        const handler = (evt: any) => {
          if (typeof evt.data !== "string") {
            ws.removeEventListener("message", handler as any)
            resolve(evt.data as ArrayBuffer)
          }
        }
        ws.addEventListener("message", handler as any)
      }),
      2000,
      "binary echo",
    )

    // Now send both messages
    ws.send("ping")
    ws.send(new Uint8Array([1, 2, 3, 4, 0]))
    t.true(ws.bufferedAmount >= before)

    t.is(await gotPing, "ping")
    const ab = await gotBin
    t.true(ab instanceof ArrayBuffer)
    const nums = Array.from(new Uint8Array(ab))
    // Echo for [1,2,3,4,0] (ensure binary path via null byte)
    t.deepEqual(nums, [1, 2, 3, 4, 0])

    // Changing binaryType currently has no effect, but should not throw
    ws.binaryType = "arraybuffer"
    t.is(ws.binaryType, "arraybuffer")

    // Sending ArrayBufferLike and ArrayBufferView variants
    const buf = new Uint8Array([5, 6, 7, 8]).buffer
    ws.send(buf)
    ws.send(new DataView(new Uint8Array([10, 20]).buffer))

    // Blob is unsupported in this mock; ensure it throws
    const blobErr = t.throws(() => {
      const anyBlob: any = { size: 2, type: "application/octet-stream" }
      ;(ws as any).send(anyBlob)
    })
    t.truthy(blobErr)

    ws.close(1000, "done")
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("Server initiated close propagates to client with code/reason", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startTunnelApp()

  let serverSocket: any
  tunnelServer.wss.on("connection", (ws) => {
    serverSocket = ws
  })

  try {
    const TunnelWS = tunnelClient.WebSocket
    const ws = new TunnelWS(origin.replace(/^http/, "ws"))
    await withTimeout(new Promise((r) => ws.addEventListener("open", () => r(null))), 2000, "open")

    const closed = withTimeout(
      new Promise<{ code: number; reason: string }>((resolve) => {
        ws.addEventListener("close", (evt: any) =>
          resolve({ code: evt.code, reason: evt.reason }),
        )
      }),
      2000,
      "close",
    )

    // Close from server side
    serverSocket.close(3001, "bye")
    const { code, reason } = await closed
    t.is(code, 3001)
    t.is(reason, "bye")
    t.is(ws.readyState, ws.CLOSED)
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("Client close triggers server close event and wss.clients shrinks", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startTunnelApp()

  let serverSocket: any
  const clientConnected = new Promise<void>((resolve) => {
    tunnelServer.wss.on("connection", (ws) => {
      serverSocket = ws
      resolve()
    })
  })

  try {
    const TunnelWS = tunnelClient.WebSocket
    const ws = new TunnelWS(origin.replace(/^http/, "ws"))
    await withTimeout(new Promise((r) => ws.addEventListener("open", () => r(null))), 2000, "open")
    await withTimeout(clientConnected, 2000, "server connection")

    t.is(tunnelServer.wss.clients.size, 1)

    const serverClosed = withTimeout(
      new Promise<{ code: number; reason: string }>((resolve) => {
        serverSocket.on("close", (code: number, reason: string) =>
          resolve({ code, reason }),
        )
      }),
      2000,
      "server close event",
    )

    ws.close(1000, "done")
    const s = await serverClosed
    t.is(s.code, 1000)
    t.is(s.reason, "done")

    // Give server time to update the set
    await new Promise((r) => setTimeout(r, 50))
    t.is(tunnelServer.wss.clients.size, 0)
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("Port mismatch triggers client error event", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startTunnelApp()

  try {
    const badPort = (Number((new URL(origin)).port) + 1).toString()
    const badUrl = origin.replace(/^http:\/\//, `ws://`).replace(/:(\d+)/, `:${badPort}`)

    const TunnelWS = tunnelClient.WebSocket
    const ws = new TunnelWS(badUrl)

    const err = await withTimeout(
      new Promise<string>((resolve) => {
        ws.addEventListener("error", (evt: any) => resolve((evt as any).message || "err"))
      }),
      2000,
      "error",
    )
    t.true(typeof err === "string")
    t.is(ws.readyState, ws.CONNECTING) // did not open

    // Cleanup
    ws.close()
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("Send after client close throws", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startTunnelApp()

  tunnelServer.wss.on("connection", (ws) => {
    ws.on("message", (data: any) => ws.send(data))
  })

  try {
    const TunnelWS = tunnelClient.WebSocket
    const ws = new TunnelWS(origin.replace(/^http/, "ws"))
    await withTimeout(new Promise((r) => ws.addEventListener("open", () => r(null))), 2000, "open")
    ws.close(1000, "bye")

    const err = t.throws(() => ws.send("x"))
    t.truthy(err)
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("Server can send non-text Buffer; client receives ArrayBuffer", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startTunnelApp()

  tunnelServer.wss.on("connection", (ws) => {
    // Send bytes containing a null to force binary path
    ws.send(Buffer.from([65, 0, 66, 255]))
  })

  try {
    const TunnelWS = tunnelClient.WebSocket
    const ws = new TunnelWS(origin.replace(/^http/, "ws"))

    const got = await withTimeout(
      new Promise<ArrayBuffer>((resolve) => {
        ws.addEventListener("message", (evt: any) => {
          if (typeof evt.data !== "string") resolve(evt.data as ArrayBuffer)
        })
      }),
      2000,
      "binary delivery",
    )
    const arr = Array.from(new Uint8Array(got))
    t.deepEqual(arr, [65, 0, 66, 255])
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

