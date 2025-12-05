/* Standalone HTTP service for quote generation */
import { createServer } from "http"
import { base64 } from "@scure/base"
import * as chalk from "colorette"
import fs from "node:fs"
import { exec } from "node:child_process"
import { randomBytes } from "node:crypto"

const DEFAULT_PORT = 3002
const CONFIG_PATH = "/etc/kettle/config.json"
const AZURE_NONCE_LENGTH = 32

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Parse the plain-text output from Azure trustauthority-cli.
 *
 * Format:
 *   Quote: <base64>
 *   runtime_data: <base64>
 *   user_data: <base64>
 */
function parseAzureCLIOutput(stdout: string): {
  quote: string
  runtimeData: string
  userData: string
} {
  const lines = stdout.trim().split("\n")
  let quote = ""
  let runtimeData = ""
  let userData = ""

  for (const line of lines) {
    if (line.startsWith("Quote: ")) {
      quote = line.slice("Quote: ".length).trim()
    } else if (line.startsWith("runtime_data: ")) {
      runtimeData = line.slice("runtime_data: ".length).trim()
    } else if (line.startsWith("user_data: ")) {
      userData = line.slice("user_data: ".length).trim()
    }
  }

  if (!quote) throw new Error("Missing Quote in Azure CLI output")
  if (!runtimeData) throw new Error("Missing runtime_data in Azure CLI output")
  if (!userData) throw new Error("Missing user_data in Azure CLI output")

  return { quote, runtimeData, userData }
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

        // CLOUD_PROVIDER is set by cloud-launcher from /etc/kettle/cloud-launcher.env
        const cloudProvider = process.env.CLOUD_PROVIDER || "gcp"

        if (cloudProvider === "azure") {
          // Azure TDX vTPM attestation:
          //   trustauthority-cli quote --aztdx --nonce '<base64>' --user-data '<base64>'
          //
          // The Azure CLI outputs plain text (not JSON):
          //   Quote: <base64>
          //   runtime_data: <base64>
          //   user_data: <base64>
          //
          // The quote's report_data[0:32] = SHA256(runtime_data JSON)
          // The runtime_data["user-data"] = SHA512(nonce || x25519key)
          const nonce = randomBytes(AZURE_NONCE_LENGTH)
          const nonceB64 = base64.encode(new Uint8Array(nonce))
          const cmd = `trustauthority-cli quote --aztdx --nonce '${nonceB64}' --user-data '${userDataB64}'`

          exec(cmd, (err, stdout) => {
            if (err) {
              return reject(
                new QuoteError(
                  `Failed to get Azure quote: ${err.message}`,
                  "QUOTE_FAILED",
                ),
              )
            }

            try {
              const azureOutput = parseAzureCLIOutput(stdout)
              resolve({
                quote: base64.decode(azureOutput.quote),
                verifier_data: {
                  // Azure binding uses SHA512(nonce || x25519key) stored in runtime_data["user-data"]
                  // The nonce is passed to the CLI and must be returned for client verification
                  val: new Uint8Array(nonce),
                  iat: new Uint8Array(), // Not used in Azure binding
                  signature: new Uint8Array(), // Not used in Azure binding
                },
                runtime_data: base64.decode(azureOutput.runtimeData),
              })
            } catch (err) {
              reject(
                new QuoteError(
                  `Failed to parse Azure quote response: ${err instanceof Error ? err.message : String(err)}`,
                  "QUOTE_FAILED",
                ),
              )
            }
          })
        } else {
          // GCP/standard TDX attestation:
          //   trustauthority-cli evidence --tdx --user-data '<base64>' -c config.json
          //
          // The GCP CLI outputs JSON:
          //   { "tdx": { "quote": "...", "verifier_nonce": {...}, "runtime_data": "..." } }
          const cmd = `trustauthority-cli evidence --tdx --user-data '${userDataB64}' -c ${CONFIG_PATH}`

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
        }
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
