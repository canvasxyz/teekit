/* Standalone HTTP service for quote generation */
import { createServer } from "http"
import { base64 } from "@scure/base"
import * as chalk from "colorette"
import fs from "node:fs"
import { exec } from "node:child_process"

const DEFAULT_PORT = 3002
const CONFIG_PATH = "/etc/kettle/config.json"

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export interface VerifierData {
  iat: Uint8Array
  val: Uint8Array
  signature: Uint8Array
}

export interface QuoteData {
  quote: Uint8Array
  verifier_data?: VerifierData
  runtime_data?: Uint8Array
}

class QuoteError extends Error {
  constructor(
    message: string,
    public readonly code: "CONFIG_MISSING" | "CLI_MISSING" | "QUOTE_FAILED",
  ) {
    super(message)
    this.name = "QuoteError"
  }
}

export class QuoteBinding {
  async getQuote(x25519PublicKey: Uint8Array): Promise<QuoteData> {
    return await new Promise<QuoteData>(async (resolve, reject) => {
      // Check if config.json exists (created by cloud-launcher from metadata)
      if (!fs.existsSync(CONFIG_PATH)) {
        return reject(
          new QuoteError(
            `TDX config.json not found at ${CONFIG_PATH}`,
            "CONFIG_MISSING",
          ),
        )
      }

      // Check if trustauthority-cli exists
      exec("which trustauthority-cli", (whichErr) => {
        if (whichErr) {
          return reject(
            new QuoteError(
              "trustauthority-cli not found",
              "CLI_MISSING",
            ),
          )
        }

        // Get a quote from the SEAM (requires root)
        console.log("[kettle] Getting a quote for " + toHex(x25519PublicKey))
        const userDataB64 = base64.encode(x25519PublicKey)
        // GCP (v1.10.x): trustauthority-cli evidence --tdx --user-data '<base64>' -c /etc/kettle/config.json
        // Azure (v1.6.1): trustauthority-cli quote --aztdx --user-data '<base64>'
        // CLOUD_PROVIDER is set by cloud-launcher from /etc/kettle/cloud-launcher.env
        const cloudProvider = process.env.CLOUD_PROVIDER || "gcp"
        const cmd = cloudProvider === "azure"
          ? `trustauthority-cli quote --aztdx --user-data '${userDataB64}'`
          : `trustauthority-cli evidence --tdx --user-data '${userDataB64}' -c ${CONFIG_PATH}`
        exec(cmd, (err, stdout) => {
          if (err) {
            return reject(
              new QuoteError(
                `Failed to get quote: ${err.message}`,
                "QUOTE_FAILED",
              ),
            )
          }

          try {
            const response = JSON.parse(stdout)
            resolve({
              quote: base64.decode(response.tdx.quote),
              verifier_data: {
                iat: base64.decode(response.tdx.verifier_nonce.iat),
                val: base64.decode(response.tdx.verifier_nonce.val),
                signature: base64.decode(response.tdx.verifier_nonce.signature),
              },
              runtime_data: base64.decode(response.tdx.runtime_data),
            })
          } catch (err) {
            reject(
              new QuoteError(
                `Failed to parse quote response: ${err instanceof Error ? err.message : String(err)}`,
                "QUOTE_FAILED",
              ),
            )
          }
        })
      })
    })
  }
}

export function startQuoteService(port: number = DEFAULT_PORT) {
  const quoteBinding = new QuoteBinding()
  const connections = new Set<any>()

  const server = createServer(async (req, res) => {
    // Enable CORS
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")

    if (req.method === "OPTIONS") {
      res.writeHead(200)
      res.end()
      return
    }

    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", service: "quote-service" }))
      return
    }

    if (
      req.url === "/quote" &&
      (req.method === "GET" || req.method === "POST")
    ) {
      try {
        let publicKey: Uint8Array

        if (req.method === "POST") {
          // Read request body
          const chunks: Buffer[] = []
          for await (const chunk of req) {
            chunks.push(chunk)
          }
          const body = Buffer.concat(chunks).toString()

          try {
            const data = JSON.parse(body)
            if (!data.publicKey || !Array.isArray(data.publicKey)) {
              res.writeHead(400, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ error: "invalid publicKey" }))
              return
            }
            publicKey = new Uint8Array(data.publicKey)
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: "invalid JSON body" }))
            return
          }
        } else {
          publicKey = new Uint8Array()
        }

        // Generate quote
        const quoteData = await quoteBinding.getQuote(publicKey)

        // Return as JSON with base64-encoded values
        const response = {
          quote: base64.encode(quoteData.quote),
          ...(quoteData.verifier_data && {
            verifier_data: {
              iat: base64.encode(quoteData.verifier_data.iat),
              val: base64.encode(quoteData.verifier_data.val),
              signature: base64.encode(quoteData.verifier_data.signature),
            },
          }),
          ...(quoteData.runtime_data && {
            runtime_data: base64.encode(quoteData.runtime_data),
          }),
        }

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(response))
      } catch (error) {
        console.error("[quote-service] Error:", error)
        
        let statusCode = 500
        let errorMessage = "internal server error"
        
        if (error instanceof QuoteError) {
          if (error.code === "CONFIG_MISSING" || error.code === "CLI_MISSING") {
            statusCode = 501 // Not Implemented
            errorMessage = error.message
          } else {
            statusCode = 500 // Internal Server Error
            errorMessage = error.message
          }
        }
        
        res.writeHead(statusCode, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: errorMessage }))
      }
      return
    }

    // 404 for unknown routes
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "not found" }))
  })

  server.listen(port, () => {
    console.log(
      chalk.blueBright(`[quote-service] Listening on http://0.0.0.0:${port}`),
    )
  })

  // Track connections so we can close them on shutdown
  server.on("connection", (conn) => {
    connections.add(conn)
    conn.on("close", () => {
      connections.delete(conn)
    })
  })

  // Don't keep the event loop alive just for the server
  server.unref()

  return {
    server,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        // Forcefully close all connections
        for (const conn of connections) {
          conn.destroy()
        }
        connections.clear()
        server.close(() => resolve())
      }),
  }
}

// No standalone execution entrypoint; use via CLI commands.
