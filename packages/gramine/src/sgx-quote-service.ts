/**
 * SGX Quote Service for Gramine
 *
 * This module provides SGX attestation quote generation when running inside
 * a Gramine enclave. It uses Gramine's /dev/attestation pseudo-filesystem
 * to generate DCAP quotes.
 *
 * Inside Gramine, the attestation flow is:
 * 1. Write 64-byte report_data to /dev/attestation/user_report_data
 * 2. Read the SGX quote from /dev/attestation/quote
 *
 * The quote can then be verified using @teekit/qvl's verifySgx() function.
 */

import { createServer } from "http"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { createHash } from "crypto"
import { base64 } from "@scure/base"

const DEFAULT_PORT = 3333
const ATTESTATION_USER_REPORT_DATA = "/dev/attestation/user_report_data"
const ATTESTATION_QUOTE = "/dev/attestation/quote"
const ATTESTATION_TYPE = "/dev/attestation/attestation_type"

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = 10 // max 10 quote requests per minute per IP
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 300_000 // cleanup old entries every 5 minutes

interface RateLimitEntry {
  count: number
  windowStart: number
}

const rateLimitMap = new Map<string, RateLimitEntry>()

/**
 * Check if a request should be rate limited
 * @returns true if the request should be blocked
 */
function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // New window
    rateLimitMap.set(ip, { count: 1, windowStart: now })
    return false
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return true
  }

  entry.count++
  return false
}

/**
 * Clean up expired rate limit entries
 */
function cleanupRateLimitEntries(): void {
  const now = Date.now()
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip)
    }
  }
}

// Periodic cleanup of rate limit entries
setInterval(cleanupRateLimitEntries, RATE_LIMIT_CLEANUP_INTERVAL_MS).unref()

/**
 * Check if we're running inside a Gramine SGX enclave
 */
export function isGramineEnclave(): boolean {
  return existsSync(ATTESTATION_QUOTE)
}

/**
 * Get the attestation type (should be "dcap" for SGX DCAP)
 */
export function getAttestationType(): string | null {
  if (!existsSync(ATTESTATION_TYPE)) return null
  try {
    return readFileSync(ATTESTATION_TYPE, "utf-8").trim()
  } catch {
    return null
  }
}

export interface SgxQuoteData {
  quote: Uint8Array
  report_data: Uint8Array
}

/**
 * Generate an SGX DCAP quote with the given report data
 *
 * @param reportData - 64 bytes of user-defined data to include in the quote
 * @returns The SGX quote bytes
 */
export function generateSgxQuote(reportData: Uint8Array): SgxQuoteData {
  if (reportData.length !== 64) {
    throw new Error(`report_data must be exactly 64 bytes, got ${reportData.length}`)
  }

  if (!isGramineEnclave()) {
    throw new Error("Not running inside a Gramine SGX enclave")
  }

  // Write report_data to trigger quote generation
  writeFileSync(ATTESTATION_USER_REPORT_DATA, Buffer.from(reportData))

  // Read the generated quote
  const quote = readFileSync(ATTESTATION_QUOTE)

  return {
    quote: new Uint8Array(quote),
    report_data: reportData,
  }
}

/**
 * Generate a quote bound to an x25519 public key
 *
 * The binding follows the same pattern as the TDX quote service:
 * report_data[0:32] = SHA256(public_key)
 * report_data[32:64] = zeros (or additional binding data)
 */
export function generateKeyBoundQuote(x25519PublicKey: Uint8Array): SgxQuoteData {
  // Create report_data with key binding
  const reportData = new Uint8Array(64)

  if (x25519PublicKey.length > 0) {
    // Hash the public key into the first 32 bytes
    const hash = createHash("sha256").update(x25519PublicKey).digest()
    reportData.set(new Uint8Array(hash), 0)
  }
  // Second 32 bytes remain zeros (could be used for additional binding)

  return generateSgxQuote(reportData)
}

/**
 * Start the SGX quote HTTP service
 *
 * This provides the same API as the TDX quote service for compatibility:
 * - GET /healthz - Health check
 * - POST /quote - Generate quote with x25519 public key binding
 */
export function startSgxQuoteService(port: number = DEFAULT_PORT) {
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
      const inEnclave = isGramineEnclave()
      const attestationType = getAttestationType()

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          status: "ok",
          service: "sgx-quote-service",
          enclave: inEnclave,
          attestation_type: attestationType,
        }),
      )
      return
    }

    if (req.url === "/quote" && (req.method === "GET" || req.method === "POST")) {
      // Rate limiting for quote generation (CPU-intensive operation)
      const clientIp = req.socket.remoteAddress || "unknown"
      if (isRateLimited(clientIp)) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" })
        res.end(
          JSON.stringify({
            error: "rate limit exceeded",
            message: `Maximum ${RATE_LIMIT_MAX_REQUESTS} quote requests per minute`,
          }),
        )
        return
      }

      try {
        let publicKey: Uint8Array = new Uint8Array()

        if (req.method === "POST") {
          // Read request body
          const chunks: Buffer[] = []
          for await (const chunk of req) {
            chunks.push(chunk)
          }
          const body = Buffer.concat(chunks).toString()

          try {
            const data = JSON.parse(body)
            if (data.publicKey && Array.isArray(data.publicKey)) {
              publicKey = new Uint8Array(data.publicKey)
            }
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: "invalid JSON body" }))
            return
          }
        }

        // Check if we're in an enclave
        if (!isGramineEnclave()) {
          res.writeHead(501, { "Content-Type": "application/json" })
          res.end(
            JSON.stringify({
              error: "Not running inside SGX enclave",
              hint: "Run with: gramine-sgx workerd ...",
            }),
          )
          return
        }

        // Generate the quote
        const quoteData = generateKeyBoundQuote(publicKey)

        // Return as JSON with base64-encoded values (same format as TDX service)
        const response = {
          quote: base64.encode(quoteData.quote),
          tee_type: "sgx",
          // SGX doesn't have verifier_data like Azure TDX, but we include
          // the report_data for verification
          report_data: base64.encode(quoteData.report_data),
        }

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(response))
      } catch (error) {
        console.error("[sgx-quote-service] Error:", error)

        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "internal server error",
          }),
        )
      }
      return
    }

    // 404 for unknown routes
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "not found" }))
  })

  server.listen(port, () => {
    console.log(`[sgx-quote-service] Listening on http://0.0.0.0:${port}`)
    console.log(`[sgx-quote-service] Enclave: ${isGramineEnclave()}`)
    console.log(`[sgx-quote-service] Attestation type: ${getAttestationType()}`)
  })

  // Track connections for graceful shutdown
  server.on("connection", (conn) => {
    connections.add(conn)
    conn.on("close", () => {
      connections.delete(conn)
    })
  })

  return {
    server,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const conn of connections) {
          conn.destroy()
        }
        connections.clear()
        server.close(() => resolve())
      }),
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.QUOTE_SERVICE_PORT || "3333", 10)
  const service = startSgxQuoteService(port)

  process.on("SIGINT", () => service.stop())
  process.on("SIGTERM", () => service.stop())
}
