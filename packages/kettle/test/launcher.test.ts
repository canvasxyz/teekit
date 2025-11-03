import test from "ava"
import {
  mkdtempSync,
  copyFileSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn, ChildProcess } from "child_process"
import { fileURLToPath } from "url"
import { createHash } from "crypto"
import { connectWebSocket } from "./helpers.js"
import {
  findFreePort,
  waitForPortOpen,
  waitForPortClosed,
} from "../server/utils.js"

interface LauncherProcess {
  process: ChildProcess
  port: number
  stop: () => Promise<void>
}

async function startLauncher(
  manifestPath: string,
  port: number,
): Promise<LauncherProcess> {
  const kettleDir = fileURLToPath(new URL("..", import.meta.url))
  const launcherPath = join(kettleDir, "server", "launcher.ts")

  return new Promise((resolve, reject) => {
    const proc = spawn(
      "tsx",
      [launcherPath, "--manifest", manifestPath, "--port", port.toString()],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: kettleDir,
      },
    )

    let stdout = ""
    let stderr = ""
    let resolved = false

    const timeout = setTimeout(() => {
      if (!resolved) {
        proc.kill()
        reject(
          new Error(
            `Launcher failed to start within timeout. stdout: ${stdout}, stderr: ${stderr}`,
          ),
        )
      }
    }, 60000) // 60 second timeout for startup

    proc.stdout.on("data", (data) => {
      const str = data.toString()
      stdout += str
      // Look for the success message
      if (
        str.includes("Worker running at") ||
        str.includes("Server listening on")
      ) {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          resolve({
            process: proc,
            port,
            stop: async () => {
              proc.kill("SIGTERM")
              // Wait for process to exit
              await new Promise<void>((resolve) => {
                const exitTimeout = setTimeout(() => {
                  proc.kill("SIGKILL")
                  resolve()
                }, 5000)
                proc.once("exit", () => {
                  clearTimeout(exitTimeout)
                  resolve()
                })
              })
            },
          })
        }
      }
    })

    proc.stderr.on("data", (data) => {
      stderr += data.toString()
    })

    proc.on("error", (err) => {
      if (!resolved) {
        clearTimeout(timeout)
        reject(err)
      }
    })

    proc.on("exit", (code) => {
      if (!resolved && code !== 0) {
        clearTimeout(timeout)
        reject(
          new Error(
            `Launcher exited with code ${code}. stdout: ${stdout}, stderr: ${stderr}`,
          ),
        )
      }
    })
  })
}

let launcher: LauncherProcess | null = null
let testPort: number

test.before(async (t) => {
  // Create temp directory for test
  const tempDir = mkdtempSync(join(tmpdir(), "kettle-launcher-test-"))

  // Copy app.ts and its dependencies to temp directory
  const kettleDir = fileURLToPath(new URL("..", import.meta.url))

  // Files to copy: app.ts and its local dependencies
  const filesToCopy = ["app.ts", "types.ts"]

  for (const file of filesToCopy) {
    const sourcePath = join(kettleDir, file)
    const targetPath = join(tempDir, file)

    if (!existsSync(sourcePath)) {
      t.fail(`Source ${file} not found at ${sourcePath}`)
      return
    }

    copyFileSync(sourcePath, targetPath)
  }

  const targetAppPath = join(tempDir, "app.ts")

  // Calculate SHA256 hash of the app file
  const appFileContent = readFileSync(targetAppPath)
  const sha256Hash = createHash("sha256").update(appFileContent).digest("hex")

  // Generate manifest file
  const manifestPath = join(tempDir, "manifest.json")
  const manifest = {
    app: `file://${targetAppPath}`,
    sha256: sha256Hash,
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")

  // Find a free port
  testPort = await findFreePort()

  // Start launcher
  launcher = await startLauncher(manifestPath, testPort)

  // Wait for port to be open and give it time to fully initialize
  await waitForPortOpen(testPort, 30000)
  await new Promise((r) => setTimeout(r, 2000))
})

test.after.always(async () => {
  if (launcher) {
    await launcher.stop()
    launcher = null
    // Wait for port to close
    try {
      await waitForPortClosed(testPort, 5000)
    } catch {
      // Port didn't close cleanly, continue anyway
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

test.serial("launcher: GET /uptime returns uptime data", async (t) => {
  if (!launcher) {
    t.fail("launcher not initialized")
    return
  }

  const response = await fetch(`http://localhost:${testPort}/uptime`)
  t.is(response.status, 200)
  const data = await response.json()
  t.truthy(data.uptime)
  t.truthy(data.uptime.formatted)
  t.regex(data.uptime.formatted, /\d+m \d+/)
})

test.serial("launcher: POST /increment increments counter", async (t) => {
  if (!launcher) {
    t.fail("launcher not initialized")
    return
  }

  const response1 = await fetch(`http://localhost:${testPort}/increment`, {
    method: "POST",
  })
  t.is(response1.status, 200)
  const data1 = await response1.json()
  const counter1 = data1.counter
  t.true(typeof counter1 === "number")
  t.true(counter1 > 0)

  const response2 = await fetch(`http://localhost:${testPort}/increment`, {
    method: "POST",
  })
  const data2 = await response2.json()
  t.is(data2.counter, counter1 + 1)
})

test.serial("launcher: POST /quote returns quote data", async (t) => {
  if (!launcher) {
    t.fail("launcher not initialized")
    return
  }

  const testPublicKey = new Array(32).fill(0).map((_, i) => i)
  const response = await fetch(`http://localhost:${testPort}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: testPublicKey }),
  })
  t.is(response.status, 200)
  const data = await response.json()
  t.truthy(data.quote, "quote should be present")
  t.true(typeof data.quote === "string", "quote should be a string")
  t.true(data.quote.length > 100, "quote should be substantial in size")
})

test.serial("launcher: websocket echo works", async (t) => {
  if (!launcher) {
    t.fail("launcher not initialized")
    return
  }

  const ws = await connectWebSocket(`ws://localhost:${testPort}/ws`)

  const testMessage = "Hello from launcher test!"
  const echoReceived = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("No echo received")),
      5000,
    )

    ws.on("message", (data) => {
      clearTimeout(timeout)
      resolve(data.toString())
    })

    ws.send(testMessage)
  })

  t.is(echoReceived, testMessage, "Server should echo the message back")
  ws.close()
})

test.serial("launcher: websocket binary echo works", async (t) => {
  if (!launcher) {
    t.fail("launcher not initialized")
    return
  }

  const ws = await connectWebSocket(`ws://localhost:${testPort}/ws`)

  // Send binary data
  const testData = Buffer.from([1, 2, 3, 4, 5, 255])
  const echoReceived = await new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("No echo received")),
      5000,
    )

    ws.on("message", (data) => {
      clearTimeout(timeout)
      resolve(data as Buffer)
    })

    ws.send(testData)
  })

  t.deepEqual(
    Array.from(echoReceived),
    Array.from(testData),
    "Server should echo binary data correctly",
  )
  ws.close()
})

test.serial("launcher: healthz endpoint works", async (t) => {
  if (!launcher) {
    t.fail("launcher not initialized")
    return
  }

  const response = await fetch(`http://localhost:${testPort}/healthz`)
  t.is(response.status, 200)
  const data = await response.json()
  t.truthy(data.ok)
  t.is(data.ok, true)
})

test.serial("launcher: database operations work", async (t) => {
  if (!launcher) {
    t.fail("launcher not initialized")
    return
  }

  // Initialize database
  const initResponse = await fetch(`http://localhost:${testPort}/db/init`, {
    method: "POST",
  })
  t.is(initResponse.status, 200)

  // Put a value
  const putResponse = await fetch(`http://localhost:${testPort}/db/put`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "test-key", value: "test-value" }),
  })
  t.is(putResponse.status, 200)

  // Get the value
  const getResponse = await fetch(
    `http://localhost:${testPort}/db/get?key=test-key`,
  )
  t.is(getResponse.status, 200)
  const getData = await getResponse.json()
  t.is(getData.key, "test-key")
  t.is(getData.value, "test-value")
})

test.serial("launcher: static files endpoint exists", async (t) => {
  if (!launcher) {
    t.fail("launcher not initialized")
    return
  }

  // The static files may return 404 if not built, but the endpoint should exist
  // and not return a 500 error
  const response = await fetch(`http://localhost:${testPort}/`)
  // Accept either 200 (if static files are present) or 404 (if not built)
  t.true(response.status === 200 || response.status === 404)
})

test.serial("launcher: tunnel websocket endpoint exists", async (t) => {
  if (!launcher) {
    t.fail("launcher not initialized")
    return
  }

  // Connect to the tunnel WebSocket endpoint (/__ra__ is the tunnel endpoint)
  // The tunnel endpoint should accept connections (full attestation flow tested elsewhere)
  const ws = await connectWebSocket(`ws://localhost:${testPort}/__ra__`)

  // Just verify we can connect - the full attestation handshake is complex
  // and tested in the tunnel package tests
  t.is(ws.readyState, ws.OPEN, "WebSocket should be in OPEN state")

  ws.close()
})

test("launcher: fails when SHA256 hash does not match", async (t) => {
  // Create temp directory for test
  const tempDir = mkdtempSync(join(tmpdir(), "kettle-launcher-hash-test-"))

  // Copy app.ts to temp directory
  const kettleDir = fileURLToPath(new URL("..", import.meta.url))
  const sourceAppPath = join(kettleDir, "app.ts")
  const targetAppPath = join(tempDir, "app.ts")
  copyFileSync(sourceAppPath, targetAppPath)

  // Calculate actual SHA256 hash
  const appFileContent = readFileSync(targetAppPath)
  const actualHash = createHash("sha256").update(appFileContent).digest("hex")

  // Create manifest with incorrect hash
  const manifestPath = join(tempDir, "manifest.json")
  const wrongHash = "a" + actualHash.slice(1) // Change first character
  const manifest = {
    app: `file://${targetAppPath}`,
    sha256: wrongHash,
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")

  // Try to start launcher - should fail
  const kettleDir2 = fileURLToPath(new URL("..", import.meta.url))
  const launcherPath = join(kettleDir2, "server", "launcher.ts")
  const testPort = await findFreePort()

  const result = await new Promise<{ exitCode: number | null; stderr: string }>(
    (resolve) => {
      const proc = spawn(
        "tsx",
        [
          launcherPath,
          "--manifest",
          manifestPath,
          "--port",
          testPort.toString(),
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: kettleDir2,
        },
      )

      let stderr = ""

      proc.stderr.on("data", (data) => {
        stderr += data.toString()
      })

      proc.on("exit", (code) => {
        resolve({ exitCode: code, stderr })
      })

      // Set a timeout in case the process hangs
      setTimeout(() => {
        proc.kill()
        resolve({ exitCode: null, stderr })
      }, 10000)
    },
  )

  // Verify that the launcher failed
  t.truthy(
    result.exitCode !== 0,
    "Launcher should exit with non-zero code when hash doesn't match",
  )
  t.truthy(
    result.stderr.includes("SHA256 hash mismatch") ||
      result.stderr.includes("sha256") ||
      result.stderr.includes("hash"),
    "Error message should mention SHA256 hash mismatch",
  )
})
