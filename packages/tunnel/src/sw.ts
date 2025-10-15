/// <reference lib="webworker" />
/* eslint-env serviceworker */
declare const self: ServiceWorkerGlobalScope

// Minimal encrypted tunnel client inside a Service Worker.
// Reads target origin from the ServiceWorker script URL query: ?target=...

import sodium from "./crypto.js"
import { encode, decode } from "cbor-x"

type RAEncryptedHTTPRequest = {
  type: "http_request"
  requestId: string
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

type RAEncryptedHTTPResponse = {
  type: "http_response"
  requestId: string
  status: number
  statusText: string
  headers: Record<string, string | string[]>
  body?: string | Uint8Array
  error?: string
}

type ControlChannelKXConfirm = {
  type: "client_kx"
  sealedSymmetricKey: Uint8Array
}

type ControlChannelEncryptedMessage = {
  type: "enc"
  nonce: Uint8Array
  ciphertext: Uint8Array
}

// Parse configuration from script URL
const swUrl = new URL(self.location.href)
const TARGET_ORIGIN = swUrl.searchParams.get("target") || self.location.origin

let ws: WebSocket | null = null
let symmetricKey: Uint8Array | undefined
let connectionPromise: Promise<void> | null = null
const pendingRequests = new Map<
  string,
  { resolve: (response: Response) => void; reject: (error: Error) => void }
>()

// Reuse TextDecoder instance to avoid repeated allocations
const textDecoder = new TextDecoder()

function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function ensureConnection(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN && symmetricKey) return
  if (connectionPromise) return connectionPromise

  connectionPromise = new Promise<void>((resolve, reject) => {
    const url = new URL(TARGET_ORIGIN)
    url.protocol = url.protocol.replace(/^http/, "ws")
    url.pathname = "/__ra__"

    ws = new WebSocket(url.toString())
    ws.binaryType = "arraybuffer"

    ws.onopen = () => {
      console.log(
        "[teekit-sw] ServiceWorker WebSocket opened to",
        url.toString(),
      )
      // Wait for server_kx before resolving
    }

    ws.onmessage = async (event) => {
      try {
        const bytes =
          event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : new Uint8Array(await event.data.arrayBuffer?.())
        let message: any = decode(bytes)

        console.log(
          "[teekit-sw] ServiceWorker received message:",
          message?.type || "unknown",
          message,
        )

        if (message && message.type === "server_kx") {
          try {
            const serverPub: Uint8Array = message.x25519PublicKey
            const key = new Uint8Array(32)
            crypto.getRandomValues(key)
            const sealed = sodium.crypto_box_seal(key, serverPub)
            symmetricKey = key

            const reply: ControlChannelKXConfirm = {
              type: "client_kx",
              sealedSymmetricKey: sealed,
            }
            console.log("[teekit-sw] ServiceWorker completing client_kx")
            ws!.send(encode(reply))

            connectionPromise = null
            resolve()
          } catch (e) {
            connectionPromise = null
            reject(e as Error)
          }
          return
        }

        if (message && message.type === "enc") {
          if (!symmetricKey) return
          const nonce: Uint8Array = message.nonce
          const ciphertext: Uint8Array = message.ciphertext
          const plaintext = sodium.crypto_secretbox_open_easy(
            ciphertext,
            nonce,
            symmetricKey,
          )
          message = decode(plaintext)

          if (message && message.type === "http_response") {
            const res = message as RAEncryptedHTTPResponse
            console.log(
              `[teekit-sw] ServiceWorker received HTTP response ${res.requestId} (${res.status})`,
            )
            const pending = pendingRequests.get(res.requestId)
            if (!pending) return
            pendingRequests.delete(res.requestId)

            if (res.error) {
              pending.reject(new Error(res.error))
              return
            }

            const body = res.status === 204 ? null : res.body ?? null
            const hdrs = new Headers()
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) {
                for (const vv of v) hdrs.append(k, vv)
              } else {
                hdrs.set(k, v)
              }
            }
            const response = new Response(body as any, {
              status: res.status,
              statusText: res.statusText,
              headers: hdrs,
            })
            pending.resolve(response)
            return
          }
        }
      } catch (err) {
        // Drop malformed messages
      }
    }

    ws.onclose = () => {
      console.log("[teekit-sw] ServiceWorker WebSocket closed")
      connectionPromise = null
      symmetricKey = undefined
      try {
        for (const [, p] of pendingRequests.entries()) {
          p.reject(new Error("Tunnel disconnected"))
        }
      } finally {
        pendingRequests.clear()
      }
    }

    ws.onerror = () => {
      console.log("[teekit-sw] ServiceWorker WebSocket connection error")
      const err = new Error("WebSocket connection failed")
      connectionPromise = null
      try {
        for (const [, p] of pendingRequests.entries()) {
          p.reject(err)
        }
      } finally {
        pendingRequests.clear()
      }
      reject(err)
    }
  })

  return connectionPromise
}

function encryptPayload(payload: any): ControlChannelEncryptedMessage {
  if (!symmetricKey) throw new Error("Missing symmetric key")
  const nonce = new Uint8Array(24)
  crypto.getRandomValues(nonce)
  const plaintext = encode(payload)
  const ciphertext = sodium.crypto_secretbox_easy(
    plaintext,
    nonce,
    symmetricKey,
  )
  return { type: "enc", nonce, ciphertext }
}

async function tunnelFetch(request: Request): Promise<Response> {
  await ensureConnection()

  // Build absolute URL targeting the configured origin
  const reqUrl = new URL(request.url)
  const tgt = new URL(TARGET_ORIGIN)
  const forwardUrl = `${tgt.origin}${reqUrl.pathname}${reqUrl.search}`

  // Collect headers
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  // Read body as string where applicable
  let body: string | undefined
  if (request.method !== "GET" && request.method !== "HEAD") {
    const ab = await request.arrayBuffer()
    if (ab && ab.byteLength > 0) {
      body = textDecoder.decode(new Uint8Array(ab))
    }
  }

  const requestId = generateRequestId()
  const payload: RAEncryptedHTTPRequest = {
    type: "http_request",
    requestId,
    method: request.method,
    url: forwardUrl,
    headers,
    body,
  }

  console.log(
    "[teekit-sw] ServiceWorker sent HTTP request:",
    requestId,
    request.method,
    forwardUrl,
  )

  return new Promise<Response>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject })

    try {
      const env = encryptPayload(payload)
      ws!.send(encode(env))
    } catch (e) {
      pendingRequests.delete(requestId)
      reject(e as Error)
      return
    }

    const timer = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId)
        reject(new Error("Request timeout"))
      }
    }, 30000)
    ;(timer as any).unref?.()
  })
}

self.addEventListener("install", (event: ExtendableEvent) => {
  // Take over immediately
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", (event: FetchEvent) => {
  const { request } = event
  const url = new URL(request.url)

  // Only intercept same-origin, non-navigation, non-asset requests.
  // We focus on programmatic fetch() calls (destination === "").
  const isSameOrigin = url.origin === self.location.origin
  const isProgrammatic = request.destination === ""
  const isControlChannel = url.pathname.startsWith("/__ra__")

  if (!isSameOrigin || !isProgrammatic || isControlChannel) {
    return
  }

  event.respondWith(
    (async () => {
      try {
        return await tunnelFetch(request)
      } catch (err) {
        // On failure, fall back to network
        return fetch(request)
      }
    })(),
  )
})
