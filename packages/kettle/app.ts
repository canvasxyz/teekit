import { Hono } from "hono"
import { cors } from "hono/cors"
import { WSEvents } from "hono/ws"
import { upgradeWebSocket } from "hono/cloudflare-workers"
import { ContentfulStatusCode } from "hono/utils/http-status"
import { TunnelServer, ServerRAMockWebSocket } from "@teekit/tunnel"

import {
  serveStatic,
  getDb,
  getQuoteFromService,
  type Env,
} from "@teekit/kettle/worker"

import type {
  Message,
  IncomingChatMessage,
  BroadcastMessage,
  BacklogMessage,
} from "./types.js"

const app = new Hono<{ Bindings: Env }>()
app.use("/*", cors())

// Initialization hook
export async function onInit(env: Env) {
  const db = getDb(env)
  await db.execute(
    "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)",
  )
}

// Ephemeral global state
let messages: Message[] = []
let totalMessageCount = 0
const MAX_MESSAGES = 30
const startTime = Date.now()
let counter = 0

const { wss } = await TunnelServer.initialize(app, getQuoteFromService, {
  upgradeWebSocket,
})

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
 * Other routes used to test workerd implementation below.
 * ******************************************************************************** */

app.get("/healthz", async (c) => {
  if (c.env.DB_URL && c.env.DB_TOKEN) {
    const db = getDb(c.env)
    await db.execute("SELECT 1")
  }
  return c.json({ ok: true })
})

app.all("/quote", async (c) => {
  const publicKeyArray =
    c.req.method === "POST" ? (await c.req.json()).publicKey : []

  if (!publicKeyArray || !Array.isArray(publicKeyArray)) {
    return c.json({ error: "invalid publicKey" }, 400)
  }

  const response = await c.env.QUOTE_SERVICE.fetch(
    new Request("http://quote-service/quote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ publicKey: publicKeyArray }),
    }),
  )

  if (!response.ok) {
    const error = await response.json()
    return c.json(error, response.status as ContentfulStatusCode)
  }

  const quoteData = await response.json()
  return c.json(quoteData)
})

app.post("/db/put", async (c) => {
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
})

app.get("/db/get", async (c) => {
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
app.get("*", serveStatic())

export default app
