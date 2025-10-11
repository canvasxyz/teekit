import { Hono } from "hono"
import { cors } from "hono/cors"

import {
  Message,
  IncomingChatMessage,
  BacklogMessage,
  BroadcastMessage,
} from "./types.js"

/* ********************************************************************************
 * Begin teekit tunnel code.
 * ******************************************************************************** */
// TODO: TunnelServer integration commented out until workerd WebSocket adapter is implemented
// import { TunnelServer } from "@teekit/tunnel"

// Workerd environment bindings
interface Env {
  QUOTE: {
    getQuote(x25519PublicKey: Uint8Array): Promise<{
      quote: Uint8Array
      verifier_data?: {
        iat: Uint8Array
        val: Uint8Array
        signature: Uint8Array
      }
      runtime_data?: Uint8Array
    }>
  }
}

const app = new Hono<{ Bindings: Env }>()

/* ********************************************************************************
 * End teekit tunnel code.
 * ******************************************************************************** */

app.use("/*", cors())

let messages: Message[] = []
let totalMessageCount = 0
const MAX_MESSAGES = 30
const startTime = Date.now()
let counter = 0

// API Routes
app.get("/uptime", (c) => {
  const uptimeMs = Date.now() - startTime
  const uptimeSeconds = Math.floor(uptimeMs) / 1000
  const uptimeMinutes = Math.floor(uptimeSeconds / 60)
  const uptimeHours = Math.floor(uptimeMinutes / 60)

  const minutes = (uptimeMinutes % 60).toString()
  const seconds = (uptimeSeconds % 60).toString().slice(0, 4)

  return c.json({
    uptime: {
      formatted: `${
        uptimeHours ? uptimeHours + "h" : ""
      } ${minutes}m ${seconds}s`,
    },
  })
})

app.post("/increment", async (c) => {
  counter += 1
  return c.json({ counter })
})

app.post("/quote", async (c) => {
  try {
    // Parse the request body to get the public key
    const body = await c.req.json()
    const publicKeyArray = body.publicKey

    if (!publicKeyArray || !Array.isArray(publicKeyArray)) {
      return c.json({ error: "publicKey must be an array of numbers" }, 400)
    }

    // Convert to Uint8Array
    const publicKey = new Uint8Array(publicKeyArray)

    // Use QUOTE binding provided by workerd env
    const env = c.env as Env
    const quoteData = await env.QUOTE.getQuote(publicKey)

    // Convert Uint8Array fields to arrays for JSON response
    const response = {
      quote: Array.from(quoteData.quote),
      verifier_data: quoteData.verifier_data
        ? {
            iat: Array.from(quoteData.verifier_data.iat),
            val: Array.from(quoteData.verifier_data.val),
            signature: Array.from(quoteData.verifier_data.signature),
          }
        : undefined,
      runtime_data: quoteData.runtime_data
        ? Array.from(quoteData.runtime_data)
        : undefined,
    }

    return c.json(response)
  } catch (error) {
    console.error("[teekit-runtime] Error getting quote:", error)
    return c.json({ error: String(error) }, 500)
  }
})

// Note: WebSocket handling in workerd is different from Node.js
// The TunnelServer integration will need to be adapted for workerd's WebSocket API
// For now, the HTTP endpoints above will work

// Static file serving
// Note: In workerd, static files should be served via Assets binding configured in workerd.config.capnp
// For now, we'll just serve the API routes

// Export the fetch handler for workerd
export default app
