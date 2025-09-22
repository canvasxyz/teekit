// ra-sw.js - Service Worker that intercepts same-origin HTTP requests
// and forwards them to the page via BroadcastChannel for tunneling.

// Configuration can be prepended here if needed, e.g.:
// self.RA_HTTPS_SW_CONFIG = { baseUrl: "https://example.com" }

// Immediately take control on install/activate
self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// Create a single BroadcastChannel for request/response exchange
const CHANNEL_NAME = 'ra-https-tunnel'
let bc

function getBroadcastChannel() {
  if (!bc) {
    try {
      bc = new BroadcastChannel(CHANNEL_NAME)
    } catch (e) {
      // BroadcastChannel not available; leave undefined to trigger network fallback
      bc = null
    }
  }
  return bc
}

function isSameOrigin(urlString) {
  try {
    const u = new URL(urlString)
    return u.origin === self.location.origin
  } catch {
    return false
  }
}

function shouldBypass(request) {
  try {
    const url = new URL(request.url)
    // Bypass navigation/document requests to avoid breaking app shell
    if (request.mode === 'navigate') return true
    // Only intercept programmatic fetch() calls (destination is empty string)
    if (request.destination && request.destination !== '') return true
    // Bypass the service worker script itself and RA control channel
    if (url.pathname === '/ra-sw.js' || url.pathname.startsWith('/__ra__')) return true
    // Only handle http(s) same-origin requests
    if (!isSameOrigin(request.url)) return true
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
    return false
  } catch {
    return true
  }
}

async function readBodyAsString(request) {
  // Only attempt to read body for methods that usually have one
  const method = (request.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return undefined
  try {
    // Prefer text; this demo focuses on JSON/text payloads
    return await request.text()
  } catch {
    // Fallback to ArrayBuffer -> UTF-8 decode
    try {
      const ab = await request.arrayBuffer()
      return new TextDecoder().decode(ab)
    } catch {
      return undefined
    }
  }
}

function headersToObject(headers) {
  const out = {}
  try {
    for (const [k, v] of headers.entries()) {
      out[k] = v
    }
  } catch {}
  return out
}

function objectToHeaders(obj) {
  const headers = new Headers()
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      try { headers.append(k, obj[k]) } catch {}
    }
  }
  return headers
}

function timeout(ms) {
  return new Promise((_, reject) => {
    const t = setTimeout(() => {
      clearTimeout(t)
      reject(new Error('SW tunnel timeout'))
    }, ms)
    // no unref in browser
  })
}

async function tunnelFetchThroughPage(request) {
  const channel = getBroadcastChannel()
  if (!channel) throw new Error('BroadcastChannel unavailable')

  const correlationId = Math.random().toString(36).slice(2)
  const reqUrl = request.url
  const method = request.method || 'GET'
  const headers = headersToObject(request.headers)
  const body = await readBodyAsString(request)

  const responsePromise = new Promise((resolve, reject) => {
    const onMessage = (evt) => {
      const data = evt && evt.data
      if (!data || data.type !== 'http_response' || data.id !== correlationId) return
      channel.removeEventListener('message', onMessage)
      if (data.error) {
        reject(new Error(data.error))
        return
      }
      try {
        const respHeaders = objectToHeaders(data.headers || {})
        const responseInit = {
          status: data.status || 200,
          statusText: data.statusText || '',
          headers: respHeaders,
        }
        const respBody = typeof data.body === 'string' ? data.body : ''
        resolve(new Response(respBody, responseInit))
      } catch (e) {
        reject(e)
      }
    }
    channel.addEventListener('message', onMessage)
  })

  // Send the request to any listening page script
  try {
    channel.postMessage({
      type: 'http_request',
      id: correlationId,
      url: reqUrl,
      method,
      headers,
      body,
    })
  } catch (e) {
    throw e
  }

  // Race with timeout; fallback handled by caller
  const result = await Promise.race([responsePromise, timeout(30000)])
  return result
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (shouldBypass(request)) return

  event.respondWith((async () => {
    try {
      const response = await tunnelFetchThroughPage(request)
      if (response) return response
      // If no response (unexpected), fall through to network
      return fetch(request)
    } catch (e) {
      // On any error, fallback to network
      try {
        return await fetch(request)
      } catch (err) {
        // If even network fails, return a generic 502
        return new Response('ServiceWorker tunnel error', { status: 502 })
      }
    }
  })())
})

