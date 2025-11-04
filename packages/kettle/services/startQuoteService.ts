/* Standalone HTTP service for quote generation */
import { createServer } from "http"
import { base64 } from "@scure/base"
import chalk from "chalk"
import fs from "node:fs"
import { exec } from "node:child_process"

const DEFAULT_PORT = 3002

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

export class QuoteBinding {
  async getQuote(x25519PublicKey: Uint8Array): Promise<QuoteData> {
    return await new Promise<QuoteData>(async (resolve, reject) => {
      // If config.json isn't set up, return a sample quote
      if (!fs.existsSync("config.json")) {
        console.log("[kettle] TDX config.json not found, serving sample quote")
        const { tappdV4Base64 } = await import("@teekit/tunnel/samples")
        resolve({
          quote: base64.decode(tappdV4Base64),
        })
        return
      }

      // Otherwise, get a quote from the SEAM (requires root)
      console.log("[kettle] Getting a quote for " + toHex(x25519PublicKey))
      const userDataB64 = base64.encode(x25519PublicKey)
      const cmd = `trustauthority-cli evidence --tdx --user-data '${userDataB64}' -c config.json`
      exec(cmd, (err, stdout) => {
        if (err) {
          return reject(err)
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
          reject(err)
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
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "internal server error" }))
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
