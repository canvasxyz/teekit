import { server } from "./server.js"

const PORT = process.env.PORT || 3001

// For Hono apps, TunnelServer creates a plain HTTP server that doesn't route
// requests to the Hono app. We need to start the Node server separately to
// listen on the port. The WebSocket upgrade requests will be handled by the
// TunnelServer's HTTP server.
server.listen(PORT, () => {
  console.log(
    `[teekit-demo] WebSocket server running on http://localhost:${PORT}`,
  )
})
