import { spawn, ChildProcess } from "child_process"
import chalk from "chalk"
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import { pathToFileURL, fileURLToPath } from "url"
import {
  findFreePort,
  isSuppressedSqldLogs,
  randomToken,
  resolveSqldBinary,
  resolveWorkerdBinary,
  shutdown,
  waitForPortOpen,
} from "./utils.js"
import { startQuoteService } from "./startQuoteService.js"
import { buildKettleApp, buildKettleExternals } from "./buildWorker.js"

export interface WorkerConfig {
  dbPath: string
  workerPort: number
  sqldPort: number
  quoteServicePort: number
  replicaDbPath?: string
  encryptionKey?: string
  bundleDir: string
}

export interface WorkerResult {
  workerPort: number
  dbUrl: string
  dbToken: string
  workerd: ChildProcess
  sqld: ChildProcess
  replicaSqld: ChildProcess | null
  replicaDbPath: string | null
  replicaDbUrl: string | null
  quoteServiceUrl: string
  stop: () => Promise<any>
}

export async function startWorker(
  options: WorkerConfig,
): Promise<WorkerResult> {
  const {
    dbPath,
    sqldPort,
    workerPort,
    replicaDbPath,
    encryptionKey,
    quoteServicePort,
    bundleDir,
  } = options
  const dbToken = randomToken()
  const dbUrl = `http://127.0.0.1:${sqldPort}`
  const quoteServiceUrl = `http://127.0.0.1:${quoteServicePort}`

  const WORKER_JS = "worker.js"
  const APP_JS = "app.js"
  const EXTERNALS_JS = "externals.js"
  const STATIC_DIR = "static"

  // Check for existence of bundle components
  if (!existsSync(join(bundleDir, APP_JS))) throw new Error("missing app.js")
  if (!existsSync(join(bundleDir, WORKER_JS)))
    throw new Error("missing worker.js")
  if (!existsSync(join(bundleDir, EXTERNALS_JS)))
    throw new Error("missing externals.js")

  const staticDir = join(bundleDir, STATIC_DIR)
  if (!existsSync(staticDir)) {
    mkdirSync(staticDir, { recursive: true })
  }

  // Enable replication if replicaDbPath is provided
  const enableReplication = !!replicaDbPath
  const grpcPort = enableReplication ? await findFreePort() : undefined

  let replicaSqld: ChildProcess | null = null
  let replicaHttpPort: number | null = null

  // Start quote service first
  const quoteService = startQuoteService(quoteServicePort)
  await waitForPortOpen(quoteServicePort, 5000)

  console.log(
    chalk.yellowBright(
      `[kettle] Starting sqld on port ${sqldPort}, workerd on port ${workerPort}...`,
    ),
  )
  if (enableReplication) {
    replicaHttpPort = await findFreePort()
    console.log(
      chalk.yellowBright(
        `[kettle] Starting sqld replica on port ${replicaHttpPort}, gRPC on port ${grpcPort}...`,
      ),
    )
  }
  console.log(chalk.yellowBright(`[kettle] sqld path: ${dbPath}`))
  if (enableReplication) {
    console.log(
      chalk.yellowBright(`[kettle] replica sqld path: ${replicaDbPath}`),
    )
  }

  // Start main sqld
  const sqldArgs = [
    "--no-welcome",
    "--http-listen-addr",
    `127.0.0.1:${sqldPort}`,
    "--db-path",
    dbPath,
  ]

  // Enable at-rest encryption for the primary database if a key is provided
  if (encryptionKey) {
    sqldArgs.push("--encryption-key", encryptionKey)
  }

  // Add gRPC listener for replication
  if (enableReplication && grpcPort) {
    sqldArgs.push("--grpc-listen-addr", `127.0.0.1:${grpcPort}`)
  }

  const sqldBin = resolveSqldBinary()
  const sqld = spawn(sqldBin, sqldArgs, { stdio: ["ignore", "pipe", "pipe"] })
  // Do not keep the event loop alive because of child stdio
  // Note: optional chaining guards older Node typings
  ;(sqld.stdout as any)?.unref?.()
  ;(sqld.stderr as any)?.unref?.()

  sqld.stdout.on("data", (d) => {
    if (isSuppressedSqldLogs(String(d))) return
    console.log(chalk.greenBright(String(d).trim()))
  })
  sqld.stderr.on("data", (d) => {
    console.log(chalk.yellowBright(String(d).trim()))
  })

  // log if sqld exits early with an error
  sqld.on("exit", (code) => {
    if (code !== 0) console.error(`[sqld] exited with code ${code}`)
  })

  await waitForPortOpen(sqldPort, 15000)

  // Start replica sqld if enabled
  if (enableReplication && replicaHttpPort && grpcPort && replicaDbPath) {
    const replicaArgs = [
      "--no-welcome",
      "--http-listen-addr",
      `127.0.0.1:${replicaHttpPort}`,
      "--db-path",
      replicaDbPath,
      "--primary-grpc-url",
      `http://127.0.0.1:${grpcPort}`,
    ]

    // Enable at-rest encryption for the replica database if a key is provided
    if (encryptionKey) {
      replicaArgs.push("--encryption-key", encryptionKey)
    }

    replicaSqld = spawn(sqldBin, replicaArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    })
    ;(replicaSqld.stdout as any)?.unref?.()
    ;(replicaSqld.stderr as any)?.unref?.()

    replicaSqld.stdout?.on("data", (d) => {
      if (isSuppressedSqldLogs(String(d))) return
      console.log(chalk.blueBright(`[replica] ${String(d).trim()}`))
    })
    replicaSqld.stderr?.on("data", (d) => {
      console.log(chalk.magentaBright(`[replica] ${String(d).trim()}`))
    })

    // log if replica exits early with an error
    replicaSqld.on("exit", (code) => {
      if (code !== 0) console.error(`[replica sqld] exited with code ${code}`)
    })

    // Give replica additional time to connect and start syncing
    await waitForPortOpen(replicaHttpPort, 10000)
    await new Promise((r) => {
      const timer = setTimeout(r, 1000)
      timer.unref?.()
    })
  }

  const tmpConfigPath = join(bundleDir, "workerd.config.tmp.capnp")
  const configText = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = "main",
      worker = (
        modules = [
          (
            name = "worker.js",
            esModule = embed "${WORKER_JS}"
          ),
          (
            name = "app.js",
            esModule = embed "${APP_JS}"
          ),
          (
            name = "externals.js",
            esModule = embed "${EXTERNALS_JS}"
          ),
          # Map package imports to externals.js for transparent externalization
          (
            name = "hono",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "hono/cors",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "hono/ws",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "hono/cloudflare-workers",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "hono/utils/http-status",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@libsql/client",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@teekit/tunnel",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@teekit/tunnel/samples",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@teekit/qvl",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@teekit/qvl/utils",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "cbor-x",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@noble/ciphers",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@noble/ciphers/salsa",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@noble/hashes",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@noble/hashes/sha256",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@noble/hashes/sha512",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@noble/hashes/blake2b",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@noble/hashes/crypto",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@noble/hashes/sha1",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@noble/hashes/sha2",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@noble/hashes/utils",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@noble/curves",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@noble/curves/ed25519",
            esModule = embed "${EXTERNALS_JS}"
          ),
          (
            name = "@scure/base",
            esModule = embed "${EXTERNALS_JS}"
          ),
        ],
        compatibilityDate = "2024-04-03",
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
          (
            name = "HONO_DO",
            durableObjectNamespace = "HonoDurableObject"
          ),
          (
            name = "QUOTE_SERVICE_URL",
            text = "${quoteServiceUrl}"
          ),
          (
            name = "QUOTE_SERVICE",
            service = "quote"
          ),
          (
            name = "STATIC_FILES",
            service = "static-files"
          ),
        ],

        durableObjectStorage = ( inMemory = void ),

        durableObjectNamespaces = [
          (
            className = "HonoDurableObject",
            uniqueKey = "kettle-hono-do"
          )
        ],
      )
    ),
    (
      name = "sqld",
      external = (
        address = "127.0.0.1:${sqldPort}"
      )
    ),
    (
      name = "quote",
      external = (
        address = "127.0.0.1:${quoteServicePort}"
      )
    ),
    (
      name = "static-files",
      disk = "${staticDir}"
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

  const workerdBin = resolveWorkerdBinary()
  console.log(chalk.yellowBright("[kettle] Starting workerd..."))
  const workerd = spawn(
    workerdBin,
    [
      "serve",
      tmpConfigPath,
      "--socket-addr",
      `http=0.0.0.0:${workerPort}`,
      "--verbose",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  )

  // Do not keep the event loop alive because of child stdio
  ;(workerd.stdout as any)?.unref?.()
  ;(workerd.stderr as any)?.unref?.()

  workerd.stdout.on("data", (d) => {
    console.log(chalk.greenBright(String(d)))
  })
  workerd.stderr.on("data", (d) => {
    console.log(chalk.greenBright(String(d)))
  })

  // Wait for workerd to be ready before returning
  await waitForPortOpen(workerPort, 15000)
  // Give workerd additional time to fully initialize
  await new Promise((r) => {
    const timer = setTimeout(r, 500)
    timer.unref?.()
  })

  const result: WorkerResult = {
    workerPort,
    dbUrl,
    dbToken,
    workerd,
    sqld,
    replicaSqld,
    replicaDbPath: replicaDbPath ?? null,
    replicaDbUrl: replicaHttpPort
      ? `http://127.0.0.1:${replicaHttpPort}`
      : null,
    quoteServiceUrl,
    stop: async () => {
      const stopPromises: Promise<any>[] = [
        shutdown(workerd),
        shutdown(sqld),
        quoteService.stop(),
      ]
      if (replicaSqld) stopPromises.push(shutdown(replicaSqld))
      return Promise.all(stopPromises)
    },
  }

  console.log(
    chalk.yellowBright(
      `[kettle] Server listening on http://0.0.0.0:${workerPort}`,
    ),
  )

  return result
}

async function main() {
  const port = process.env.PORT ? Number(process.env.PORT) : 3001

  // Store worker data in /tmp
  const baseDir =
    process.env.DB_DIR ??
    mkdtempSync(join(process.env.TMPDIR || "/tmp", "teekit-kettle-"))
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }
  const dbPath = join(baseDir, "app.sqlite")

  // Always (re)build worker bundle for tests/local runs to pick up changes
  const projectDir = fileURLToPath(new URL("..", import.meta.url))
  console.log(chalk.yellowBright("[kettle] Building..."))
  await buildKettleApp({
    source: join(projectDir, "app.ts"),
    targetDir: join(projectDir, "dist"),
  })
  await buildKettleExternals({
    sourceDir: projectDir,
    targetDir: join(projectDir, "dist"),
  })

  const { stop } = await startWorker({
    dbPath,
    workerPort: port,
    sqldPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    bundleDir: join(projectDir, "dist"),
  })

  process.on("SIGINT", () => stop())
  process.on("SIGTERM", () => stop())
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
