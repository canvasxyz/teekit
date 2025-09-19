import test from "ava"

// Ensure we can import tunnel client and server modules
import * as TunnelClient from "../tunnel/client.ts"
import * as TunnelServer from "../tunnel/server.ts"

test("tunnel modules import", (t) => {
  t.truthy(TunnelClient)
  t.truthy(TunnelServer)
})
