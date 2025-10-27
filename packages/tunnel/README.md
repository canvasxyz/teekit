## @teekit/tunnel

@teekit/tunnel is an encrypted channel that relays HTTP fetch requests
and WebSockets over an encrypted WebSocket.

It can be used to create browser-based applications that verify
connections terminate securely inside a Trusted Execution Environment
(TEE).

It uses @teekit/qvl for quote validation, and allows the user to specify
custom verification logic, TCB freshness validation, and custom
certificate revocation logs.

## Usage

Express:

```ts
const { wss, server } = await TunnelServer.initialize(app, async (x25519PublicKey) => {
  // Return a quote bound to x25519PublicKey
  return myQuote
})

wss.on("connection", (ws: WebSocket) => {
  // Handle incoming messages
  ws.on("message", (data: Uint8Array) => { ... })

  // Send an initial message
  ws.send(...)

  // Handle disconnects
  ws.on("close", () => { ... })
})

// Call server.listen() on the returned server to bind to a port
server.listen(process.env.PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
```

Hono:

 ```ts
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/ws'

const app = new Hono()
app.get('/', (c) => c.text("Hello world!"))

const { wss } = await TunnelServer.initialize(
  app,
  async (x25519PublicKey) => {
    // return a quote bound to x25519PublicKey
    return myQuote
  },
  { upgradeWebSocket },
)

wss.on("connection", (ws) => {
  ws.on("message", (data) => ws.send(data))
})

export default app
```

See the
[tests](https://github.com/canvasxyz/teekit/tree/main/packages/tunnel/test)
for more examples.

For more information, see the [workspace
readme](https://github.com/canvasxyz/teekit) in Github.

## License

MIT (C) 2025
