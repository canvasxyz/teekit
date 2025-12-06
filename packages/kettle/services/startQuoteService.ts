import { createServer } from "http"
import { base64 } from "@scure/base"
import * as chalk from "colorette"

import { isSevSnpQuoteData } from "./utils.js"
import { QuoteBinding, QuoteError } from "./quote.js"

const DEFAULT_PORT = 3002

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
      const teeType = (process.env.TEE_TYPE || "tdx").toLowerCase()
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          status: "ok",
          service: "quote-service",
          tee_type: teeType,
        }),
      )
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
        // Format differs between TDX and SEV-SNP
        let response: Record<string, unknown>

        if (isSevSnpQuoteData(quoteData)) {
          // SEV-SNP response format
          response = {
            quote: base64.encode(quoteData.quote),
            vcek_cert: quoteData.vcek_cert,
            ...(quoteData.ask_cert && { ask_cert: quoteData.ask_cert }),
            ...(quoteData.ark_cert && { ark_cert: quoteData.ark_cert }),
            ...(quoteData.nonce && { nonce: base64.encode(quoteData.nonce) }),
            tee_type: "sev-snp",
          }
        } else {
          // TDX response format
          response = {
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
            tee_type: "tdx",
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(response))
      } catch (error) {
        console.error("[quote-service] Error:", error)

        let statusCode = 500
        let errorMessage = "internal server error"

        if (error instanceof QuoteError) {
          if (error.code === "CONFIG_MISSING") {
            statusCode = 502 // Bad Gateway
            errorMessage = error.message
          } else if (
            error.code === "INTEL_CLI_MISSING" ||
            error.code === "SNPGUEST_MISSING"
          ) {
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
