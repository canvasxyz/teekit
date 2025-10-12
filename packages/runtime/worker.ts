import { Hono } from "hono"
import { cors } from "hono/cors"
import { createClient, type Client as LibsqlClient } from "@libsql/client"

// TODO: TunnelServer integration commented out until workerd WebSocket adapter is implemented
// import { TunnelServer } from "@teekit/tunnel"

// Workerd types
interface Fetcher {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>
}

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
  // Optional libsql over HTTP Hrana bindings provided by demo runner
  DB_URL?: string
  DB_TOKEN?: string
  DB_HTTP?: Fetcher
}

const app = new Hono<{ Bindings: Env }>()

app.use("/*", cors())

// let messages: Message[] = []
// let totalMessageCount = 0
// const MAX_MESSAGES = 30
const startTime = Date.now()
let counter = 0

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

// Readiness/liveness probe
app.get("/healthz", async (c) => {
  try {
    // If DB bindings exist, verify we can reach the DB; otherwise still report healthy
    if (c.env.DB_URL && c.env.DB_TOKEN) {
      const db = getDb(c.env)
      await db.execute("SELECT 1")
    }
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message || e) }, 503)
  }
})

app.post("/quote", async (c) => {
  try {
    const body = await c.req.json()
    const publicKeyArray = body.publicKey

    if (!publicKeyArray || !Array.isArray(publicKeyArray)) {
      return c.json({ error: "publicKey must be an array of numbers" }, 400)
    }
    const publicKey = new Uint8Array(publicKeyArray)

    // Prefer QUOTE binding when available (workerd with Node privileges)
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

    // Fallback: sample quote for test environments without QUOTE binding
    const { tappdV4Base64 } = await import("./shared/samples.js")
    const buf = Uint8Array.from(atob(tappdV4Base64), (c) => c.charCodeAt(0))
    return c.json({ quote: Array.from(buf) })
  } catch (error) {
    console.error("[teekit-runtime] Error getting quote:", error)
    return c.json({ error: String(error) }, 500)
  }
})

// --- libsql helper and routes (enabled when DB_URL/DB_TOKEN bindings exist) ---
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
        const res = await env.DB_HTTP!.fetch(
          absolute as any,
          {
            method,
            headers,
            body: body as any,
          } as RequestInit,
        )
        try {
          if (!res.ok) {
            const preview = await res.clone().text()
            console.error(
              `[teekit-runtime] DB_HTTP ${method} ${absolute} -> ${
                res.status
              } ${res.statusText} :: ${preview.substring(0, 200)}`,
            )
          }
        } catch {}
        return res
      }

      // Otherwise, perform a normal fetch to the computed absolute URL
      return await fetch(url.toString(), {
        method,
        headers,
        body: body as any,
      } as RequestInit)
    }
  }
  cachedClient = createClient({
    url: env.DB_URL,
    authToken: env.DB_TOKEN,
    fetch: customFetch as any,
  })
  return cachedClient
}

app.post("/db/init", async (c) => {
  try {
    const db = getDb(c.env)
    await withDbRetry(async () => {
      await db.execute(
        "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)",
      )
    })
    return c.json({ ok: true })
  } catch (e: any) {
    console.error("[teekit-runtime] /db/init error:", e)
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
    await withDbRetry(async () => {
      await db.execute({
        sql: "INSERT INTO kv(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        args: [key, value],
      })
    })
    return c.json({ ok: true })
  } catch (e: any) {
    console.error("[teekit-runtime] /db/put error:", e)
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
    const rs = await withDbRetry(async () => {
      return await db.execute({
        sql: "SELECT value FROM kv WHERE key = ?1",
        args: [key],
      })
    })
    const row = rs.rows?.[0]
    if (!row) return c.json({ error: "not found" }, 404)
    const value = (row as any).value ?? Object.values(row)[0]
    return c.json({ key, value })
  } catch (e: any) {
    console.error("[teekit-runtime] /db/get error:", e)
    if (String(e?.message || e).includes("Database not configured")) {
      return c.json({ error: "DB not configured" }, 501)
    }
    return c.json({ error: String(e) }, 500)
  }
})

// TODO: WebSocket handling in workerd
// The TunnelServer WebSockest/chat will need to be adapted for workerd's WebSocket API

// TODO: Static file serving
// Note: In workerd, static files should be served via Assets binding configured in workerd.config.capnp
// For now, we'll just serve the API routes

export default app

async function withDbRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: any
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e: any) {
      const msg = String(e?.message || e)
      const retryable =
        Boolean(e?.retryable) || /network|ECONN|EPIPE|reset/i.test(msg)
      lastErr = e
      if (!retryable || i === attempts - 1) throw e
      const delayMs = 100 * (i + 1)
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}
