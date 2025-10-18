import { Hono } from "hono"
import { cors } from "hono/cors"
import { createClient, type Client as LibsqlClient } from "@libsql/client"
import { WSEvents } from "hono/ws"
import { TunnelServer, ServerRAMockWebSocket } from "@teekit/tunnel"
import type {
  Message,
  IncomingChatMessage,
  BroadcastMessage,
  BacklogMessage,
} from "./types.js"
import type { Env } from "./worker.js"

const app = new Hono<{ Bindings: Env }>()

app.use("/*", cors())

/* ********************************************************************************
 * Begin teekit tunnel code.
 * ******************************************************************************** */

import { upgradeWebSocket } from "hono/cloudflare-workers"

// Attach TunnelServer control channel at bootstrap without generating
// randomness; keys/quote are deferred until first WS open.
const { wss } = await TunnelServer.initialize(
  app as any, // TODO
  async () => {
    const { tappdV4Base64 } = await import("@teekit/tunnel/samples")
    const buf = Uint8Array.from(atob(tappdV4Base64), (ch) => ch.charCodeAt(0))
    return { quote: buf }
  },
  { upgradeWebSocket },
)

/* ********************************************************************************
 * End teekit tunnel code.
 * ******************************************************************************** */

let messages: Message[] = []
let totalMessageCount = 0
const MAX_MESSAGES = 30
const startTime = Date.now()
let counter = 0

wss.on("connection", (ws) => {
  // Send backlog on connect
  const hiddenCount = Math.max(0, totalMessageCount - messages.length)
  const backlogMessage: BacklogMessage = {
    type: "backlog",
    messages,
    hiddenCount,
  }
  ws.send(JSON.stringify(backlogMessage))

  // Broadcast on incoming chat messages
  ws.on("message", (data) => {
    try {
      const incoming: IncomingChatMessage = JSON.parse(
        typeof data === "string" ? data : new TextDecoder().decode(data),
      )

      if (incoming?.type === "chat") {
        const chatMessage: Message = {
          id: Date.now().toString(),
          username: incoming.username,
          text: incoming.text,
          timestamp: new Date().toISOString(),
        }

        messages.push(chatMessage)
        totalMessageCount += 1
        if (messages.length > MAX_MESSAGES) {
          messages = messages.slice(-MAX_MESSAGES)
        }

        const broadcast: BroadcastMessage = {
          type: "message",
          message: chatMessage,
        }

        // iterate over ServerRAMockWebSocket instances
        wss.clients.forEach((client: ServerRAMockWebSocket) => {
          if (client.readyState === 1 /* WebSocket.OPEN */) {
            client.send(JSON.stringify(broadcast))
          }
        })
      }
    } catch (err) {
      console.error("[kettle] Error parsing message:", err)
      // Echo anything that doesn't parse as JSON so we can test this
      ws.send(data)
    }
  })
})

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

/* ********************************************************************************
 * Other workerd related fixtures below.
 * ******************************************************************************** */

// Readiness/liveness probe
app.get("/healthz", async (c) => {
  try {
    if (c.env.DB_URL && c.env.DB_TOKEN) {
      const db = getDb(c.env)
      await db.execute("SELECT 1")
    }
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message || e) }, 503)
  }
})

app.all("/quote", async (c) => {
  try {
    const publicKeyArray =
      c.req.method === "POST" ? (await c.req.json()).publicKey : [0]

    if (!publicKeyArray || !Array.isArray(publicKeyArray)) {
      return c.json({ error: "publicKey must be an array of numbers" }, 400)
    }
    const publicKey = new Uint8Array(publicKeyArray)

    // Prefer QUOTE binding when available
    if (c.env.QUOTE && typeof c.env.QUOTE.getQuote === "function") {
      const quoteData = await c.env.QUOTE.getQuote(publicKey)
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
    }

    // Fallback: sample quote for test environments
    console.log("[kettle] /quote: responding with sample quote")
    const { tappdV4Base64 } = await import("@teekit/tunnel/samples")
    const buf = Uint8Array.from(atob(tappdV4Base64), (c) => c.charCodeAt(0))
    return c.json({ quote: Array.from(buf) })
  } catch (error) {
    console.error("[kettle] Error getting quote:", error)
    return c.json({ error: String(error) }, 500)
  }
})

// libsql helper and routes
let cachedClient: LibsqlClient | null = null
function getDb(env: Env): LibsqlClient {
  if (!env.DB_URL || !env.DB_TOKEN) {
    throw new Error("Database not configured")
  }
  if (cachedClient) return cachedClient
  let customFetch: typeof fetch = fetch

  console.log("getDb called, no client found in cache")

  if (env.DB_HTTP) {
    const base = new URL(env.DB_URL)

    customFetch = async (input: string | Request | URL, init?: RequestInit) => {
      const inputUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : (input as Request).url
      const url = new URL(inputUrl, base)

      // Extract request components without constructing a Request from a relative URL
      const method = (init?.method ||
        (input instanceof Request ? input.method : undefined) ||
        "GET") as string

      const headers = new Headers()
      if (init?.headers) {
        const h = new Headers(init.headers as HeadersInit)
        h.forEach((v, k) => headers.set(k, v))
      } else if (input instanceof Request) {
        input.headers.forEach((v, k) => headers.set(k, v))
      }

      let body: BodyInit | undefined = init?.body as any
      if (
        !body &&
        input instanceof Request &&
        method !== "GET" &&
        method !== "HEAD"
      ) {
        body = await input.arrayBuffer()
      }

      // Route local DB requests via the bound service fetcher, using an absolute URL string
      if (
        url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.origin === base.origin
      ) {
        const absolute = url.toString()
        const res = await env.DB_HTTP!.fetch(absolute, {
          method,
          headers,
          body,
        } as RequestInit)
        try {
          if (!res.ok) {
            const preview = await res.clone().text()
            console.error(
              `[kettle] DB_HTTP ${method} ${absolute} -> ${res.status} ${
                res.statusText
              } :: ${preview.substring(0, 200)}`,
            )
          }
        } catch {}
        return res
      }

      // Otherwise, perform a normal fetch to the computed absolute URL
      return await fetch(url.toString(), {
        method,
        headers,
        body,
      } as RequestInit)
    }
  }
  cachedClient = createClient({
    url: env.DB_URL,
    authToken: env.DB_TOKEN,
    fetch: customFetch,
  })
  return cachedClient
}

app.post("/db/init", async (c) => {
  try {
    const db = getDb(c.env)
    await db.execute(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)",
    )
    return c.json({ ok: true })
  } catch (e: any) {
    console.error("[kettle] /db/init error:", e)
    if (String(e?.message || e).includes("Database not configured")) {
      return c.json({ error: "DB not configured" }, 501)
    }
    return c.json({ error: String(e) }, 500)
  }
})

app.post("/db/put", async (c) => {
  try {
    const body = await c.req.json()
    const key = body?.key
    const value = body?.value
    if (typeof key !== "string" || typeof value !== "string") {
      return c.json({ error: "key and value must be strings" }, 400)
    }
    const db = getDb(c.env)
    await db.execute({
      sql: "INSERT INTO kv(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      args: [key, value],
    })
    return c.json({ ok: true })
  } catch (e: any) {
    console.error("[kettle] /db/put error:", e)
    if (String(e?.message || e).includes("Database not configured")) {
      return c.json({ error: "DB not configured" }, 501)
    }
    return c.json({ error: String(e) }, 500)
  }
})

app.get("/db/get", async (c) => {
  try {
    const key = c.req.query("key")
    if (!key) return c.json({ error: "key is required" }, 400)
    const db = getDb(c.env)
    const rs = await db.execute({
      sql: "SELECT value FROM kv WHERE key = ?1",
      args: [key],
    })
    const row = rs.rows?.[0]
    if (!row) return c.json({ error: "not found" }, 404)
    const value = row.value ?? Object.values(row)[0]
    return c.json({ key, value })
  } catch (e: any) {
    console.error("[kettle] /db/get error:", e)
    if (String(e?.message || e).includes("Database not configured")) {
      return c.json({ error: "DB not configured" }, 501)
    }
    return c.json({ error: String(e) }, 500)
  }
})

// bare websocket echo handler
app.get(
  "/ws",
  upgradeWebSocket(
    (): WSEvents => ({
      onMessage(event, ws) {
        try {
          if (event.data instanceof Blob) {
            event.data.arrayBuffer().then((buf) => {
              ws.send(new Uint8Array(buf))
            })
          } else if (event.data instanceof ArrayBuffer) {
            ws.send(new Uint8Array(event.data))
          } else if (event.data instanceof Uint8Array) {
            ws.send(event.data)
          } else if (event.data instanceof SharedArrayBuffer) {
            const src = new Uint8Array(event.data)
            const clone = new Uint8Array(src.length)
            clone.set(src)
            ws.send(clone)
          } else {
            ws.send(String(event.data))
          }
        } catch (err) {
          console.error("[kettle] Error echoing message:", err)
        }
      },
      onOpen() {
        console.log("[kettle] WebSocket connection opened")
      },
      onClose(event) {
        console.log(
          `[kettle] WebSocket connection closed - code: ${event.code}, reason: ${event.reason}`,
        )
      },
      onError(event) {
        console.error("[kettle] WebSocket error:", event)
      },
    }),
  ),
)

// TODO: Static file serving
// Note: In workerd, static files should be served via Assets binding configured in workerd.config.capnp
// For now, we'll just serve the API routes

export default app
