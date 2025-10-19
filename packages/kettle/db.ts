import { createClient, type Client as LibsqlClient } from "@libsql/client"

export interface FetcherLike {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>
}

export interface DbBindings {
  DB_URL?: string
  DB_TOKEN?: string
  DB_HTTP?: FetcherLike
}

export interface DbConfig {
  url: string
  token: string
  serviceFetcher?: FetcherLike
}

export function makeServiceFetch(
  baseUrl: string,
  service?: FetcherLike,
): typeof fetch {
  if (!service) return fetch

  const base = new URL(baseUrl)
  return async (input: Request | string | URL, init?: RequestInit) => {
    const inputUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request).url

    const url = new URL(inputUrl, base)

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

    // TODO: this might not be necessary
    const shouldRouteViaService =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.origin === base.origin

    if (shouldRouteViaService) {
      return service.fetch(url.toString(), {
        method,
        headers,
        body,
      } as RequestInit)
    }
    return fetch(url.toString(), { method, headers, body } as RequestInit)
  }
}

const clientCache = new Map<string, LibsqlClient>()

function cacheKey(cfg: DbConfig): string {
  return `${cfg.url}|${cfg.token}`
}

export function createDbClient(cfg: DbConfig): LibsqlClient {
  const key = cacheKey(cfg)
  const cached = clientCache.get(key)
  if (cached) return cached

  const client = createClient({
    url: cfg.url,
    authToken: cfg.token,
    fetch: makeServiceFetch(cfg.url, cfg.serviceFetcher),
  })
  clientCache.set(key, client)
  return client
}

export function getDb(env: DbBindings): LibsqlClient {
  if (!env.DB_URL || !env.DB_TOKEN) {
    throw new Error("Database not configured")
  }
  if (!env.DB_HTTP) {
    throw new Error("Missing DB_HTTP bindings")
  }
  return createDbClient({
    url: env.DB_URL, // @libsql/client target url
    token: env.DB_TOKEN, // @libsql/client authToken
    serviceFetcher: env.DB_HTTP, // fetch is exposed on env.DB_HTTP
  })
}
