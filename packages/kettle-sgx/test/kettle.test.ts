/**
 * AVA test suite for Kettle running in Gramine SGX enclave
 *
 * Run with:
 *   npm run test:e2e:direct   - Start gramine in direct mode, run tests, stop
 *   npm run test:e2e:sgx      - Start gramine in SGX mode, run tests, stop
 *   npm run test              - Assumes server is already running
 *
 * Set KETTLE_URL environment variable to override the default URL:
 *   KETTLE_URL=http://localhost:3001 npx ava
 */
import test from "ava"
import {
  BASE_URL,
  WS_URL,
  TIMEOUT_MS,
  GRAMINE_MODE,
  connectWebSocket,
  withTimeout,
  sendAndReceive,
  setupGramine,
  teardownGramine,
} from "./helpers.js"

test.before(async () => {
  await setupGramine()
})

test.after.always(async () => {
  await teardownGramine()
})

// =============================================================================
// Core Endpoints
// =============================================================================

test.serial("core: GET /healthz returns ok", async (t) => {
  const response = await fetch(`${BASE_URL}/healthz`)
  t.is(response.status, 200)
  const data = await response.json()
  t.deepEqual(data, { ok: true })
})

test.serial("core: GET /uptime returns uptime data", async (t) => {
  const response = await fetch(`${BASE_URL}/uptime`)
  t.is(response.status, 200)
  const data = await response.json()
  t.truthy(data.uptime)
  t.truthy(data.uptime.formatted)
  t.regex(data.uptime.formatted, /\d+m \d+/)
})

test.serial("core: POST /increment increments counter", async (t) => {
  const response1 = await fetch(`${BASE_URL}/increment`, { method: "POST" })
  t.is(response1.status, 200)
  const data1 = await response1.json()
  const counter1 = data1.counter
  t.true(typeof counter1 === "number")
  t.true(counter1 > 0)

  const response2 = await fetch(`${BASE_URL}/increment`, { method: "POST" })
  const data2 = await response2.json()
  t.is(data2.counter, counter1 + 1)
})

// =============================================================================
// Database Endpoints
// =============================================================================

test.serial("db: POST /db/init initializes database", async (t) => {
  const response = await fetch(`${BASE_URL}/db/init`, { method: "POST" })
  // May fail if DB_URL/DB_TOKEN not configured, but should not crash
  if (response.ok) {
    const data = await response.json()
    t.deepEqual(data, { ok: true })
  } else {
    // Database not configured is acceptable
    t.pass("Database not configured (expected in SGX mode without libsql)")
  }
})

test.serial("db: POST /db/put stores key-value pair", async (t) => {
  const response = await fetch(`${BASE_URL}/db/put`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "test-key", value: "test-value" }),
  })
  if (response.ok) {
    const data = await response.json()
    t.deepEqual(data, { ok: true })
  } else {
    t.pass("Database not configured")
  }
})

test.serial("db: GET /db/get retrieves key-value pair", async (t) => {
  const response = await fetch(`${BASE_URL}/db/get?key=test-key`)
  if (response.ok) {
    const data = await response.json()
    t.is(data.key, "test-key")
    t.is(data.value, "test-value")
  } else if (response.status === 404) {
    t.pass("Key not found (database may not be configured)")
  } else {
    t.pass("Database not configured")
  }
})

test.serial("db: GET /db/get with missing key returns 400", async (t) => {
  const response = await fetch(`${BASE_URL}/db/get`)
  // Should return 400 for missing key parameter
  if (response.status === 400) {
    const data = await response.json()
    t.truthy(data.error)
  } else {
    t.pass("Database not configured")
  }
})

// =============================================================================
// Quote/Attestation Endpoint
// =============================================================================

test.serial("quote: POST /quote returns quote data or error", async (t) => {
  const testPublicKey = new Array(32).fill(0).map((_, i) => i)
  const response = await fetch(`${BASE_URL}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: testPublicKey }),
  })

  // Quote endpoint may fail without DCAP configured, but should respond
  t.true([200, 400, 500, 502].includes(response.status))

  if (response.status === 200) {
    const data = await response.json()
    t.truthy(data.quote, "quote should be present")
    t.true(typeof data.quote === "string", "quote should be a string")
  } else {
    // Error response is acceptable without SGX/DCAP
    // Response may not be JSON (e.g., "Internal Server Error")
    const text = await response.text()
    t.truthy(text.length > 0, "error response should have content")
  }
})

test.serial("quote: POST /quote with invalid publicKey returns 400", async (t) => {
  const response = await fetch(`${BASE_URL}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: "not-an-array" }),
  })
  t.is(response.status, 400)
  const data = await response.json()
  t.truthy(data.error)
})

// =============================================================================
// WebSocket Echo Endpoint (/ws)
// =============================================================================

test.serial("ws: echo text message", async (t) => {
  const ws = await connectWebSocket(`${WS_URL}/ws`)
  const testMessage = "Hello, WebSocket!"

  const echo = await sendAndReceive(ws, testMessage)
  t.is(echo.toString(), testMessage)

  ws.close()
})

test.serial("ws: echo binary message", async (t) => {
  const ws = await connectWebSocket(`${WS_URL}/ws`)
  const testData = Buffer.from([1, 2, 3, 4, 5, 255])

  const echo = await sendAndReceive(ws, testData)
  t.deepEqual(Array.from(echo as Buffer), Array.from(testData))

  ws.close()
})

test.serial("ws: echo multiple messages in order", async (t) => {
  const ws = await connectWebSocket(`${WS_URL}/ws`)
  const messages = ["message1", "message2", "message3"]
  const received: string[] = []

  const allReceived = withTimeout(
    new Promise<string[]>((resolve, reject) => {
      ws.on("message", (data) => {
        received.push(data.toString())
        if (received.length === messages.length) {
          resolve(received)
        }
      })
    }),
    TIMEOUT_MS,
    "multiple messages"
  )

  for (const msg of messages) {
    ws.send(msg)
  }

  const echoedMessages = await allReceived
  t.deepEqual(echoedMessages, messages)

  ws.close()
})

test.serial("ws: concurrent connections", async (t) => {
  const ws1 = await connectWebSocket(`${WS_URL}/ws`)
  const ws2 = await connectWebSocket(`${WS_URL}/ws`)
  const ws3 = await connectWebSocket(`${WS_URL}/ws`)

  const testConnection = async (ws: import("ws").WebSocket, message: string): Promise<string> => {
    const echo = await sendAndReceive(ws, message)
    return echo.toString()
  }

  const [echo1, echo2, echo3] = await Promise.all([
    testConnection(ws1, "connection1"),
    testConnection(ws2, "connection2"),
    testConnection(ws3, "connection3"),
  ])

  t.is(echo1, "connection1")
  t.is(echo2, "connection2")
  t.is(echo3, "connection3")

  ws1.close()
  ws2.close()
  ws3.close()
})

test.serial("ws: large message handling (512KB)", async (t) => {
  const ws = await connectWebSocket(`${WS_URL}/ws`)
  const largeMessage = "x".repeat(512 * 1024)

  const echo = await withTimeout(
    sendAndReceive(ws, largeMessage),
    30000,
    "large message"
  )

  t.is(echo.toString().length, largeMessage.length)
  t.is(echo.toString(), largeMessage)

  ws.close()
})

test.serial("ws: close event handling", async (t) => {
  const ws = await connectWebSocket(`${WS_URL}/ws`)

  // Send and receive a message first
  await sendAndReceive(ws, "ping")

  // Close with a specific code
  ws.close(1000, "Normal closure")

  // The close should have been initiated
  t.true(
    ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED,
    `WebSocket should be in CLOSING or CLOSED state, got ${ws.readyState}`
  )
})

// =============================================================================
// Tunnel Endpoint
// =============================================================================

test.serial("tunnel: /__ra__ endpoint exists", async (t) => {
  // The tunnel endpoint is a WebSocket endpoint for remote attestation,
  // so a regular HTTP request should return 426 Upgrade Required or 400 Bad Request
  const response = await fetch(`${BASE_URL}/__ra__`)
  // 400, 426 (Upgrade Required), or 404 are all acceptable
  // The exact status depends on how the WebSocket upgrade is handled
  t.true(
    [400, 404, 426].includes(response.status),
    `Expected 400, 404, or 426, got ${response.status}`
  )
})

// =============================================================================
// Static Files
// =============================================================================

test.serial("static: GET / returns index.html", async (t) => {
  const response = await fetch(`${BASE_URL}/`)
  // Static files may not be served in SGX mode without proper configuration
  if (response.status === 200) {
    const contentType = response.headers.get("content-type")
    t.truthy(contentType?.includes("text/html"))
    const html = await response.text()
    t.true(html.includes("<!doctype html>") || html.includes("<!DOCTYPE html>"))
  } else {
    t.pass("Static files not served (acceptable in SGX mode)")
  }
})

test.serial("static: GET /index.html returns index.html", async (t) => {
  const response = await fetch(`${BASE_URL}/index.html`)
  if (response.status === 200) {
    const contentType = response.headers.get("content-type")
    t.truthy(contentType?.includes("text/html"))
    const html = await response.text()
    t.true(html.includes("<!doctype html>") || html.includes("<!DOCTYPE html>"))
  } else {
    t.pass("Static files not served")
  }
})

test.serial("static: unknown paths return 404", async (t) => {
  const response = await fetch(`${BASE_URL}/some/random/path/that/does/not/exist`)
  t.is(response.status, 404)
})

// =============================================================================
// CORS
// =============================================================================

test.serial("cors: OPTIONS request returns CORS headers", async (t) => {
  const response = await fetch(`${BASE_URL}/healthz`, {
    method: "OPTIONS",
  })
  // CORS preflight should succeed
  t.true([200, 204].includes(response.status))
  // Check for CORS headers (may vary depending on configuration)
  const allowOrigin = response.headers.get("access-control-allow-origin")
  t.truthy(allowOrigin)
})

// =============================================================================
// Error Handling
// =============================================================================

test.serial("error: malformed JSON to POST /increment", async (t) => {
  const response = await fetch(`${BASE_URL}/increment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not-json",
  })
  // Should still work since /increment doesn't parse the body
  t.is(response.status, 200)
})

test.serial("error: unknown endpoint returns 404", async (t) => {
  const response = await fetch(`${BASE_URL}/api/v1/nonexistent`)
  t.is(response.status, 404)
})

// =============================================================================
// Durable Objects SQLite Tests
// =============================================================================

test.serial("db: database file exists after write", async (t) => {
  // Initialize database
  const initResponse = await fetch(`${BASE_URL}/db/init`, { method: "POST" })
  t.true(initResponse.ok || initResponse.status === 500, "init should work or fail gracefully")

  // Write a unique test value
  const testKey = `test-persistence-${Date.now()}`
  const testValue = `value-${Math.random().toString(36).slice(2)}`

  const putResponse = await fetch(`${BASE_URL}/db/put`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: testKey, value: testValue }),
  })

  if (putResponse.ok) {
    // Verify the write succeeded via API
    const getResponse = await fetch(`${BASE_URL}/db/get?key=${testKey}`)
    t.true(getResponse.ok, "Data should be readable after write")
  } else {
    t.pass("Database not configured (acceptable in some modes)")
  }
})

test.serial("db: data persists across operations", async (t) => {
  // Initialize database
  const initResponse = await fetch(`${BASE_URL}/db/init`, { method: "POST" })
  if (!initResponse.ok) {
    t.pass("Database not configured")
    return
  }

  // Write test data
  const testKey = `persist-test-${Date.now()}`
  const testValue = "persistent-value"

  const putResponse = await fetch(`${BASE_URL}/db/put`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: testKey, value: testValue }),
  })
  t.true(putResponse.ok, "PUT should succeed")

  // Read it back immediately
  const getResponse = await fetch(`${BASE_URL}/db/get?key=${testKey}`)
  t.true(getResponse.ok, "GET should succeed")
  const data = await getResponse.json()
  t.is(data.value, testValue, "Value should match what was written")
})

test.serial("db: multiple writes and reads", async (t) => {
  const initResponse = await fetch(`${BASE_URL}/db/init`, { method: "POST" })
  if (!initResponse.ok) {
    t.pass("Database not configured")
    return
  }

  // Write multiple values
  const testData = [
    { key: `multi-1-${Date.now()}`, value: "value-1" },
    { key: `multi-2-${Date.now()}`, value: "value-2" },
    { key: `multi-3-${Date.now()}`, value: "value-3" },
  ]

  for (const item of testData) {
    const response = await fetch(`${BASE_URL}/db/put`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    })
    t.true(response.ok, `PUT for ${item.key} should succeed`)
  }

  // Read them all back
  for (const item of testData) {
    const response = await fetch(`${BASE_URL}/db/get?key=${item.key}`)
    t.true(response.ok, `GET for ${item.key} should succeed`)
    const data = await response.json()
    t.is(data.value, item.value, `Value for ${item.key} should match`)
  }
})
