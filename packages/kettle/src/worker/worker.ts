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

// Type definitions for workerd's DurableObject runtime API
interface DurableObjectState {
  waitUntil(promise: Promise<any>): void
  readonly id: DurableObjectId
  readonly storage: DurableObjectStorage
  acceptWebSocket(ws: WebSocket, tags?: string[]): void
  getWebSockets(tag?: string): WebSocket[]
  getTags(ws: WebSocket): string[]
  abort(reason?: string): void
}

export interface SqlStorageCursor {
  toArray(): Record<string, unknown>[]
  one(): Record<string, unknown>
  raw(): Iterator<unknown[]>
  readonly columnNames: string[]
  readonly rowsRead: number
  readonly rowsWritten: number
}

export interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlStorageCursor
  readonly databaseSize: number
}

export interface DurableObjectStorage {
  get(key: string): Promise<any>
  get(keys: string[]): Promise<Map<string, any>>
  put(key: string, value: any): Promise<void>
  put(entries: Record<string, any>): Promise<void>
  delete(key: string): Promise<boolean>
  delete(keys: string[]): Promise<number>
  list(options?: any): Promise<Map<string, any>>
  // SQL storage API (available when enableSql = true in config)
  sql?: SqlStorage
  transactionSync?<T>(fn: () => T): T
}

// Base class from cloudflare:workers (runtime-only, imported at runtime)
// Modern workerd uses 'ctx' instead of 'state' for the DurableObjectState
declare class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState
  protected env: Env
  constructor(ctx: DurableObjectState, env: Env)
}

interface FetcherLike {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>
}

export interface Env {
  HONO_DO: DurableObjectNamespaceLike
  DB_URL?: string
  DB_TOKEN?: string
  DB_HTTP?: FetcherLike
  QUOTE_SERVICE: FetcherLike
  STATIC_FILES?: FetcherLike
  // DO storage is injected by HonoDurableObject when SQL is enabled
  DO_STORAGE?: DurableObjectStorage
}

// Import DurableObject base class from workerd (runtime-only module)
// @ts-ignore - cloudflare:workers is a runtime module provided by workerd
import { DurableObject } from "cloudflare:workers"

const DATABASE_ERROR_MARKER = "KETTLE_DATABASE_INIT_FAILED"

// Wrapper Durable Object that forwards all requests to the application
export class HonoDurableObject extends DurableObject<Env> {
  private appPromise: Promise<any> | null = null
  private sqlAvailable: boolean | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  // Dynamically import and cache the user-provided Hono application
  private async getApp(): Promise<any> {
    if (!this.appPromise) {
      this.appPromise = (async () => {
        // @ts-ignore external
        const mod = await import("app.js")
        const app = mod?.default
        if (!app || typeof app.fetch !== "function") {
          throw new Error("Hono app default export with fetch() not found")
        }

        // Test database connectivity before calling onInit
        // This detects corruption/decryption failures early
        const enhancedEnv: Env = { ...this.env }
        if (this.testDatabaseAvailabilityThrowOnInvalid()) {
          enhancedEnv.DO_STORAGE = this.ctx.storage as DurableObjectStorage
        }

        // Call onInit hook if exported (runs once when app is first loaded)
        if (typeof mod.onInit === "function") {
          try {
            await mod.onInit(enhancedEnv)
          } catch (error) {
            // Log the specific error marker that the launcher script watches for
            console.error(`[worker] ${DATABASE_ERROR_MARKER}`)
            console.error("[worker] onInit failed:", error)
            console.error("[worker] This may indicate database corruption or decryption failure.")
            throw error
          }
        }

        return app
      })()
    }
    return this.appPromise
  }

  // Test database availability and detect corruption/decryption failures
  // Returns true if database is available and functional, false if SQL storage doesn't exist
  // Throws with DATABASE_ERROR_MARKER if database exists but is corrupted/inaccessible
  private testDatabaseAvailabilityThrowOnInvalid(): boolean {
    if (this.sqlAvailable !== null) {
      return this.sqlAvailable
    }
    try {
      // Check if sql property exists and has exec method
      const storage = this.ctx.storage as DurableObjectStorage
      if (!storage.sql || typeof storage.sql.exec !== "function") {
        this.sqlAvailable = false
        return false
      }
      // Try a simple query to verify SQL is functional
      // This will throw if SQL isn't actually enabled or if the database is corrupted
      storage.sql.exec("SELECT 1")
      this.sqlAvailable = true
      console.log("[worker] Database connection test passed")
      return true
    } catch (error) {
      // Log the specific error marker that the launcher script watches for
      console.error(`[worker] ${DATABASE_ERROR_MARKER}`)
      console.error("[worker] Database connection test failed:", error)
      console.error("[worker] This may indicate database corruption or decryption failure.")
      this.sqlAvailable = false
      throw error
    }
  }

  // Check if SQL storage is available (cached result from testDatabaseAvailabilityThrowOnInvalid)
  private isSqlAvailable(): boolean {
    if (this.sqlAvailable !== null) {
      return this.sqlAvailable
    }
    // If not yet tested, run the test
    try {
      return this.testDatabaseAvailabilityThrowOnInvalid()
    } catch {
      return false
    }
  }

  // hono on workerd supports app.fetch(req, env[, ctx])
  async fetch(request: Request): Promise<Response> {
    const app = await this.getApp()
    try {
      // Only inject DO storage if SQL API is actually available and functional
      // This allows the app to use getDb() with DO storage transparently
      const enhancedEnv: Env = { ...this.env }
      if (this.isSqlAvailable()) {
        enhancedEnv.DO_STORAGE = this.ctx.storage as DurableObjectStorage
      }
      return await app.fetch(request, enhancedEnv)
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
