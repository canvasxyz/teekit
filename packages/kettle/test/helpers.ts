import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startWorker, WorkerResult } from "../services/startWorker.js"
import {
  findFreePort,
  waitForPortClosed,
  waitForPortOpen,
} from "../services/utils.js"
import { TunnelClient } from "@teekit/tunnel"
import { base64 } from "@scure/base"
import { hex, parseTdxQuote } from "@teekit/qvl"
import { tappdV4Base64 } from "@teekit/tunnel/samples"
import { WebSocket } from "ws"
import { fileURLToPath } from "url"

// Create a WebSocket connection, but timeout if connection fails
export async function connectWebSocket(
  url: string,
  timeoutMs = 5000,
): Promise<WebSocket> {
  // Disable perMessageDeflate to avoid lingering zlib handles that delay test exit
  const ws = new WebSocket(url, { perMessageDeflate: false })

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
  tunnelClient?: TunnelClient,
) {
  if (tunnelClient) {
    tunnelClient.close()
  }
  await kettle.stop()
  // Wait for the port to actually close, but don't block forever
  const port = kettle.workerPort
  try {
    await waitForPortClosed(port)
  } catch (err) {
    // Port didn't close cleanly, force a delay
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
