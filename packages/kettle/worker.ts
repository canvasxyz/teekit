// minimal env typing for clarity; relies on runtime availability in workerd
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
interface DurableObjectStateLike<Props = unknown> {
  waitUntil(promise: Promise<any>): void
  readonly props: Props
  readonly id: DurableObjectId
  readonly storage: unknown
  acceptWebSocket(ws: WebSocket, tags?: string[]): void
  getWebSockets(tag?: string): WebSocket[]
  getTags(ws: WebSocket): string[]
  abort(reason?: string): void
}

interface FetcherLike {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>
}

export interface Env {
  HONO_DO: DurableObjectNamespaceLike
  DB_URL?: string
  DB_TOKEN?: string
  DB_HTTP?: FetcherLike
  QUOTE_SERVICE_URL: string
  QUOTE_SERVICE: FetcherLike
}

// wrapper durable object that forwards all requests to the application
export class HonoDurableObject {
  // @ts-ignore TS6133
  private state: DurableObjectState
  private env: Env
  private appPromise: Promise<any> | null = null

  constructor(state: DurableObjectStateLike, env: Env) {
    this.state = state
    this.env = env
  }

  // dynamically import and cache the user-provided hono application
  private async getApp(): Promise<any> {
    if (!this.appPromise) {
      this.appPromise = (async () => {
        // @ts-ignore external
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

  // hono on workerd supports app.fetch(req, env[, ctx])
  async fetch(request: Request): Promise<Response> {
    const app = await this.getApp()
    try {
      return await app.fetch(request, this.env)
    } catch (err: any) {
      console.error("[worker] DO fetch error:", err)
      return new Response(String(err?.message || err), { status: 500 })
    }
  }
}

// outer worker that forwards all requests to the durable object
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.HONO_DO.idFromName("singleton")
    const stub = env.HONO_DO.get(id)
    return await stub.fetch(request)
  },
}
