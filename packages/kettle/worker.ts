// Worker entrypoint that proxies all requests to a single Durable Object
// The Durable Object dynamically imports the Hono app from app.ts and serves requests

// Minimal env typing for clarity; rely on runtime availability in workerd
interface DurableObjectId {
  toString(): string
}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}
interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectId
  idFromString(id: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

interface FetcherLike {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>
}

interface Env {
  HONO_DO: DurableObjectNamespaceLike
  DB_URL?: string
  DB_TOKEN?: string
  DB_HTTP?: FetcherLike
  QUOTE?: { getQuote(x25519PublicKey: Uint8Array): Promise<any> }
}

export class HonoDurableObject {
  private state: DurableObjectState
  private env: Env
  private appPromise: Promise<any> | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  private async getApp(): Promise<any> {
    if (!this.appPromise) {
      this.appPromise = (async () => {
        // Import the built Hono application module provided by workerd config
        // Use a bare specifier matching the embedded module name
        const mod = await import("app.js")
        const app = mod?.default
        if (!app || typeof app.fetch !== "function") {
          throw new Error("Hono app default export with fetch() not found")
        }
        return app
      })()
    }
    return this.appPromise
  }

  async fetch(request: Request): Promise<Response> {
    const app = await this.getApp()
    // Hono on Cloudflare/Workerd supports app.fetch(req, env[, ctx])
    try {
      return await app.fetch(request, this.env)
    } catch (err: any) {
      console.error("[worker] DO fetch error:", err)
      return new Response(String(err?.message || err), { status: 500 })
    }
  }
}

// The outer Worker simply forwards all requests (HTTP + WS upgrades) to the singleton DO
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.HONO_DO.idFromName("singleton")
    const stub = env.HONO_DO.get(id)
    return await stub.fetch(request)
  },
}
