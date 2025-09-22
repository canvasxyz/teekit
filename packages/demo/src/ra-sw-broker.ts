import { TunnelClient } from "ra-https-tunnel"

// Register the Service Worker as early as possible
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  // Use root scope so all same-origin requests are intercepted
  navigator.serviceWorker
    .register("/ra-sw.js", { scope: "/" })
    .then((reg) => {
      // Optionally log
      // console.log("RA SW registered:", reg.scope)
    })
    .catch((err) => {
      console.error("Failed to register RA SW:", err)
    })
}

// Page-side broker to service SW fetches via the encrypted tunnel
const CHANNEL_NAME = "ra-https-tunnel"
const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null

// Compute base URL for the tunnel server (mirrors App.tsx logic)
const baseUrl =
  typeof document !== "undefined" && document.location.hostname === "localhost"
    ? "http://localhost:3001"
    : "https://ra-https.up.railway.app"

let tunnelPromise: Promise<TunnelClient> | null = null

async function getTunnel(): Promise<TunnelClient> {
  if (!tunnelPromise) {
    tunnelPromise = TunnelClient.initialize(baseUrl, {
      match: () => true,
    })
  }
  return tunnelPromise
}

function normalizeHeaders(initHeaders: Record<string, string> | undefined): HeadersInit {
  const headers: Record<string, string> = {}
  if (initHeaders) {
    for (const k of Object.keys(initHeaders)) headers[k] = String(initHeaders[k])
  }
  // Ensure cookies are forwarded for same-origin requests
  try {
    if (typeof document !== "undefined" && document.cookie) {
      if (!("cookie" in headers)) headers["cookie"] = document.cookie
    }
  } catch {}
  return headers
}

async function handleHttpRequestMessage(message: any) {
  try {
    const enc = await getTunnel()
    const url: string = message.url
    const method: string = message.method || "GET"
    const headers: HeadersInit = normalizeHeaders(message.headers)
    const body: BodyInit | undefined = typeof message.body === "string" ? message.body : undefined

    // Important: use the encrypted tunnel fetch
    const resp = await enc.fetch(url, {
      method,
      headers,
      body,
    })

    const text = await resp.text()
    const headersObj: Record<string, string> = {}
    resp.headers.forEach((v, k) => (headersObj[k] = v))

    bc?.postMessage({
      type: "http_response",
      id: message.id,
      status: resp.status,
      statusText: resp.statusText,
      headers: headersObj,
      body: text,
    })
  } catch (e: any) {
    bc?.postMessage({
      type: "http_response",
      id: message.id,
      status: 502,
      statusText: "Bad Gateway",
      headers: {},
      body: "",
      error: e?.message || String(e),
    })
  }
}

if (bc) {
  bc.addEventListener("message", (evt) => {
    const data = (evt && (evt as any).data) || null
    if (!data) return
    if (data.type === "http_request" && data.url) {
      handleHttpRequestMessage(data)
    }
  })
}

