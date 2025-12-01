import test from "ava"
import express from "express"
import type { AddressInfo } from "node:net"

import { TunnelClient, TunnelServer } from "@teekit/tunnel"
import { hex, parseTdxQuote } from "@teekit/qvl"

import { loadQuote } from "./helpers/helpers.js"

async function startTunnelFetchApp() {
  const app = express()

  // Basic endpoints
  app.get("/text", (_req, res) =>
    res.status(200).type("text/plain").send("hello text"),
  )
  app.get("/json", (_req, res) => res.status(200).json({ ok: true }))
  app.get("/query", (req, res) => res.status(200).json({ query: req.query }))
  app.get("/status/:code", (req, res) =>
    res.status(Number(req.params.code)).send(""),
  )

  // HEAD should return headers without a body
  app.head("/head", (_req, res) => {
    res.setHeader("x-head", "true")
    res.status(200).end()
  })

  // OPTIONS: advertise supported methods
  app.options("/anything", (_req, res) => {
    res.setHeader("Allow", "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS")
    res.status(204).end()
  })

  // Echo route: reflect method, headers, and body back
  const echoHandler = (req: express.Request, res: express.Response) => {
    res.status(200).json({
      method: req.method,
      // Node mocks may lowercase header keys; normalize to object of strings
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(", ") : String(v),
        ]),
      ),
      // Body is already parsed by tunnel server utilities when content-type is known
      body: req.body,
    })
  }
  app.post("/echo", echoHandler)
  app.put("/echo", echoHandler)
  app.patch("/echo", echoHandler)
  app.delete("/echo", echoHandler)

  // Return custom headers
  app.get("/set-headers", (_req, res) => {
    res.setHeader("X-Custom-A", "A")
    res.setHeader("X-Custom-B", ["B1", "B2"]) // multi-valued
    res.status(200).send("ok")
  })

  // Binary response of arbitrary size
  app.get("/bytes/:size", (req, res) => {
    const size = Math.min(
      2 * 1024 * 1024,
      Math.max(0, Number(req.params.size) || 0),
    )
    const buf = Buffer.alloc(size)
    for (let i = 0; i < size; i++) buf[i] = i % 256
    res.status(200).type("application/octet-stream").send(buf)
  })

  // Chunked/streamed response (server-side streaming)
  app.get("/stream", async (_req, res) => {
    res.status(200).type("text/plain")
    res.write("part1-")
    await new Promise((r) => setTimeout(r, 10))
    res.write("part2-")
    await new Promise((r) => setTimeout(r, 10))
    res.end("end")
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
    measurements: {
      mrtd: hex(quoteBodyParsed.mr_td),
      reportData: hex(quoteBodyParsed.report_data),
    },
    x25519Binding: () => true,
  })

  return { tunnelServer, tunnelClient, origin }
}

async function stopTunnel(
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
    tunnelServer.server!.close(() => resolve())
  })
}

test.serial("GET with query params and headers (string URL)", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
  try {
    const res = await tunnelClient.fetch("/query?foo=bar&x=1", {
      headers: { "x-test": "abc" },
    })
    t.is(res.status, 200)
    const json = await res.json()
    t.deepEqual(json, { query: { foo: "bar", x: "1" } })
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("GET using URL object and read text()", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startTunnelFetchApp()
  try {
    const res = await tunnelClient.fetch(new URL(origin + "/text"))
    t.is(res.status, 200)
    t.is(await res.text(), "hello text")
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("HEAD request returns no body and custom header", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
  try {
    const res = await tunnelClient.fetch("/head", { method: "HEAD" })
    t.is(res.status, 200)
    t.is(res.headers.get("x-head"), "true")
    t.is(await res.text(), "")
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("OPTIONS request", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
  try {
    const res = await tunnelClient.fetch("/anything", { method: "OPTIONS" })
    t.is(res.status, 204)
    t.truthy(res.headers.get("allow"))
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("POST JSON body and json() response", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
  try {
    const body = { name: "Ada", id: 7 }
    const res = await tunnelClient.fetch("/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "x-foo": "bar" },
      body: JSON.stringify(body),
    })
    t.is(res.status, 200)
    const json = await res.json()
    t.is(json.method, "POST")
    t.is(json.headers["x-foo"], "bar")
    t.deepEqual(json.body, body)
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("application/x-www-form-urlencoded body", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
  try {
    const form = new URLSearchParams({ a: "1", b: "two" }).toString()
    const res = await tunnelClient.fetch("/echo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    })
    t.is(res.status, 200)
    const json = await res.json()
    t.deepEqual(json.body, { a: "1", b: "two" })
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("multipart/form-data raw string body with boundary", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
  try {
    const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
    const multipart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="field1"',
      "",
      "value1",
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="a.txt"',
      "Content-Type: text/plain",
      "",
      "file-content",
      `--${boundary}--`,
      "",
    ].join("\r\n")

    const res = await tunnelClient.fetch("/echo", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: multipart,
    })
    t.is(res.status, 200)
    const json = await res.json()
    t.is(typeof json.body, "string")
    t.true(String(json.body).includes("form-data"))
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("PUT large text payload (~1MB)", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
  try {
    const big = "x".repeat(1024 * 1024)
    const res = await tunnelClient.fetch("/echo", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: big,
    })
    t.is(res.status, 200)
    const json = await res.json()
    t.is(typeof json.body, "string")
    t.is((json.body as string).length, big.length)
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("PATCH empty body", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
  try {
    const res = await tunnelClient.fetch("/echo", {
      method: "PATCH",
      headers: { "content-type": "text/plain" },
      body: "",
    })
    t.is(res.status, 200)
    const json = await res.json()
    t.is(json.body, "")
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("DELETE with custom headers and no body", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
  try {
    const res = await tunnelClient.fetch("/echo", {
      method: "DELETE",
      headers: new Headers([
        ["X-Custom", "yes"],
        ["X-Multi", "a"],
      ]),
    })
    t.is(res.status, 200)
    const json = await res.json()
    t.is(json.headers["x-custom"], "yes")
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("Response headers and arrayBuffer() for binary", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
  try {
    const res = await tunnelClient.fetch("/bytes/256")
    t.is(res.status, 200)
    t.is(res.headers.get("content-type"), "application/octet-stream")
    const buf = new Uint8Array(await res.arrayBuffer())
    t.is(buf.length, 256)
    t.is(buf[0], 0)
    t.is(buf[255], 255)
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("Express preserves multi-value headers", async (t) => {
  const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
  try {
    const res = await tunnelClient.fetch("/set-headers")
    t.is(res.status, 200)

    // Single header
    t.is(res.headers.get("x-custom-a"), "A")

    // Multi-value header should include both values when joined by Fetch.get()
    const headerB = res.headers.get("x-custom-b")
    t.truthy(headerB)
    t.true((headerB as string).includes("B1"))
    t.true((headerB as string).includes("B2"))
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial(
  "Server-side streamed response is concatenated in body",
  async (t) => {
    const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
    try {
      const res = await tunnelClient.fetch("/stream")
      t.is(res.status, 200)
      t.is(await res.text(), "part1-part2-end")
    } finally {
      await stopTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial("Request object input with method/body/headers", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startTunnelFetchApp()
  try {
    const req = new Request(origin + "/echo", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-req": "1" },
      body: "from-request-object",
    })
    const res = await tunnelClient.fetch(req)
    // Expected behavior: should be POST and echo the body; if tunnel client ignores Request init, this may fail
    t.is(res.status, 200)
    const json = await res.json()
    t.is(json.method, "POST")
    t.is(json.headers["x-req"], "1")
    t.is(json.body, "from-request-object")
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial(
  "Streaming request body (ReadableStream) if supported",
  async (t) => {
    const { tunnelServer, tunnelClient } = await startTunnelFetchApp()
    try {
      // Attempt to send a streaming body. If unsupported, this test may fail (by design per task instructions).
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk1-"))
          controller.enqueue(new TextEncoder().encode("chunk2"))
          controller.close()
        },
      })
      const res = await tunnelClient.fetch("/echo", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: stream,
      })
      t.is(res.status, 200)
      const json = await res.json()
      t.is(json.body, "chunk1-chunk2")
    } finally {
      await stopTunnel(tunnelServer, tunnelClient)
    }
  },
)
