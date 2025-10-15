import test from "ava"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startWorker, WorkerResult } from "../server/server.js"
import { findFreePort, waitForPortOpen } from "../server/utils.js"
import { TunnelClient } from "@teekit/tunnel"
import { base64 } from "@scure/base"
import { hex, parseTdxQuote } from "@teekit/qvl"
import { tappdV4Base64 } from "@teekit/tunnel/samples"

async function startKettleTunnel() {
  const baseDir = mkdtempSync(join(tmpdir(), "kettle-tunnel-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const kettle = await startWorker({
    dbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
  })

  await waitForPortOpen(kettle.workerPort)
  await new Promise((resolve) => setTimeout(resolve, 1000))

  const origin = `http://localhost:${kettle.workerPort}`

  // Use the sample quote to establish tunnel
  const quote = base64.decode(tappdV4Base64)
  const quoteBodyParsed = parseTdxQuote(quote).body

  const tunnelClient = await TunnelClient.initialize(origin, {
    mrtd: hex(quoteBodyParsed.mr_td),
    report_data: hex(quoteBodyParsed.report_data),
    customVerifyX25519Binding: () => true,
  })

  return { kettle, tunnelClient, origin }
}

async function stopKettleTunnel(
  kettle: WorkerResult,
  tunnelClient: TunnelClient,
) {
  try {
    if (tunnelClient.ws) {
      tunnelClient.ws.onclose = () => {}
      tunnelClient.ws.close()
    }
  } catch {}

  await kettle.stop()
  await new Promise((resolve) => setTimeout(resolve, 500))
}

// Shared worker/tunnel state reused across all tests in this file
let shared: {
  kettle: WorkerResult
  tunnelClient: TunnelClient
  origin: string
} | null = null

test.before(async () => {
  shared = await startKettleTunnel()
})

test.after.always(async () => {
  if (shared) {
    const { kettle, tunnelClient } = shared
    shared = null
    await stopKettleTunnel(kettle, tunnelClient)
  }
})

test.serial("Kettle tunnel: GET /uptime", async (t) => {
  if (!shared) t.fail("shared tunnel not initialized")
  const { tunnelClient } = shared!

  // Test the /uptime endpoint through the tunnel
  const response = await tunnelClient.fetch("/uptime")
  t.is(response.status, 200)

  const data = await response.json()
  t.truthy(data.uptime)
  t.truthy(data.uptime.formatted)
  t.regex(data.uptime.formatted, /\d+m \d+/)
})

test.serial("Kettle tunnel: POST /increment", async (t) => {
  if (!shared) t.fail("shared tunnel not initialized")
  const { tunnelClient } = shared!

  // Test the /increment endpoint through the tunnel
  const response1 = await tunnelClient.fetch("/increment", {
    method: "POST",
  })
  t.is(response1.status, 200)

  const data1 = await response1.json()
  const counter1 = data1.counter
  t.true(typeof counter1 === "number")
  t.true(counter1 > 0)

  // Increment again - should increase by 1
  const response2 = await tunnelClient.fetch("/increment", {
    method: "POST",
  })
  const data2 = await response2.json()
  t.is(data2.counter, counter1 + 1)
})

test.serial("Kettle tunnel: WebSocket echo", async (t) => {
  if (!shared) t.fail("shared tunnel not initialized")
  const { tunnelClient, origin } = shared!

  // Connect to WebSocket through the tunnel
  const wsUrl = new URL(origin)
  wsUrl.protocol = wsUrl.protocol.replace(/^http/, "ws")
  wsUrl.pathname = "/ws"
  const ws = new tunnelClient.WebSocket(wsUrl.toString())

  // Wait for connection to open
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket connection timeout")),
      5000,
    )

    ws.onopen = () => {
      clearTimeout(timeout)
      resolve()
    }

    ws.onerror = (err: any) => {
      clearTimeout(timeout)
      reject(err)
    }
  })

  // Verify connection is established
  t.truthy(ws)
  t.is(ws.readyState, WebSocket.OPEN)

  // Send a test message and verify it's echoed back
  const testMessage = "Hello from tunnel!"
  const echoReceived = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("No echo received")),
      5000,
    )

    ws.onmessage = (event: any) => {
      clearTimeout(timeout)
      resolve(event.data as string)
    }

    ws.send(testMessage)
  })

  t.is(echoReceived, testMessage, "Server should echo the message back")

  // Wait for WebSocket to fully close (with timeout since close event may not fire in workerd)
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 2000)
    ws.onclose = () => {
      clearTimeout(timeout)
      resolve()
    }
    ws.close()
  })
})

test.serial("Kettle tunnel: WebSocket binary message", async (t) => {
  if (!shared) t.fail("shared tunnel not initialized")
  const { tunnelClient, origin } = shared!

  // Connect to WebSocket through the tunnel
  const wsUrl = new URL(origin)
  wsUrl.protocol = wsUrl.protocol.replace(/^http/, "ws")
  wsUrl.pathname = "/ws"
  const ws = new tunnelClient.WebSocket(wsUrl.toString())

  // Wait for connection to open
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket connection timeout")),
      5000,
    )

    ws.onopen = () => {
      clearTimeout(timeout)
      resolve()
    }

    ws.onerror = (err: any) => {
      clearTimeout(timeout)
      reject(err)
    }
  })

  // Send binary data
  const testData = new Uint8Array([1, 2, 3, 4, 5, 255])
  const echoReceived = await new Promise<Uint8Array>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("No echo received")),
      5000,
    )

    ws.onmessage = async (event: any) => {
      clearTimeout(timeout)
      if (event.data instanceof Blob) {
        const buffer = await event.data.arrayBuffer()
        resolve(new Uint8Array(buffer))
      } else if (event.data instanceof ArrayBuffer) {
        resolve(new Uint8Array(event.data))
      } else if (event.data instanceof Uint8Array) {
        resolve(event.data)
      } else {
        reject(new Error("Unexpected data type"))
      }
    }

    ws.send(testData)
  })

  t.deepEqual(
    Array.from(echoReceived),
    Array.from(testData),
    "Server should echo binary data correctly",
  )

  // Wait for WebSocket to fully close (with timeout since close event may not fire in workerd)
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 2000)
    ws.onclose = () => {
      clearTimeout(timeout)
      resolve()
    }
    ws.close()
  })
})
