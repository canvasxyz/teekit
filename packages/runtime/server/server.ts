import { spawn, ChildProcess } from "child_process"
import chalk from "chalk"
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import { pathToFileURL } from "url"
import {
  findFreePort,
  randomToken,
  resolveSqldBinary,
  resolveWorkerdBinary,
  shutdown,
  waitForPortOpen,
} from "./utils.js"

export interface WorkerConfig {
  dbPath: string
  workerPort: number
  sqldPort: number
  replicaDbPath?: string
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
  stop: () => Promise<any>
}

export async function startWorker(
  options: WorkerConfig,
): Promise<WorkerResult> {
  const { dbPath, sqldPort, workerPort, replicaDbPath } = options
  const dbToken = randomToken()
  const dbUrl = `http://127.0.0.1:${sqldPort}`

  // Enable replication if replicaDbPath is provided
  const enableReplication = !!replicaDbPath
  const grpcPort = enableReplication ? await findFreePort() : undefined

  let replicaSqld: ChildProcess | null = null
  let replicaHttpPort: number | null = null

  console.log(
    chalk.yellowBright(
      `Starting sqld on port ${sqldPort}, workerd on port ${workerPort}`,
    ),
  )
  if (enableReplication) {
    replicaHttpPort = await findFreePort()
    console.log(
      chalk.yellowBright(
        `Starting sqld replica on port ${replicaHttpPort}, gRPC on port ${grpcPort}`,
      ),
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

  // Add gRPC listener for replication
  if (enableReplication && grpcPort) {
    sqldArgs.push("--grpc-listen-addr", `127.0.0.1:${grpcPort}`)
  }

  const sqldBin = resolveSqldBinary()
  const sqld = spawn(sqldBin, sqldArgs, { stdio: ["ignore", "pipe", "pipe"] })

  sqld.stdout.on("data", (d) => {
    process.stdout.write(chalk.greenBright(String(d).trim()))
  })
  sqld.stderr.on("data", (d) => {
    process.stderr.write(chalk.yellowBright(String(d).trim()))
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

    replicaSqld = spawn(sqldBin, replicaArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    })

    replicaSqld.stdout?.on("data", (d) => {
      process.stdout.write(chalk.blueBright(`[replica] ${String(d).trim()}`))
    })
    replicaSqld.stderr?.on("data", (d) => {
      process.stderr.write(chalk.magentaBright(`[replica] ${String(d).trim()}`))
    })

    // log if replica exits early with an error
    replicaSqld.on("exit", (code) => {
      if (code !== 0) console.error(`[replica sqld] exited with code ${code}`)
    })

    // Give replica additional time to connect and start syncing
    await waitForPortOpen(replicaHttpPort, 10000)
    await new Promise((r) => setTimeout(r, 1000))
  }

  // Start workerd
  const cwd = process.cwd()
  const CONTRACT_JS = "dist/worker.js"
  const QUOTE_JS = "dist/bindings/quote.js"
  const tmpConfigPath = join(cwd, "workerd.config.tmp.capnp")
  const configText = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = "main",
      worker = (
        modules = [
          (
            name = "worker.js",
            esModule = embed "${CONTRACT_JS}"
          ),
          (
            name = "quote",
            esModule = embed "${QUOTE_JS}"
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

  const workerdBin = resolveWorkerdBinary()
  const workerd = spawn(
    workerdBin,
    ["serve", tmpConfigPath, "--socket-addr", `http=0.0.0.0:${workerPort}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  )

  workerd.stdout.on("data", (d) => {
    process.stdout.write(chalk.greenBright(String(d)))
  })
  workerd.stderr.on("data", (d) => {
    process.stderr.write(chalk.greenBright(String(d)))
  })

  // Wait for workerd to be ready before returning
  await waitForPortOpen(workerPort, 15000)
  // Give workerd additional time to fully initialize
  await new Promise((r) => setTimeout(r, 1000))

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
    stop: () => {
      const stopPromises: Promise<any>[] = [shutdown(workerd), shutdown(sqld)]
      if (replicaSqld) stopPromises.push(shutdown(replicaSqld))
      return Promise.all(stopPromises)
    },
  }

  return result
}

async function main() {
  const baseDir =
    process.env.RUNTIME_DB_DIR ??
    mkdtempSync(join(process.env.TMPDIR || "/tmp", "teekit-runtime-"))
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }

  const dbPath = join(baseDir, "app.sqlite")

  const { stop } = await startWorker({
    dbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
  })

  process.on("SIGINT", () => stop())
  process.on("SIGTERM", () => stop())
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
