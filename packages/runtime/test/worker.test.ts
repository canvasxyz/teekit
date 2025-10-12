import test from "ava"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startWorker } from "../server/server.js"
import { findFreePortNear, waitForPortOpen } from "../server/utils.js"

test.serial("Workerd server: GET /uptime returns uptime data", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "teekit-runtime-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const runtime = await startWorker({
    dbPath,
    sqldPort: await findFreePortNear(8088),
    workerPort: await findFreePortNear(3001),
  })
  t.teardown(async () => {
    await runtime.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
  })

  await waitForPortOpen(runtime.workerPort)
  const response = await fetch(`http://localhost:${runtime.workerPort}/uptime`)
  t.is(response.status, 200)
  const data = await response.json()
  t.truthy(data.uptime)
  t.truthy(data.uptime.formatted)
  t.regex(data.uptime.formatted, /\d+m \d+/)
})

test.serial("Workerd server: POST /increment increments counter", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "teekit-runtime-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const runtime = await startWorker({
    dbPath,
    sqldPort: await findFreePortNear(8089),
    workerPort: await findFreePortNear(3002),
  })
  t.teardown(async () => {
    await runtime.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
  })

  await waitForPortOpen(runtime.workerPort)
  const response1 = await fetch(
    `http://localhost:${runtime.workerPort}/increment`,
    { method: "POST" },
  )
  t.is(response1.status, 200)
  const data1 = await response1.json()
  const counter1 = data1.counter
  t.true(typeof counter1 === "number")
  t.true(counter1 > 0)
  const response2 = await fetch(
    `http://localhost:${runtime.workerPort}/increment`,
    { method: "POST" },
  )
  const data2 = await response2.json()
  t.is(data2.counter, counter1 + 1)
})

test.serial("Workerd server: POST /quote returns quote data", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "teekit-runtime-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const runtime = await startWorker({
    dbPath,
    sqldPort: await findFreePortNear(8090),
    workerPort: await findFreePortNear(3003),
  })
  t.teardown(async () => {
    await runtime.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
  })

  await waitForPortOpen(runtime.workerPort)
  const testPublicKey = new Array(32).fill(0).map((_, i) => i)
  const response = await fetch(`http://localhost:${runtime.workerPort}/quote`, {
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

// TODO: WebSocket test commented out until TunnelServer integration is complete
// test.serial("Workerd server: WebSocket connection works", async (t) => {
//   const baseDir = mkdtempSync(join(tmpdir(), "teekit-runtime-test-"))
//   const dbPath = join(baseDir, "app.sqlite")
//   const runtime = await startWorker({
//     dbPath,
//     sqldPort: await findFreePortNear(8091),
//     workerPort: await findFreePortNear(3004),
//   })
//   t.teardown(async () => {
//     await runtime.stop()
//     await new Promise((resolve) => setTimeout(resolve, 500))
//   })

//   await waitForPortOpen(runtime.workerPort)

//   const testPublicKey = new Array(32).fill(0).map((_, i) => i)
//   const response = await fetch(`http://localhost:${runtime.workerPort}/quote`, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({ publicKey: testPublicKey }),
//   })
//   t.is(response.status, 200)
//   const data = await response.json()
//   t.truthy(data.quote, "quote should be present")
//   t.true(Array.isArray(data.quote), "quote should be an array")
//   t.true(data.quote.length > 0, "quote should not be empty")
//   t.true(data.quote.length > 100, "quote should be substantial in size")

//   const ws = new WebSocket(`ws://localhost:${runtime.workerPort}/__ra__`)

//   const connected = await new Promise<boolean>((resolve, reject) => {
//     const timeout = setTimeout(
//       () => reject(new Error("WebSocket connection timeout")),
//       5000,
//     )

//     ws.on("open", () => {
//       clearTimeout(timeout)
//       resolve(true)
//     })

//     ws.on("error", (err) => {
//       clearTimeout(timeout)
//       reject(err)
//     })
//   })

//   t.true(connected)

//   // Should receive server_kx message (CBOR encoded)
//   const receivedMessage = await new Promise<boolean>((resolve, reject) => {
//     const timeout = setTimeout(
//       () => reject(new Error("No server message received")),
//       5000,
//     )

//     ws.on("message", (data) => {
//       clearTimeout(timeout)
//       // Just verify we received some data from the server

//       if (data instanceof ArrayBuffer) {
//         t.true(data.byteLength > 0)
//       } else {
//         // For other RawData types (Buffer, string, Buffer[]),
//         // assume the 'length' property is the intended way to check for content.
//         t.true((data as any).length > 0)
//       }
//       resolve(true)
//     })
//   })

//   t.true(receivedMessage)

//   ws.close()
// })
