import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startWorker, WorkerResult } from "../server/startWorker.js"
import {
  findFreePort,
  waitForPortClosed,
  waitForPortOpen,
} from "../server/utils.js"
import { TunnelClient } from "@teekit/tunnel"
import { base64 } from "@scure/base"
import { hex, parseTdxQuote } from "@teekit/qvl"
import { tappdV4Base64 } from "@teekit/tunnel/samples"
import { WebSocket } from "ws"
import { fileURLToPath } from "url"

const log = (msg: string) => {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

export async function checkWhyNodeRunning(delayMs = 2000) {
  try {
    const whyIsNodeRunning = await import("why-is-node-running")
    log(`Waiting ${delayMs}ms before checking why Node.js is running...`)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    log("Checking why Node.js is running...")
    whyIsNodeRunning.default()
  } catch (err) {
    log(`Failed to check why Node.js is running: ${err}`)
  }
}

// Create a WebSocket connection, but timeout if connection fails
export async function connectWebSocket(
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

export async function startKettleWithTunnel() {
  log("startKettleWithTunnel: starting")
  const baseDir = mkdtempSync(join(tmpdir(), "kettle-tunnel-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const kettle = await startWorker({
    dbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    bundleDir: join(fileURLToPath(new URL("..", import.meta.url)), "dist"),
  })
  log("startKettleWithTunnel: worker started")

  await waitForPortOpen(kettle.workerPort)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  log("startKettleWithTunnel: port open")

  const origin = `http://localhost:${kettle.workerPort}`

  // Use the sample quote to establish tunnel
  const quote = base64.decode(tappdV4Base64)
  const quoteBodyParsed = parseTdxQuote(quote).body

  const tunnelClient = await TunnelClient.initialize(origin, {
    mrtd: hex(quoteBodyParsed.mr_td),
    report_data: hex(quoteBodyParsed.report_data),
    customVerifyX25519Binding: () => true,
  })

  log("startKettleWithTunnel: complete")
  return { kettle, tunnelClient, origin }
}

export async function stopKettleWithTunnel(
  kettle: WorkerResult,
  tunnelClient: TunnelClient,
) {
  log("stopKettleWithTunnel: starting")
  tunnelClient.close()
  log("stopKettleWithTunnel: tunnelClient.close() called")
  await kettle.stop()
  log("stopKettleWithTunnel: kettle.stop() completed")
  await new Promise((resolve) => setTimeout(resolve, 500))
  log("stopKettleWithTunnel: complete")
}

export async function startKettle() {
  log("startKettle: starting")
  const baseDir = mkdtempSync(join(tmpdir(), "kettle-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const kettle = await startWorker({
    dbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    bundleDir: join(fileURLToPath(new URL("..", import.meta.url)), "dist"),
  })
  log("startKettle: worker started")

  await waitForPortOpen(kettle.workerPort)
  await new Promise((resolve) => setTimeout(resolve, 100))
  log("startKettle: port open, ready")

  return kettle
}

export async function stopKettle(kettle: WorkerResult) {
  log("stopKettle: starting")
  const port = kettle.workerPort
  await kettle.stop()
  log("stopKettle: kettle.stop() completed")
  // Wait for the port to actually close, but don't block forever
  try {
    await waitForPortClosed(port)
    log("stopKettle: port closed")
  } catch (err) {
    // Port didn't close cleanly, force a delay
    log("stopKettle: port didn't close cleanly, waiting 500ms")
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  log("stopKettle: complete")
}
