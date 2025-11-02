import test from "ava"
import { registerTestLogging } from "./setup-logging.js"
import { WorkerResult } from "../server/startWorker.js"
import { WebSocket } from "ws"
import { connectWebSocket, startKettle, stopKettle } from "./helpers.js"

registerTestLogging(test)

let shared: WorkerResult | null = null

test.before(async () => {
  shared = await startKettle()
})

test.after.always(async () => {
  if (shared) {
    const kettle = shared
    shared = null
    await stopKettle(kettle)
  }
})

test.serial("bare fetch: GET /uptime returns uptime data", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const response = await fetch(`http://localhost:${kettle.workerPort}/uptime`)
  t.is(response.status, 200)
  const data = await response.json()
  t.truthy(data.uptime)
  t.truthy(data.uptime.formatted)
  t.regex(data.uptime.formatted, /\d+m \d+/)
})

test.serial("bare fetch: POST /increment increments counter", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const response1 = await fetch(
    `http://localhost:${kettle.workerPort}/increment`,
    { method: "POST" },
  )
  t.is(response1.status, 200)
  const data1 = await response1.json()
  const counter1 = data1.counter
  t.true(typeof counter1 === "number")
  t.true(counter1 > 0)
  const response2 = await fetch(
    `http://localhost:${kettle.workerPort}/increment`,
    { method: "POST" },
  )
  const data2 = await response2.json()
  t.is(data2.counter, counter1 + 1)
})

test.serial("bare fetch: POST /quote returns quote data", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const testPublicKey = new Array(32).fill(0).map((_, i) => i)
  const response = await fetch(`http://localhost:${kettle.workerPort}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: testPublicKey }),
  })
  t.is(response.status, 200)
  const data = await response.json()
  t.truthy(data.quote, "quote should be present")
  t.true(typeof data.quote === "string", "quote should be a string")
  t.true(data.quote.length > 100, "quote should be substantial in size")
})

test.serial("bare ws: echo message", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const ws = await connectWebSocket(`ws://localhost:${kettle.workerPort}/ws`)

  const testMessage = "Hello, WebSocket!"
  const echoReceived = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("No echo received")),
      5000,
    )

    ws.on("message", (data) => {
      clearTimeout(timeout)
      resolve(data.toString())
    })

    ws.send(testMessage)
  })

  t.is(echoReceived, testMessage, "Server should echo the message back")
})

test.serial("bare ws: binary message echo", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const ws = await connectWebSocket(`ws://localhost:${kettle.workerPort}/ws`)

  // Send binary data
  const testData = Buffer.from([1, 2, 3, 4, 5, 255])
  const echoReceived = await new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("No echo received")),
      5000,
    )

    ws.on("message", (data) => {
      clearTimeout(timeout)
      resolve(data as Buffer)
    })

    ws.send(testData)
  })

  t.deepEqual(
    Array.from(echoReceived),
    Array.from(testData),
    "Server should echo binary data correctly",
  )
})

test.serial("bare ws: multiple messages", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const ws = await connectWebSocket(`ws://localhost:${kettle.workerPort}/ws`)

  // Send multiple messages and verify they're all echoed
  const messages = ["message1", "message2", "message3"]
  const received: string[] = []

  const allReceived = new Promise<string[]>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Not all messages received")),
      5000,
    )

    ws.on("message", (data) => {
      received.push(data.toString())
      if (received.length === messages.length) {
        clearTimeout(timeout)
        resolve(received)
      }
    })
  })

  for (const msg of messages) {
    ws.send(msg)
  }

  const echoedMessages = await allReceived
  t.deepEqual(
    echoedMessages,
    messages,
    "All messages should be echoed in order",
  )
})

test.serial("bare ws: concurrent connections", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const ws1 = await connectWebSocket(`ws://localhost:${kettle.workerPort}/ws`)
  const ws2 = await connectWebSocket(`ws://localhost:${kettle.workerPort}/ws`)
  const ws3 = await connectWebSocket(`ws://localhost:${kettle.workerPort}/ws`)

  // Test each connection independently
  const testConnection = async (
    ws: WebSocket,
    message: string,
  ): Promise<string> => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No response")), 5000)

      ws.once("message", (data) => {
        clearTimeout(timeout)
        resolve(data.toString())
      })

      ws.send(message)
    })
  }

  const [echo1, echo2, echo3] = await Promise.all([
    testConnection(ws1, "connection1"),
    testConnection(ws2, "connection2"),
    testConnection(ws3, "connection3"),
  ])

  t.is(echo1, "connection1", "First connection should work")
  t.is(echo2, "connection2", "Second connection should work")
  t.is(echo3, "connection3", "Third connection should work")

  // Close all WebSockets
  ws1.close()
  ws2.close()
  ws3.close()
})

test.serial("bare ws: close event handling", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const ws = await connectWebSocket(`ws://localhost:${kettle.workerPort}/ws`)

  // Send and receive a message first to ensure the connection is fully established
  await new Promise<void>((resolve) => {
    ws.once("message", () => resolve())
    ws.send("ping")
  })

  // Close with a specific code
  ws.close(1000, "Normal closure")

  // The close should have been initiated (either CLOSING or CLOSED)
  t.true(
    ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED,
    `WebSocket should be in CLOSING or CLOSED state, got ${ws.readyState}`,
  )
})

test.serial("bare ws: large message handling", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const ws = await connectWebSocket(`ws://localhost:${kettle.workerPort}/ws`)

  // Create a large message (512KB)
  const largeMessage = "x".repeat(512 * 1024)

  const echo = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("No response")), 5000)

    ws.on("message", (data) => {
      clearTimeout(timeout)
      resolve(data.toString())
    })

    ws.send(largeMessage)
  })

  t.is(echo.length, largeMessage.length, "Large message should be echoed")
  t.is(echo, largeMessage, "Large message content should match")
})

test.serial("static: GET / returns index.html", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const response = await fetch(`http://localhost:${kettle.workerPort}/`)
  t.is(response.status, 200)
  t.is(response.headers.get("content-type"), "text/html;charset=utf-8")
  const html = await response.text()
  t.true(html.includes("<!doctype html>") || html.includes("<!DOCTYPE html>"))
  t.true(html.length > 0)
})

test.serial("static: GET /index.html returns index.html", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const response = await fetch(
    `http://localhost:${kettle.workerPort}/index.html`,
  )
  t.is(response.status, 200)
  t.is(response.headers.get("content-type"), "text/html;charset=utf-8")
  const html = await response.text()
  t.true(html.includes("<!doctype html>") || html.includes("<!DOCTYPE html>"))
})

test.serial("static: GET /vite.svg returns SVG", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const response = await fetch(`http://localhost:${kettle.workerPort}/vite.svg`)
  t.is(response.status, 200)
  t.is(response.headers.get("content-type"), "image/svg+xml;charset=utf-8")
  const svg = await response.text()
  t.true(svg.includes("<svg"))
})

test.serial("static: GET /assets/* returns JavaScript file", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  // First get index.html to find the asset path
  const indexResponse = await fetch(`http://localhost:${kettle.workerPort}/`)
  const html = await indexResponse.text()

  // Extract the JS asset path from index.html
  const jsMatch = html.match(/\/assets\/index-[^"]+\.js/)
  if (!jsMatch) {
    t.fail("Could not find JS asset in index.html")
    return
  }

  const jsPath = jsMatch[0]
  const response = await fetch(`http://localhost:${kettle.workerPort}${jsPath}`)
  t.is(response.status, 200)
  t.is(response.headers.get("content-type"), "text/javascript;charset=utf-8")
  const js = await response.text()
  t.true(js.length > 0)
})

test.serial("static: GET /assets/* returns CSS file", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  // First get index.html to find the asset path
  const indexResponse = await fetch(`http://localhost:${kettle.workerPort}/`)
  const html = await indexResponse.text()

  // Extract the CSS asset path from index.html
  const cssMatch = html.match(/\/assets\/index-[^"]+\.css/)
  if (!cssMatch) {
    t.fail("Could not find CSS asset in index.html")
    return
  }

  const cssPath = cssMatch[0]
  const response = await fetch(
    `http://localhost:${kettle.workerPort}${cssPath}`,
  )
  t.is(response.status, 200)
  t.is(response.headers.get("content-type"), "text/css;charset=utf-8")
  const css = await response.text()
  t.true(css.length > 0)
})

test.serial("static: unknown paths return 404", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!
  const response = await fetch(
    `http://localhost:${kettle.workerPort}/some/random/path`,
  )
  t.is(response.status, 404)
})

test.serial("static: API routes still work", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  // Ensure API routes are not overridden by static file middleware
  const response = await fetch(`http://localhost:${kettle.workerPort}/uptime`)
  t.is(response.status, 200)
  const data = await response.json()
  t.truthy(data.uptime)
  t.truthy(data.uptime.formatted)
})
