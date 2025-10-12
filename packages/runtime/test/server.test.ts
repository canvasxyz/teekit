import test from "ava"
import { spawn, ChildProcess } from "child_process"
import { WebSocket } from "ws"

let portCounter = 3030

async function waitForServer(port: number, timeout = 10000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`http://localhost:${port}/uptime`)
      if (response.ok) {
        return
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Server did not start within ${timeout}ms`)
}

function killProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc.pid) {
      resolve()
      return
    }

    // Kill immediately
    proc.kill("SIGKILL")

    // Resolve after a short delay
    setTimeout(() => resolve(), 500)
  })
}

test.serial("Workerd server: GET /uptime returns uptime data", async (t) => {
  const PORT = portCounter++
  let serverProcess: ChildProcess | null = null

  try {
    serverProcess = spawn(
      "npx",
      [
        "workerd",
        "serve",
        "workerd.config.base.capnp",
        "--socket-addr",
        `http=0.0.0.0:${PORT}`,
      ],
      {
        cwd: process.cwd(),
        stdio: "inherit",
      },
    )

    // Wait for server to be ready
    await waitForServer(Number(PORT))

    // Test the /uptime endpoint
    const response = await fetch(`http://localhost:${PORT}/uptime`)
    t.is(response.status, 200)

    const data = await response.json()
    t.truthy(data.uptime)
    t.truthy(data.uptime.formatted)
    t.regex(data.uptime.formatted, /\d+m \d+/)
  } finally {
    if (serverProcess) {
      await killProcess(serverProcess)
    }
    // Wait a bit for cleanup
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})

test.serial("Workerd server: POST /increment increments counter", async (t) => {
  const PORT = portCounter++
  let serverProcess: ChildProcess | null = null

  try {
    serverProcess = spawn(
      "npx",
      [
        "workerd",
        "serve",
        "workerd.config.base.capnp",
        "--socket-addr",
        `http=0.0.0.0:${PORT}`,
      ],
      {
        cwd: process.cwd(),
        stdio: "inherit",
      },
    )

    // Wait for server to be ready
    await waitForServer(Number(PORT))

    // Test the /increment endpoint
    const response1 = await fetch(`http://localhost:${PORT}/increment`, {
      method: "POST",
    })
    t.is(response1.status, 200)

    const data1 = await response1.json()
    const counter1 = data1.counter
    t.true(typeof counter1 === "number")
    t.true(counter1 > 0)

    // Increment again - should increase by 1
    const response2 = await fetch(`http://localhost:${PORT}/increment`, {
      method: "POST",
    })
    const data2 = await response2.json()
    t.is(data2.counter, counter1 + 1)
  } finally {
    if (serverProcess) {
      await killProcess(serverProcess)
    }
    // Wait a bit for cleanup
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})

test.serial("Workerd server: POST /quote returns quote data", async (t) => {
  const PORT = portCounter++
  let serverProcess: ChildProcess | null = null

  try {
    serverProcess = spawn(
      "npx",
      [
        "workerd",
        "serve",
        "workerd.config.base.capnp",
        "--socket-addr",
        `http=0.0.0.0:${PORT}`,
      ],
      {
        cwd: process.cwd(),
        stdio: "inherit",
      },
    )

    // Wait for server to be ready
    await waitForServer(Number(PORT))

    // Create a test public key (32 bytes for x25519)
    const testPublicKey = new Array(32).fill(0).map((_, i) => i)

    // Test the /quote endpoint
    const response = await fetch(`http://localhost:${PORT}/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ publicKey: testPublicKey }),
    })
    t.is(response.status, 200)

    const data = await response.json()

    // Verify quote data structure
    t.truthy(data.quote, "quote should be present")
    t.true(Array.isArray(data.quote), "quote should be an array")
    t.true(data.quote.length > 0, "quote should not be empty")

    // Since config.json doesn't exist, we expect the sample quote
    // The sample quote should always be returned in test environments
    t.true(data.quote.length > 100, "quote should be substantial in size")
  } finally {
    if (serverProcess) {
      await killProcess(serverProcess)
    }
    // Wait a bit for cleanup
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})

// TODO: WebSocket test commented out until TunnelServer integration is complete
// test.serial("Workerd server: WebSocket connection works", async (t) => {
//   const PORT = portCounter++
//   let serverProcess: ChildProcess | null = null
//
//   try {
//     serverProcess = spawn("npx", ["workerd", "serve", "workerd.config.capnp"], {
//       cwd: process.cwd(),
//       env: { ...process.env, PORT: PORT.toString() },
//       stdio: "ignore",
//     })
//
//     // Wait for server to be ready
//     await waitForServer(Number(PORT))
//
//     // Connect to WebSocket (this connects to the RA control channel)
//     const ws = new WebSocket(`ws://localhost:${PORT}/__ra__`)
//
//     const connected = await new Promise<boolean>((resolve, reject) => {
//       const timeout = setTimeout(
//         () => reject(new Error("WebSocket connection timeout")),
//         5000,
//       )
//
//       ws.on("open", () => {
//         clearTimeout(timeout)
//         resolve(true)
//       })
//
//       ws.on("error", (err) => {
//         clearTimeout(timeout)
//         reject(err)
//       })
//     })
//
//     t.true(connected)
//
//     // Should receive server_kx message (CBOR encoded)
//     const receivedMessage = await new Promise<boolean>((resolve, reject) => {
//       const timeout = setTimeout(
//         () => reject(new Error("No server message received")),
//         5000,
//       )
//
//       ws.on("message", (data) => {
//         clearTimeout(timeout)
//         // Just verify we received some data from the server
//
//         if (data instanceof ArrayBuffer) {
//           t.true(data.byteLength > 0)
//         } else {
//           // For other RawData types (Buffer, string, Buffer[]),
//           // assume the 'length' property is the intended way to check for content.
//           t.true((data as any).length > 0)
//         }
//         resolve(true)
//       })
//     })
//
//     t.true(receivedMessage)
//
//     ws.close()
//   } finally {
//     if (serverProcess) {
//       await killProcess(serverProcess)
//     }
//     // Wait a bit for cleanup
//     await new Promise((resolve) => setTimeout(resolve, 500))
//   }
// })
