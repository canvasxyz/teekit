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

// Logging utility with timestamps
export function logWithTimestamp(message: string): void {
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] ${message}`)
}

// Check why node is still running after a delay
export async function checkWhyNodeRunning(delayMs = 2000): Promise<void> {
  logWithTimestamp(`Waiting ${delayMs}ms before checking why Node.js is running...`)
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  
  try {
    const whyIsNodeRunning = await import("why-is-node-running")
    logWithTimestamp("=== Why is Node.js still running? ===")
    // why-is-node-running exports a default function or can be called directly
    const fn = whyIsNodeRunning.default || whyIsNodeRunning
    if (typeof fn === "function") {
      fn()
    } else {
      logWithTimestamp("why-is-node-running export is not a function")
    }
    logWithTimestamp("=== End of why-is-node-running output ===")
  } catch (error) {
    logWithTimestamp(`Failed to import or use why-is-node-running: ${error}`)
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
  const baseDir = mkdtempSync(join(tmpdir(), "kettle-tunnel-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const kettle = await startWorker({
    dbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    bundleDir: join(fileURLToPath(new URL("..", import.meta.url)), "dist"),
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

export async function stopKettleWithTunnel(
  kettle: WorkerResult,
  tunnelClient: TunnelClient,
) {
  logWithTimestamp("stopKettleWithTunnel: Starting cleanup")
  tunnelClient.close()
  logWithTimestamp("stopKettleWithTunnel: Tunnel client closed")
  await kettle.stop()
  logWithTimestamp("stopKettleWithTunnel: Kettle stopped")
  await new Promise((resolve) => setTimeout(resolve, 500))
  logWithTimestamp("stopKettleWithTunnel: Cleanup complete")
  await checkWhyNodeRunning()
}

export async function startKettle() {
  const baseDir = mkdtempSync(join(tmpdir(), "kettle-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const kettle = await startWorker({
    dbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    bundleDir: join(fileURLToPath(new URL("..", import.meta.url)), "dist"),
  })

  await waitForPortOpen(kettle.workerPort)
  await new Promise((resolve) => setTimeout(resolve, 100))

  return kettle
}

export async function stopKettle(kettle: WorkerResult) {
  logWithTimestamp("stopKettle: Starting cleanup")
  const port = kettle.workerPort
  await kettle.stop()
  logWithTimestamp("stopKettle: Kettle stopped")
  // Wait for the port to actually close, but don't block forever
  try {
    await waitForPortClosed(port)
    logWithTimestamp("stopKettle: Port closed successfully")
  } catch (err) {
    // Port didn't close cleanly, force a delay
    logWithTimestamp(`stopKettle: Port didn't close cleanly, waiting: ${err}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  logWithTimestamp("stopKettle: Cleanup complete")
  await checkWhyNodeRunning()
}
