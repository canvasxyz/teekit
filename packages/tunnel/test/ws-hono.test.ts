import test from "ava"
import { startHonoTunnelApp, stopTunnel } from "./helpers/helpers.js"

function withTimeout<T>(p: Promise<T>, ms: number, label: string) {
  let to: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    to = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
  })
  return Promise.race([p, timeout]).finally(() =>
    clearTimeout(to),
  ) as Promise<T>
}

test.serial("WS echo with Hono app", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()

  // Echo server and initial greeting
  tunnelServer.wss.on("connection", (ws) => {
    ws.send("hello")
    ws.on("message", (data) => ws.send(data))
  })

  try {
    const TunnelWS = tunnelClient.WebSocket
    const ws = new TunnelWS(origin.replace(/^http/, "ws"))

    // Prepare listeners before awaiting open to avoid missing server greeting
    const first = withTimeout(
      new Promise<string>((resolve) => {
        const handler = (evt: any) => {
          ws.removeEventListener("message", handler)
          resolve(String(evt.data))
        }
        ws.addEventListener("message", handler)
      }),
      2000,
      "first",
    )

    const opened = withTimeout(
      new Promise<void>((resolve) =>
        ws.addEventListener("open", () => resolve()),
      ),
      2000,
      "open",
    )
    await opened
    t.is(ws.readyState, ws.OPEN)
    t.is(await first, "hello")

    const echoed = withTimeout(
      new Promise<string>((resolve) => {
        const handler = (evt: any) => {
          ws.removeEventListener("message", handler)
          resolve(String(evt.data))
        }
        ws.addEventListener("message", handler)
      }),
      2000,
      "echo",
    )
    ws.send("ping")
    t.is(await echoed, "ping")

    ws.close(1000, "done")
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("Hono context is forwarded to WebSocket consumers", async (t) => {
  t.plan(3)
  const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()

  const messageHandled = new Promise<void>((resolve) => {
    tunnelServer.wss.on("connection", (ws, honoContext) => {
      t.truthy(honoContext)
      t.is(honoContext?.req.path, "/__ra__")

      ws.on("message", (_data, ctxFromMessage) => {
        t.is(ctxFromMessage, honoContext)
        resolve()
      })
    })
  })

  try {
    const TunnelWS = tunnelClient.WebSocket
    const ws = new TunnelWS(origin.replace(/^http/, "ws"))

    await new Promise<void>((resolve) =>
      ws.addEventListener("open", () => resolve()),
    )

    ws.send("ping")

    await messageHandled

    ws.close(1000, "done")
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial(
  "Client WS API: text, binary, events, queueing, bufferedAmount",
  async (t) => {
    const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()

    // Echo server and initial greeting
    tunnelServer.wss.on("connection", (ws) => {
      ws.send("hello")
      ws.on("message", (data) => ws.send(data))
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
              ws.removeEventListener("message", handler)
              resolve(msgs)
            }
          }
          ws.addEventListener("message", handler)
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
              ws.removeEventListener("message", handler)
              resolve("ping")
            }
          }
          ws.addEventListener("message", handler)
        }),
        2000,
        "ping echo",
      )
      const gotBin = withTimeout(
        new Promise<ArrayBuffer>((resolve) => {
          const handler = (evt: any) => {
            if (typeof evt.data !== "string") {
              ws.removeEventListener("message", handler)
              resolve(evt.data as ArrayBuffer)
            }
          }
          ws.addEventListener("message", handler)
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
        ws.send(anyBlob)
      })
      t.truthy(blobErr)

      ws.close(1000, "done")
    } finally {
      await stopTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "Server initiated close propagates to client with code/reason",
  async (t) => {
    const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()

    let serverSocket: any
    tunnelServer.wss.on("connection", (ws) => {
      serverSocket = ws
    })

    try {
      const TunnelWS = tunnelClient.WebSocket
      const ws = new TunnelWS(origin.replace(/^http/, "ws"))
      await withTimeout(
        new Promise((r) => ws.addEventListener("open", () => r(null))),
        2000,
        "open",
      )

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
  },
)

test.serial(
  "Client close triggers server close event and wss.clients shrinks",
  async (t) => {
    const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()

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
      await withTimeout(
        new Promise((r) => ws.addEventListener("open", () => r(null))),
        2000,
        "open",
      )
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
  },
)

test.serial("Port mismatch triggers client error event", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()

  try {
    const badPort = (Number(new URL(origin).port) + 1).toString()
    const badUrl = origin
      .replace(/^http:\/\//, `ws://`)
      .replace(/:(\d+)/, `:${badPort}`)

    const TunnelWS = tunnelClient.WebSocket
    const ws = new TunnelWS(badUrl)

    const err = await withTimeout(
      new Promise<string>((resolve) => {
        ws.addEventListener("error", (evt: any) =>
          resolve(evt.message || "err"),
        )
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
  const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()

  tunnelServer.wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send(data))
  })

  try {
    const TunnelWS = tunnelClient.WebSocket
    const ws = new TunnelWS(origin.replace(/^http/, "ws"))
    await withTimeout(
      new Promise((r) => ws.addEventListener("open", () => r(null))),
      2000,
      "open",
    )
    ws.close(1000, "bye")

    const err = t.throws(() => ws.send("x"))
    t.truthy(err)
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial(
  "Server can send non-text Buffer; client receives ArrayBuffer",
  async (t) => {
    const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()

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
  },
)

test.serial(
  "WebSocket binary payloads (string, Uint8Array, DataView, ArrayBuffer)",
  async (t) => {
    const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()

    // Echo handler on server side
    tunnelServer.wss.on("connection", (ws) => {
      ws.on("message", (data) => ws.send(data))
    })

    try {
      const TunnelWS = tunnelClient.WebSocket
      const ws = new TunnelWS(origin.replace(/^http/, "ws"))

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

      // 2) ASCII bytes should come back as binary
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
      t.true(m2.data instanceof ArrayBuffer)
      t.is(new TextDecoder().decode(m2.data), "ascii-bytes")

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
  const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()

  // Echo handler on server side
  tunnelServer.wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send(data))
  })

  try {
    const TunnelWS = tunnelClient.WebSocket
    const ws1 = new TunnelWS(origin.replace(/^http/, "ws"))
    const ws2 = new TunnelWS(origin.replace(/^http/, "ws"))

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
      new Promise<any>((r) =>
        ws1.addEventListener("message", (e: any) => r(e)),
      ),
      2000,
      "m1",
    )
    const m2 = withTimeout(
      new Promise<any>((r) =>
        ws2.addEventListener("message", (e: any) => r(e)),
      ),
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
    await new Promise<void>((resolve) =>
      tunnelServer.wss.close(() => resolve()),
    )
    await c2
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial(
  "WebSocket lifecycle over tunnel (terminates at server wss)",
  async (t) => {
    const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()

    // Attach an echo handler to the server's built-in WebSocketServer
    tunnelServer.wss.on("connection", (ws) => {
      ws.on("message", (data) => ws.send(data))
    })

    try {
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
