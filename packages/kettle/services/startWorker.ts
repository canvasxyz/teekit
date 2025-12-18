import { ChildProcess, spawn } from "child_process"
import * as chalk from "colorette"
import { writeFileSync, existsSync, mkdirSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join, basename } from "path"
import { fileURLToPath } from "url"
import {
  findFreePort,
  resolveWorkerdBinary,
  shutdown,
  waitForPortOpen,
} from "./utils.js"
import { startQuoteService } from "./startQuoteService.js"
import { buildKettleApp, buildKettleExternals } from "./buildWorker.js"

const CURRENT_DIR = fileURLToPath(new URL(".", import.meta.url))
const DIR_NAME = basename(CURRENT_DIR)
const PACKAGE_ROOT =
  DIR_NAME === "lib" ? join(CURRENT_DIR, "..", "..") : join(CURRENT_DIR, "..")

export interface WorkerConfig {
  workerPort: number
  quoteServicePort: number
  bundleDir: string
}

export interface WorkerResult {
  workerPort: number
  workerd: ChildProcess
  quoteServiceUrl: string
  stop: () => Promise<any>
}

export async function startWorker(
  options: WorkerConfig,
): Promise<WorkerResult> {
  const { workerPort, quoteServicePort, bundleDir } = options
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

  // Create temp directory for Durable Object SQLite storage
  const doStorageDir = mkdtempSync(join(tmpdir(), "kettle-do-storage-"))

  // Start quote service
  const quoteService = startQuoteService(quoteServicePort)
  await waitForPortOpen(quoteServicePort, 5000)

  console.log(
    chalk.yellowBright(
      `[kettle] Starting workerd on port ${workerPort} (using DO SQLite storage)...`,
    ),
  )

  const tmpConfigPath = join(bundleDir, "workerd.config.tmp.capnp")
  const configText = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  v8Flags = ["--abort-on-uncaught-exception"],
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
            name = "@teekit/kettle/worker",
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
        compatibilityDate = "2025-11-05",
        compatibilityFlags = ["nodejs_compat", "new_module_registry"],

        bindings = [
          (
            name = "HONO_DO",
            durableObjectNamespace = "HonoDurableObject"
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
        durableObjectNamespaces = [
          (
            className = "HonoDurableObject",
            uniqueKey = "hono-durable-object",
            enableSql = true,
          ),
        ],
        durableObjectStorage = (localDisk = "do-storage"),
      ),
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
    (
      name = "do-storage",
      disk = (
        path = "${doStorageDir}",
        writable = true
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

  const workerdBin = resolveWorkerdBinary()
  console.log(chalk.yellowBright("[kettle] Starting workerd..."))
  const workerd = spawn(
    workerdBin,
    [
      "serve",
      "--experimental",
      tmpConfigPath,
      "--socket-addr",
      `http=0.0.0.0:${workerPort}`,
      "--verbose",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  )

  workerd.stdout.on("data", (d) => {
    console.log(chalk.greenBright(String(d)))
  })
  workerd.stderr.on("data", (d) => {
    console.log(chalk.greenBright(String(d)))
  })

  // Wait for workerd to be ready before returning
  await waitForPortOpen(workerPort, 15000)
  // Give workerd additional time to fully initialize
  await new Promise((r) => setTimeout(r, 500))

  const result: WorkerResult = {
    workerPort,
    workerd,
    quoteServiceUrl,
    stop: async () => {
      const stopPromises: Promise<any>[] = [
        shutdown(workerd),
        quoteService.stop(),
      ]
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

export interface StartWorkerArgs {
  file?: string
  port?: number
}

export async function startWorkerCommand(argv: StartWorkerArgs) {
  const port = argv.port ?? (process.env.PORT ? Number(process.env.PORT) : 3001)

  // Always (re)build worker bundle for tests/local runs to pick up changes
  // Use current working directory for resolving the file path
  const cwd = process.cwd()
  const projectDir = PACKAGE_ROOT

  const filename = argv.file ?? "app.ts"
  const appSourcePath = join(cwd, filename)
  console.log(chalk.yellowBright("[kettle] Building..."))
  await buildKettleApp({
    source: appSourcePath,
    targetDir: join(projectDir, "dist"),
  })
  await buildKettleExternals({
    sourceDir: projectDir,
    targetDir: join(projectDir, "dist"),
  })

  const { stop } = await startWorker({
    workerPort: port,
    quoteServicePort: await findFreePort(),
    bundleDir: join(projectDir, "dist"),
  })

  process.on("SIGINT", () => stop())
  process.on("SIGTERM", () => stop())
}
