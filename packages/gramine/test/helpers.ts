import { WebSocket } from "ws"
import { spawn, ChildProcess } from "child_process"
import { fileURLToPath } from "url"
import { dirname, resolve } from "path"
import { existsSync, readFileSync } from "fs"

export const BASE_URL = process.env.KETTLE_URL || "http://localhost:3001"
export const WS_URL = BASE_URL.replace(/^http/, "ws")
export const TIMEOUT_MS = 10000

// Gramine mode: "sgx" | "direct" | "none" (skip starting)
export const GRAMINE_MODE = process.env.GRAMINE_MODE || "none"

// Get package directory (where Makefile is)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
export const PACKAGE_DIR = resolve(__dirname, "..")

// Track spawned processes and their state
let gramineProcess: ChildProcess | null = null
let gramineExitCode: number | null = null
let gramineExitSignal: string | null = null
let gramineStderr: string[] = []

/**
 * Check if the gramine process exited early (before server was ready)
 * Returns an error message if it did, null otherwise
 */
function checkGramineEarlyExit(): string | null {
  if (gramineExitCode !== null || gramineExitSignal !== null) {
    const exitInfo = gramineExitCode !== null
      ? `exit code ${gramineExitCode}`
      : `signal ${gramineExitSignal}`

    // Check for MRENCLAVE mismatch in stderr
    const stderrText = gramineStderr.join("\n")
    if (stderrText.includes("MRENCLAVE mismatch")) {
      return `Gramine process failed (${exitInfo}): MRENCLAVE mismatch detected.\n` +
        `The enclave was rebuilt with a different measurement.\n` +
        `To fix: rm -rf /var/lib/kettle/do-storage/*\n\n` +
        `Captured output:\n${gramineStderr.slice(-20).join("\n")}`
    }

    return `Gramine process exited early (${exitInfo}).\n` +
      `Captured output:\n${gramineStderr.slice(-20).join("\n")}`
  }
  return null
}

export async function waitForServer(
  baseUrl: string = BASE_URL,
  maxAttempts: number = 60,
  intervalMs: number = 1000
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Check if gramine process exited early
    const earlyExitError = checkGramineEarlyExit()
    if (earlyExitError) {
      throw new Error(earlyExitError)
    }

    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(2000),
      })
      if (response.ok) {
        return
      }
    } catch {
      // Server not ready yet
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw new Error(`Server at ${baseUrl} did not become ready within ${maxAttempts}s`)
}

export async function connectWebSocket(
  url: string,
  timeoutMs: number = TIMEOUT_MS
): Promise<WebSocket> {
  const ws = new WebSocket(url, { perMessageDeflate: false })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.terminate()
      reject(new Error("WebSocket connection timeout"))
    }, timeoutMs)

    ws.on("open", () => {
      clearTimeout(timeout)
      resolve()
    })

    ws.on("error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })

  return ws
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId)) as Promise<T>
}

export async function sendAndReceive(
  ws: WebSocket,
  message: string | Buffer,
  timeoutMs: number = TIMEOUT_MS
): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("No echo received"))
    }, timeoutMs)

    ws.once("message", (data) => {
      clearTimeout(timeout)
      resolve(data as string | Buffer)
    })

    ws.send(message)
  })
}

/**
 * Check if a server is already running at the given URL
 */
export async function isServerRunning(baseUrl: string = BASE_URL): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/healthz`, {
      signal: AbortSignal.timeout(2000),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Start gramine in the specified mode (sgx or direct)
 * Returns true if we started the process, false if server was already running
 */
export async function startGramine(mode: "sgx" | "direct"): Promise<boolean> {
  // Check for preexisting instance
  if (await isServerRunning()) {
    console.log(`[gramine] Server already running at ${BASE_URL}, skipping spawn`)
    return false
  }

  // Reset state tracking
  gramineExitCode = null
  gramineExitSignal = null
  gramineStderr = []

  const target = mode === "sgx" ? "sgx-run" : "direct-run"

  // Use detached: true to create a new process group, so we can kill the entire tree
  gramineProcess = spawn("make", [target], {
    cwd: PACKAGE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })

  // Log output for debugging and capture stderr for error detection
  gramineProcess.stdout?.on("data", (data) => {
    const lines = data.toString().trim().split("\n")
    for (const line of lines) {
      console.log(`[gramine:stdout] ${line}`)
      // Also capture stdout as some errors may go there (make output)
      gramineStderr.push(line)
    }
  })

  gramineProcess.stderr?.on("data", (data) => {
    const lines = data.toString().trim().split("\n")
    for (const line of lines) {
      console.log(`[gramine:stderr] ${line}`)
      gramineStderr.push(line)
    }
  })

  gramineProcess.on("error", (err) => {
    console.error(`[gramine] Process error: ${err.message}`)
    gramineStderr.push(`Process error: ${err.message}`)
  })

  gramineProcess.on("exit", (code, signal) => {
    console.log(`[gramine] Process exited with code ${code}, signal ${signal}`)
    gramineExitCode = code
    gramineExitSignal = signal
    gramineProcess = null
  })

  return true
}

/**
 * Stop the gramine process if we started it
 */
export async function stopGramine(): Promise<void> {
  // Reset state tracking
  gramineExitCode = null
  gramineExitSignal = null
  gramineStderr = []

  if (!gramineProcess) {
    console.log("[gramine] No process to stop")
    return
  }

  const pid = gramineProcess.pid
  console.log(`[gramine] Stopping gramine process group (PID: ${pid})...`)

  return new Promise((resolve) => {
    if (!gramineProcess || !pid) {
      resolve()
      return
    }

    // Set a timeout for force kill
    const forceKillTimeout = setTimeout(() => {
      console.log("[gramine] Force killing process group...")
      try {
        // Kill the entire process group with SIGKILL
        process.kill(-pid, "SIGKILL")
      } catch {
        // Process may already be dead
      }
      gramineProcess = null
      resolve()
    }, 5000)

    // Set up exit handler
    gramineProcess.once("exit", () => {
      clearTimeout(forceKillTimeout)
      console.log("[gramine] Process stopped")
      gramineProcess = null
      resolve()
    })

    // Kill the entire process group with SIGTERM first
    try {
      process.kill(-pid, "SIGTERM")
    } catch (err) {
      clearTimeout(forceKillTimeout)
      console.log(`[gramine] Error killing process group: ${err}`)
      gramineProcess = null
      resolve()
    }
  })
}

/**
 * Setup gramine for tests - starts gramine and waits for server to be ready
 */
export async function setupGramine(): Promise<void> {
  if (GRAMINE_MODE === "none") {
    console.log("[gramine] GRAMINE_MODE=none, expecting server to be already running")
    await waitForServer(BASE_URL, 60, 1000)
    return
  }

  if (GRAMINE_MODE !== "sgx" && GRAMINE_MODE !== "direct") {
    throw new Error(`Invalid GRAMINE_MODE: ${GRAMINE_MODE}. Must be "sgx", "direct", or "none"`)
  }

  // Start gramine (workerd with DO SQLite storage)
  await startGramine(GRAMINE_MODE)
  await waitForServer(BASE_URL, 60, 1000)
}

/**
 * Teardown gramine after tests - stops gramine
 */
export async function teardownGramine(): Promise<void> {
  await stopGramine()
}

/**
 * Check if database file is encrypted (for verification)
 */
export function isDatabaseEncrypted(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false
  try {
    const header = readFileSync(dbPath).subarray(0, 16)
    // SQLite databases start with "SQLite format 3\0"
    // Encrypted databases will have random bytes instead
    const sqliteHeader = "SQLite format 3"
    const headerStr = header.toString("ascii")
    return !headerStr.startsWith(sqliteHeader)
  } catch {
    return false
  }
}
