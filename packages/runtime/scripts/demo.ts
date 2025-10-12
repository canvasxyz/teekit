import { spawn } from "child_process"
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import net from "net"

function randomToken(len = 48): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Buffer.from(bytes).toString("base64url")
}

async function findFreePortNear(basePort: number): Promise<number> {
  const tried = new Set<number>()
  const maxAttempts = 50
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = basePort + Math.floor(Math.random() * 1000)
    if (tried.has(candidate)) continue
    tried.add(candidate)
    const isFree = await new Promise<boolean>((resolve) => {
      const server = net.createServer()
      server.once("error", () => resolve(false))
      server.once("listening", () => {
        server.close(() => resolve(true))
      })
      server.listen(candidate, "127.0.0.1")
    })
    if (isFree) return candidate
  }
  // Fallback: ask OS for an ephemeral port and return it
  const free = await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address === "object") {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error("Could not determine free port")))
      }
    })
  })
  return free
}

async function waitForPortOpen(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.end()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
      setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, 300)
    })
    if (connected) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Port ${port} did not open in ${timeoutMs}ms`)
}

function resolveSqldBinary(): string {
  const candidates = [
    process.env.SQLD_BIN,
    "sqld",
    "/home/linuxbrew/.linuxbrew/bin/sqld",
    "/opt/homebrew/bin/sqld",
    "/usr/local/bin/sqld",
    "/usr/bin/sqld",
  ].filter(Boolean) as string[]
  for (const bin of candidates) {
    try {
      if (existsSync(bin)) return bin
    } catch {}
  }
  return candidates[0]!
}

async function main() {
  const baseDir = process.env.RUNTIME_DB_DIR
    ? process.env.RUNTIME_DB_DIR
    : mkdtempSync(join(tmpdir(), "teekit-runtime-"))
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })

  const dbPath = join(baseDir, "app.sqlite")
  const dbToken = randomToken()

  const sqldPort = await findFreePortNear(8088)
  // Always pick our own free port; ignore ambient PORT to avoid collisions in CI
  const workerPort = await findFreePortNear(3001)

  const dbUrl = `http://127.0.0.1:${sqldPort}`

  // Start sqld (expects sqld to be available on PATH)
  const sqldArgs = [
    "--http-listen-addr",
    `127.0.0.1:${sqldPort}`,
    "--db-path",
    dbPath,
  ]
  const sqldBin = resolveSqldBinary()
  const sqld = spawn(sqldBin, sqldArgs, { stdio: "inherit" })

  sqld.on("exit", (code) => {
    console.error(`[sqld] exited with code ${code}`)
  })

  // Wait for sqld to be reachable before starting workerd
  try {
    await waitForPortOpen(sqldPort, 15000)
  } catch (err) {
    console.error(`[sqld] failed to open port ${sqldPort}:`, err)
    throw err
  }

  // Generate a complete workerd config with injected DB bindings
  const cwd = process.cwd()
  const serverJs = "dist/server.js"
  const quoteJs = "dist/bindings/quote.js"
  const tmpConfigPath = join(cwd, "workerd.config.tmp.capnp")
  const configText = `# Workerd configuration for teekit runtime

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = "main",
      worker = (
        modules = [
          (
            name = "server.js",
            esModule = embed "${serverJs}"
          ),
          (
            name = "quote",
            esModule = embed "${quoteJs}"
          ),
        ],
        compatibilityDate = "2024-01-01",
        compatibilityFlags = ["nodejs_compat"],

        bindings = [
          (
            name = "DB_URL",
            text = "${dbUrl}"
          ),
          (
            name = "DB_TOKEN",
            text = "${dbToken}"
          ),
          (
            name = "DB_HTTP",
            service = "sqld"
          ),
        ],
      )
    ),
    (
      name = "sqld",
      external = (
        address = "127.0.0.1:${sqldPort}"
      )
    ),
  ],

  sockets = [
    (
      name = "http",
      address = "*:3001",
      http = (),
      service = "main"
    ),
  ]
);
`
  writeFileSync(tmpConfigPath, configText, "utf-8")

  // Start workerd
  const workerd = spawn(
    "npx",
    [
      "workerd",
      "serve",
      tmpConfigPath,
      "--socket-addr",
      `http=0.0.0.0:${workerPort}`,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  )

  console.log(`WORKERD_PORT=${workerPort}`)
  console.log(`DB_URL=${dbUrl}`)
  console.log(`DB_TOKEN=${dbToken}`)

  const shutdown = () => {
    try {
      workerd.kill("SIGKILL")
    } catch {}
    try {
      sqld.kill("SIGKILL")
    } catch {}
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
