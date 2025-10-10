import test from "ava"
import { spawn, ChildProcess } from "child_process"
import { WebSocket } from "ws"

let portCounter = 3002

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

test.serial("Node.js server: GET /uptime returns uptime data", async (t) => {
  const PORT = portCounter++
  let serverProcess: ChildProcess | null = null

  try {
    // Start the server
    serverProcess = spawn("npx", ["tsx", "server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: PORT.toString() },
      stdio: "ignore",
    })

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

test.serial("Node.js server: POST /increment increments counter", async (t) => {
  const PORT = portCounter++
  let serverProcess: ChildProcess | null = null

  try {
    // Start the server
    serverProcess = spawn("npx", ["tsx", "server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: PORT.toString() },
      stdio: "ignore",
    })

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

test.serial("Node.js server: WebSocket connection works", async (t) => {
  const PORT = portCounter++
  let serverProcess: ChildProcess | null = null

  try {
    // Start the server
    serverProcess = spawn("npx", ["tsx", "server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: PORT.toString() },
      stdio: "ignore",
    })

    // Wait for server to be ready
    await waitForServer(Number(PORT))

    // Connect to WebSocket (this connects to the RA control channel)
    const ws = new WebSocket(`ws://localhost:${PORT}/__ra__`)

    const connected = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WebSocket connection timeout")),
        5000,
      )

      ws.on("open", () => {
        clearTimeout(timeout)
        resolve(true)
      })

      ws.on("error", (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    t.true(connected)

    // Should receive server_kx message (CBOR encoded)
    const receivedMessage = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("No server message received")),
        5000,
      )

      ws.on("message", (data) => {
        clearTimeout(timeout)
        // Just verify we received some data from the server

        if (data instanceof ArrayBuffer) {
          t.true(data.byteLength > 0)
        } else {
          // For other RawData types (Buffer, string, Buffer[]),
          // assume the 'length' property is the intended way to check for content.
          t.true((data as any).length > 0)
        }
        resolve(true)
      })
    })

    t.true(receivedMessage)

    ws.close()
  } finally {
    if (serverProcess) {
      await killProcess(serverProcess)
    }
    // Wait a bit for cleanup
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})
