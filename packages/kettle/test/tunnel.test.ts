import test from "ava"
import { WorkerResult } from "../server/startWorker.js"
import { TunnelClient } from "@teekit/tunnel"
import { startKettleWithTunnel, stopKettleWithTunnel } from "./helpers.js"

let shared: {
  kettle: WorkerResult
  tunnelClient: TunnelClient
  origin: string
} | null = null

test.before(async () => {
  shared = await startKettleWithTunnel()
})

test.after.always(async () => {
  if (shared) {
    const { kettle, tunnelClient } = shared
    shared = null
    await stopKettleWithTunnel(kettle, tunnelClient)
  }
})

test.serial("tunnel: GET /uptime", async (t) => {
  if (!shared) t.fail("shared tunnel not initialized")
  const { tunnelClient } = shared!

  // Test the /uptime endpoint through the tunnel
  const response = await tunnelClient.fetch("/uptime")
  t.is(response.status, 200)

  const data = await response.json()
  t.truthy(data.uptime)
  t.truthy(data.uptime.formatted)
  t.regex(data.uptime.formatted, /\d+m \d+/)
})

test.serial("tunnel: POST /increment", async (t) => {
  if (!shared) t.fail("shared tunnel not initialized")
  const { tunnelClient } = shared!

  // Test the /increment endpoint through the tunnel
  const response1 = await tunnelClient.fetch("/increment", {
    method: "POST",
  })
  t.is(response1.status, 200)

  const data1 = await response1.json()
  const counter1 = data1.counter
  t.true(typeof counter1 === "number")
  t.true(counter1 > 0)

  // Increment again - should increase by 1
  const response2 = await tunnelClient.fetch("/increment", {
    method: "POST",
  })
  const data2 = await response2.json()
  t.is(data2.counter, counter1 + 1)
})

test.serial("tunnel: WebSocket echo", async (t) => {
  if (!shared) t.fail("shared tunnel not initialized")
  const { tunnelClient, origin } = shared!

  const wsUrl = new URL(origin)
  wsUrl.protocol = wsUrl.protocol.replace(/^http/, "ws")
  wsUrl.pathname = "/"
  const ws = new tunnelClient.WebSocket(wsUrl.toString())

  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve()
  })
  t.is(ws.readyState, WebSocket.OPEN)

  // Send a string; this will fail JSON parsing and be echoed
  const message1 = "hello world"
  const { promise, resolve } = Promise.withResolvers()
  ws.onmessage = (event) => {
    resolve(event.data)
  }
  ws.send(message1)
  const result = await promise

  t.deepEqual(result, message1)
  ws.close()
})

test.serial("tunnel: WebSocket chat messages", async (t) => {
  if (!shared) t.fail("shared tunnel not initialized")
  const { tunnelClient, origin } = shared!

  const tunnelClient2 = await TunnelClient.initialize(origin, {
    customVerifyQuote: () => true,
    customVerifyX25519Binding: () => true,
  })
  t.teardown(() => {
    tunnelClient2.close()
  })

  // Connect to WebSocket through the tunnel
  const wsUrl = new URL(origin)
  wsUrl.protocol = wsUrl.protocol.replace(/^http/, "ws")
  wsUrl.pathname = "/"
  const ws1 = new tunnelClient.WebSocket(wsUrl.toString())
  const ws2 = new tunnelClient2.WebSocket(wsUrl.toString())

  await Promise.all([
    new Promise<void>((resolve) => {
      ws1.onopen = () => resolve()
    }),
    new Promise<void>((resolve) => {
      ws2.onopen = () => resolve()
    }),
  ])

  // Verify connection is established
  t.is(ws1.readyState, WebSocket.OPEN)
  t.is(ws2.readyState, WebSocket.OPEN)

  // Send messages from ws1, receive on both ws1/ws2
  const message1 = { type: "chat", username: "id1", text: "meow" }
  const { promise: promise1, resolve: resolveWs1 } = Promise.withResolvers()
  const { promise: promise2, resolve: resolveWs2 } = Promise.withResolvers()

  ws1.onmessage = (event) => resolveWs1(event.data)
  ws2.onmessage = (event) => resolveWs2(event.data)
  ws1.send(JSON.stringify(message1))

  const result1 = JSON.parse((await promise1) as any)
  const result2 = JSON.parse((await promise2) as any)

  // Broadcasted message contains some extra data, only check the original fields
  t.is(result1.type, "message")
  t.is(result1.message.username, message1.username)
  t.is(result1.message.text, message1.text)
  t.is(result2.type, "message")
  t.is(result2.message.username, message1.username)
  t.is(result2.message.text, message1.text)
  ws1.close()
  ws2.close()
})
