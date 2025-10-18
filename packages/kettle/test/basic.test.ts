import test from "ava"
import { WorkerResult } from "../server/server.js"
import { WebSocket } from "ws"
import { connectWebSocket, startKettle, stopKettle } from "./helpers.js"

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
  t.true(Array.isArray(data.quote), "quote should be an array")
  t.true(data.quote.length > 0, "quote should not be empty")
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
  ws.close()
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

  ws.close()
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

  ws.close()
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
  ws.close()
})
