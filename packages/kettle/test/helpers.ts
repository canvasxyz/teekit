import { join } from "path"
import { startWorker, WorkerResult } from "../src/startWorker.js"
import {
  findFreePort,
  waitForPortClosed,
  waitForPortOpen,
} from "../src/utils.js"
import { TunnelClient } from "@teekit/tunnel"
import { base64 } from "@scure/base"
import { hex, parseTdxQuote, parseSevSnpReport } from "@teekit/qvl"
import { tappdV4Base64, sevSnpGcpX25519Base64 } from "@teekit/tunnel/samples"
import { WebSocket } from "ws"
import { fileURLToPath } from "url"

export type TeeType = "tdx" | "sevsnp"

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

export async function startKettleWithTunnel(teeType: TeeType = "tdx") {
  // Set environment for the quote service
  const prevTeeType = process.env.TEE_TYPE
  if (teeType === "sevsnp") {
    process.env.TEE_TYPE = "sevsnp"
  } else {
    delete process.env.TEE_TYPE
  }

  const kettle = await startWorker({
    workerPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    bundleDir: join(fileURLToPath(new URL("..", import.meta.url)), "dist"),
  })

  await waitForPortOpen(kettle.workerPort)
  await new Promise((resolve) => setTimeout(resolve, 1000))

  const origin = `http://localhost:${kettle.workerPort}`

  let tunnelClient: TunnelClient

  if (teeType === "sevsnp") {
    // Use SEV-SNP sample quote to establish tunnel
    const quote = base64.decode(sevSnpGcpX25519Base64)
    const reportParsed = parseSevSnpReport(quote)

    tunnelClient = await TunnelClient.initialize(origin, {
      sevsnp: true,
      measurements: {
        measurement: hex(reportParsed.body.measurement),
        reportData: hex(reportParsed.body.report_data),
      },
      x25519Binding: () => true,
    })
  } else {
    // Use TDX sample quote to establish tunnel
    const quote = base64.decode(tappdV4Base64)
    const quoteBodyParsed = parseTdxQuote(quote).body

    tunnelClient = await TunnelClient.initialize(origin, {
      measurements: {
        mrtd: hex(quoteBodyParsed.mr_td),
        reportData: hex(quoteBodyParsed.report_data),
      },
      x25519Binding: () => true,
    })
  }

  // Store prev value to restore on cleanup
  const cleanup = () => {
    if (prevTeeType !== undefined) {
      process.env.TEE_TYPE = prevTeeType
    } else {
      delete process.env.TEE_TYPE
    }
  }

  return { kettle, tunnelClient, origin, teeType, cleanup }
}

export async function stopKettleWithTunnel(
  kettle: WorkerResult,
  tunnelClient?: TunnelClient,
  cleanup?: () => void,
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
  // Restore environment
  if (cleanup) {
    cleanup()
  }
}
