import test from "ava"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { WebSocket } from "ws"
import { startWorker } from "../server/server.js"
import { findFreePortNear, waitForPortOpen } from "../server/utils.js"

// Helper function to create a WebSocket connection with timeout
async function connectWebSocket(
  url: string,
  timeoutMs = 5000,
): Promise<WebSocket> {
  const ws = new WebSocket(url)

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.terminate()
      reject(new Error("WebSocket connection timeout"))
    }, timeoutMs)

    ws.on("open", () => {
      clearTimeout(timeout)
      resolve()
    })

    ws.on("error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })

  return ws
}

test.serial("WebSocket connection: echo message", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "teekit-runtime-ws-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const runtime = await startWorker({
    dbPath,
    sqldPort: await findFreePortNear(8092),
    workerPort: await findFreePortNear(3005),
  })
  t.teardown(async () => {
    await runtime.stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  await waitForPortOpen(runtime.workerPort)
  await new Promise((resolve) => setTimeout(resolve, 100))

  // Connect using helper function
  const ws = await connectWebSocket(`ws://localhost:${runtime.workerPort}/ws`)

  // Send a test message and verify it's echoed back
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
  await new Promise((resolve) => setTimeout(resolve, 100))
})

test.serial("WebSocket connection: binary message echo", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "teekit-runtime-ws-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const runtime = await startWorker({
    dbPath,
    sqldPort: await findFreePortNear(8093),
    workerPort: await findFreePortNear(3006),
  })
  t.teardown(async () => {
    await runtime.stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  await waitForPortOpen(runtime.workerPort)
  await new Promise((resolve) => setTimeout(resolve, 100))

  const ws = await connectWebSocket(`ws://localhost:${runtime.workerPort}/ws`)

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
  await new Promise((resolve) => setTimeout(resolve, 100))
})

test.serial("WebSocket connection: multiple messages", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "teekit-runtime-ws-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const runtime = await startWorker({
    dbPath,
    sqldPort: await findFreePortNear(8094),
    workerPort: await findFreePortNear(3007),
  })
  t.teardown(async () => {
    await runtime.stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  await waitForPortOpen(runtime.workerPort)

  const ws = await connectWebSocket(`ws://localhost:${runtime.workerPort}/ws`)

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
  await new Promise((resolve) => setTimeout(resolve, 100))
})

test.serial("WebSocket connection: concurrent connections", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "teekit-runtime-ws-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const runtime = await startWorker({
    dbPath,
    sqldPort: await findFreePortNear(8095),
    workerPort: await findFreePortNear(3008),
  })
  t.teardown(async () => {
    await runtime.stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  await waitForPortOpen(runtime.workerPort)

  const ws1 = await connectWebSocket(`ws://localhost:${runtime.workerPort}/ws`)
  const ws2 = await connectWebSocket(`ws://localhost:${runtime.workerPort}/ws`)
  const ws3 = await connectWebSocket(`ws://localhost:${runtime.workerPort}/ws`)

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

  ws1.close()
  ws2.close()
  ws3.close()
  await new Promise((resolve) => setTimeout(resolve, 100))
})

test.serial("WebSocket connection: close event handling", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "teekit-runtime-ws-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const runtime = await startWorker({
    dbPath,
    sqldPort: await findFreePortNear(8096),
    workerPort: await findFreePortNear(3009),
  })
  t.teardown(async () => {
    await runtime.stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  await waitForPortOpen(runtime.workerPort)
  await new Promise((resolve) => setTimeout(resolve, 500))

  const ws = await connectWebSocket(`ws://localhost:${runtime.workerPort}/ws`)

  // Send and receive a message first to ensure the connection is fully established
  await new Promise<void>((resolve) => {
    ws.once("message", () => resolve())
    ws.send("ping")
  })

  // Wait for close event
  const closeEvent = new Promise<{ code: number }>((resolve) => {
    ws.on("close", (code) => {
      resolve({ code })
    })
  })

  ws.close(1000, "Normal closure")

  const { code } = await closeEvent
  // Depending on when the close event is handled, code may
  // be 1000 (regular) or 1006 (connection closed abnormally)
  t.true(
    code === 1000 || code === 1006,
    `Close code should be 1000 or 1006, got ${code}`,
  )
})

test.serial("WebSocket connection: large message handling", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "teekit-runtime-ws-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const runtime = await startWorker({
    dbPath,
    sqldPort: await findFreePortNear(8097),
    workerPort: await findFreePortNear(3010),
  })
  t.teardown(async () => {
    await runtime.stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  await waitForPortOpen(runtime.workerPort)
  await new Promise((resolve) => setTimeout(resolve, 500))

  const ws = await connectWebSocket(`ws://localhost:${runtime.workerPort}/ws`)

  // Create a large message (512KB)
  const largeMessage = "x".repeat(512 * 1024)

  const echo = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("No response")), 10000)

    ws.on("message", (data) => {
      clearTimeout(timeout)
      resolve(data.toString())
    })

    ws.send(largeMessage)
  })

  t.is(echo.length, largeMessage.length, "Large message should be echoed")
  t.is(echo, largeMessage, "Large message content should match")

  ws.close()
  await new Promise((resolve) => setTimeout(resolve, 100))
})
