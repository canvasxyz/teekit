import test from "ava"
import type { AddressInfo } from "node:net"
import express from "express"
import sodium from "libsodium-wrappers"

import { TunnelClient, TunnelServer } from "../src/index.js"
import { parseTdxQuote, hex } from "../../qvl/src/index.js"
import { base64 } from "@scure/base"
import { tappdV4Base64 } from "./samples/samples.js"

// Ensure timers don't keep `npx ava --watch` alive (client sets 30s timeouts)
const originalSetTimeout = setTimeout
;(globalThis as any).setTimeout = ((fn: any, ms?: any, ...args: any[]) => {
  const handle: any = (originalSetTimeout as any)(fn, ms, ...args)
  if (handle && typeof handle.unref === "function") handle.unref()
  return handle
}) as any

async function startApp() {
  await sodium.ready
  const app = express()

  // Collect raw body for all requests to enable binary/large length checks
  app.use((req, _res, next) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(Buffer.from(c)))
    req.on("end", () => {
      const buf = Buffer.concat(chunks)
      ;(req as any).rawBody = buf
      ;(req as any).body = buf.length ? buf.toString("utf8") : ""
      next()
    })
  })

  app.all("/echo-all", (req: any, res: any) => {
    res.status(200).json({
      method: req.method,
      url: (req as any).originalUrl ?? req.url,
      headers: req.headers,
      query: (req as any).query || {},
      body: (req as any).body,
    })
  })

  app.post("/echo", (req: any, res: any) => {
    res.status(200).json({ received: (req as any).body })
  })

  app.get("/hello", (_req, res) => res.status(200).send("world"))
  app.get("/ok", (_req, res) => res.status(200).send("ok"))
  app.get("/json", (_req: any, res: any) => {
    res.status(200).json({ ok: true, nested: { a: 1, b: "two" } })
  })
  app.get("/text", (_req: any, res: any) => {
    res.status(200).send("text-ok")
  })
  app.get("/binary", (_req: any, res: any) => {
    const bytes = Uint8Array.from([0, 1, 2, 255])
    res.status(200).setHeader("content-type", "application/octet-stream")
    res.send(Buffer.from(bytes))
  })
  app.get("/set-cookie", (_req: any, res: any) => {
    res.setHeader("set-cookie", [
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/; SameSite=Strict",
    ])
    res.status(200).send("ok")
  })
  app.get("/redirect", (_req: any, res: any) => {
    res.redirect(302, "/hello")
  })
  app.head("/head", (_req: any, res: any) => {
    res.setHeader("x-head", "1")
    res.status(204).end()
  })
  app.get("/stream", (_req: any, res: any) => {
    res.setHeader("content-type", "text/plain; charset=utf-8")
    res.write("chunk-1:")
    res.write("chunk-2:")
    res.end("done")
  })
  app.get("/status/:code", (req: any, res: any) => {
    const code = Number((req as any).params.code)
    res.status(Number.isFinite(code) ? code : 500).send(`status-${code}`)
  })
  app.post("/echo-large-len", (req: any, res: any) => {
    let length = 0
    const body: any = (req as any).body
    if (typeof body === "string") length = Buffer.byteLength(body)
    else if (Buffer.isBuffer(body)) length = body.length
    else if (body != null) length = Buffer.byteLength(JSON.stringify(body))
    res.status(200).json({ length })
  })

  const quote = base64.decode(tappdV4Base64)
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

async function stop(tunnelServer: any, tunnelClient: any) {
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

test.serial("fetch GET via string URL", async (t) => {
  const { tunnelServer, tunnelClient } = await startApp()
  try {
    const res = await tunnelClient.fetch("/hello")
    t.is(res.status, 200)
    t.is(await res.text(), "world")
  } finally {
    await stop(tunnelServer, tunnelClient)
  }
})

test.serial("fetch GET via Request object", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startApp()
  try {
    const req = new Request(`${origin}/ok`)
    const res = await tunnelClient.fetch(req)
    t.is(res.status, 200)
    t.is(await res.text(), "ok")
  } finally {
    await stop(tunnelServer, tunnelClient)
  }
})

test.serial("fetch GET via URL object", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startApp()
  try {
    const url = new URL(`${origin}/ok`)
    const res = await tunnelClient.fetch(url)
    t.is(res.status, 200)
    t.is(await res.text(), "ok")
  } finally {
    await stop(tunnelServer, tunnelClient)
  }
})

test.serial("fetch methods: GET, POST, PUT, PATCH, DELETE", async (t) => {
  const { tunnelServer, tunnelClient } = await startApp()
  try {
    // GET
    let res = await tunnelClient.fetch("/echo-all?x=1")
    t.is(res.status, 200)
    let json: any = await res.json()
    t.is(json.method, "GET")
    t.deepEqual(json.query, { x: "1" })

    // POST
    res = await tunnelClient.fetch("/echo-all?y=2", { method: "POST" })
    t.is(res.status, 200)
    json = await res.json()
    t.is(json.method, "POST")
    t.deepEqual(json.query, { y: "2" })

    // PUT
    res = await tunnelClient.fetch("/echo-all", { method: "PUT" })
    t.is(res.status, 200)
    json = await res.json()
    t.is(json.method, "PUT")

    // PATCH
    res = await tunnelClient.fetch("/echo-all", { method: "PATCH" })
    t.is(res.status, 200)
    json = await res.json()
    t.is(json.method, "PATCH")

    // DELETE
    res = await tunnelClient.fetch("/echo-all", { method: "DELETE" })
    t.is(res.status, 200)
    json = await res.json()
    t.is(json.method, "DELETE")
  } finally {
    await stop(tunnelServer, tunnelClient)
  }
})

test.serial("fetch headers variations and query params", async (t) => {
  const { tunnelServer, tunnelClient } = await startApp()
  try {
    // Object headers
    let res = await tunnelClient.fetch("/echo-all?foo=bar&baz=qux", {
      headers: { "x-custom": "value", accept: "application/json" },
    })
    t.is(res.status, 200)
    let json: any = await res.json()
    t.is(json.headers["x-custom"], "value")
    t.deepEqual(json.query, { foo: "bar", baz: "qux" })

    // Headers instance
    const h = new Headers()
    h.set("x-one", "1")
    h.append("x-one", "2")
    h.set("content-type", "text/plain")
    res = await tunnelClient.fetch("/echo-all", { method: "POST", headers: h, body: "abc" })
    t.is(res.status, 200)
    json = await res.json()
    t.true(String(json.headers["x-one"]).includes("1"))
    t.true(String(json.headers["x-one"]).includes("2"))
    t.is(json.body, "abc")

    // Array headers
    const arrHeaders: [string, string][] = [["x-two", "2"], ["x-three", "3"]]
    res = await tunnelClient.fetch("/echo-all?z=9", { headers: arrHeaders })
    t.is(res.status, 200)
    json = await res.json()
    t.is(json.headers["x-two"], "2")
    t.is(json.headers["x-three"], "3")
    t.deepEqual(json.query, { z: "9" })
  } finally {
    await stop(tunnelServer, tunnelClient)
  }
})

test.serial("fetch body types: text, json, urlencoded, form-data, binary, large, empty", async (t) => {
  const { tunnelServer, tunnelClient } = await startApp()
  try {
    // text
    let res = await tunnelClient.fetch("/echo", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello text",
    })
    t.is(res.status, 200)
    let json: any = await res.json()
    t.is(json.received, "hello text")

    // json string body
    const obj = { a: 1, b: "two" }
    res = await tunnelClient.fetch("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(obj),
    })
    t.is(res.status, 200)
    json = await res.json()
    t.is(json.received, JSON.stringify(obj))

    // urlencoded
    const params = new URLSearchParams({ p: "1", q: "two" })
    res = await tunnelClient.fetch("/echo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    })
    t.is(res.status, 200)
    json = await res.json()
    t.is(json.received, params.toString())

    // multipart form-data (prebuilt body)
    const boundary = "----rahttpsboundary"
    const formParts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="field1"\r\n\r\nvalue1\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello-file\r\n`,
      `--${boundary}--\r\n`,
    ]
    const formBody = formParts.join("")
    res = await tunnelClient.fetch("/echo", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: formBody,
    })
    t.is(res.status, 200)
    json = await res.json()
    t.is(json.received, formBody)

    // binary (send latin1 string, count bytes on server)
    const binary = Buffer.from([0, 1, 2, 3, 254, 255])
    res = await tunnelClient.fetch("/echo-large-len", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: binary.toString("binary"),
    })
    t.is(res.status, 200)
    json = await res.json()
    t.true(typeof json.length === "number")
    t.true(json.length > 0)

    // large payload (~1MiB)
    const large = "x".repeat(1024 * 1024)
    res = await tunnelClient.fetch("/echo-large-len", {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: large,
    })
    t.is(res.status, 200)
    json = await res.json()
    t.is(json.length, large.length)

    // empty body
    res = await tunnelClient.fetch("/echo", { method: "POST" })
    t.is(res.status, 200)
    json = await res.json()
    t.is(json.received, "")
  } finally {
    await stop(tunnelServer, tunnelClient)
  }
})

test.serial("response handling: json, text, arrayBuffer, cookies, status, redirect, head, streaming", async (t) => {
  const { tunnelServer, tunnelClient } = await startApp()
  try {
    // JSON
    let res = await tunnelClient.fetch("/json")
    t.is(res.status, 200)
    let json = await res.json()
    t.deepEqual(json, { ok: true, nested: { a: 1, b: "two" } })

    // text
    res = await tunnelClient.fetch("/text")
    t.is(res.status, 200)
    t.is(await res.text(), "text-ok")

    // arrayBuffer from binary response
    res = await tunnelClient.fetch("/binary")
    t.is(res.status, 200)
    const buf = new Uint8Array(await res.arrayBuffer())
    t.deepEqual(Array.from(buf), [0, 1, 2, 255])

    // cookies
    res = await tunnelClient.fetch("/set-cookie")
    t.is(res.status, 200)
    const setCookie = res.headers.get("set-cookie")
    t.truthy(setCookie)

    // redirect (expect 302, not auto-followed)
    res = await tunnelClient.fetch("/redirect")
    t.is(res.status, 302)
    t.truthy(res.headers.get("location"))

    // head
    res = await tunnelClient.fetch("/head", { method: "HEAD" })
    t.is(res.status, 204)
    t.is(res.headers.get("x-head"), "1")

    // streaming - concatenated body
    res = await tunnelClient.fetch("/stream")
    t.is(res.status, 200)
    t.is(await res.text(), "chunk-1:chunk-2:done")

    // status matrix
    for (const code of [200, 201, 204, 400, 404, 500]) {
      const r = await tunnelClient.fetch(`/status/${code}`)
      t.is(r.status, code)
    }
  } finally {
    await stop(tunnelServer, tunnelClient)
  }
})