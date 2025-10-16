import test from "ava"
import { startHonoTunnelApp, stopTunnel } from "./helpers/helpers.js"

test.serial("GET and JSON with Hono app", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()
  try {
    const res1 = await tunnelClient.fetch("/hello")
    t.is(res1.status, 200)
    t.is(await res1.text(), "world")

    const res2 = await tunnelClient.fetch("/ok")
    t.is(res2.status, 200)
    t.is(await res2.text(), "ok")

    const res3 = await tunnelClient.fetch(origin + "/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    })
    t.is(res3.status, 200)
    const json = await res3.json()
    t.is(json.method, "POST")
    t.deepEqual(json.body, { a: 1 })
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("form-urlencoded with Hono app", async (t) => {
  const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()
  try {
    const form = new URLSearchParams({ a: "1", b: "two" }).toString()
    const res = await tunnelClient.fetch(origin + "/echo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    })
    t.is(res.status, 200)
    const json = await res.json()
    t.is(json.method, "POST")
    t.deepEqual(json.body, { a: "1", b: "two" })
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("GET with query params and headers (string URL)", async (t) => {
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
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
  const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()
  try {
    const res = await tunnelClient.fetch(new URL(origin + "/text"))
    t.is(res.status, 200)
    t.is(await res.text(), "hello text")
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("HEAD request returns no body and custom header", async (t) => {
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
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
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
  try {
    const res = await tunnelClient.fetch("/anything", { method: "OPTIONS" })
    t.is(res.status, 204)
    t.truthy(res.headers.get("allow"))
  } finally {
    await stopTunnel(tunnelServer, tunnelClient)
  }
})

test.serial("POST JSON body and json() response", async (t) => {
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
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
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
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
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
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
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
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
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
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
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
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
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
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

test.serial(
  "Hono preserves multi-value headers (including Set-Cookie)",
  async (t) => {
    const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
    try {
      const res = await tunnelClient.fetch("/set-headers")
      t.is(res.status, 200)

      // X-Custom-A is a single header
      t.is(res.headers.get("x-custom-a"), "A")

      // X-Custom-B should include both values; Headers.get joins with ','
      // and Headers.getAll (deprecated) is not available in Fetch standard.
      const allB = res.headers.get("x-custom-b")
      t.truthy(allB)
      t.true((allB as string).includes("B1"))
      t.true((allB as string).includes("B2"))

      // Multiple Set-Cookie values survive; Fetch exposes only get().
      // We rely on the tunnel client reconstruction that appended both values.
      const cookiesJoined = res.headers.get("set-cookie")
      t.truthy(cookiesJoined)
      t.true((cookiesJoined as string).includes("a=1"))
      t.true((cookiesJoined as string).includes("b=2"))
    } finally {
      await stopTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "Server-side streamed response is concatenated in body",
  async (t) => {
    const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
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
  const { tunnelServer, tunnelClient, origin } = await startHonoTunnelApp()
  try {
    const req = new Request(origin + "/echo", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-req": "1" },
      body: "from-request-object",
    })
    const res = await tunnelClient.fetch(req)
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
    const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
    try {
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
