import { spawn, ChildProcess } from "child_process"
import chalk from "chalk"
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { pathToFileURL } from "url"
import {
  findFreePortNear,
  randomToken,
  resolveSqldBinary,
  waitForPortOpen,
} from "./utils.js"

export interface WorkerConfig {
  baseDir?: string
  workerPort?: number
  sqldPort?: number
}

export interface WorkerResult {
  workerPort: number
  dbUrl: string
  dbToken: string
  workerd: ChildProcess
  sqld: ChildProcess
  stop: () => Promise<any>
}

export async function startWorker(
  options: WorkerConfig = {},
): Promise<WorkerResult> {
  const baseDir = options.baseDir
    ? options.baseDir
    : mkdtempSync(join(tmpdir(), "teekit-runtime-"))
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })

  const dbPath = join(baseDir, "app.sqlite")
  const dbToken = randomToken()

  const sqldPort = options.sqldPort ?? (await findFreePortNear(8088))
  const workerPort = options.workerPort ?? (await findFreePortNear(3001))

  const dbUrl = `http://127.0.0.1:${sqldPort}`

  console.log(
    chalk.yellowBright(
      `Starting sqld on port ${sqldPort}, workerd on port ${workerPort}`,
    ),
  )
  const sqldArgs = [
    "--no-welcome",
    "--http-listen-addr",
    `127.0.0.1:${sqldPort}`,
    "--db-path",
    dbPath,
  ]
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

  const workerd = spawn(
    "npx",
    [
      "workerd",
      "serve",
      tmpConfigPath,
      "--socket-addr",
      `http=0.0.0.0:${workerPort}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  )

  workerd.stdout.on("data", (d) => {
    process.stdout.write(chalk.greenBright(String(d)))
  })
  workerd.stderr.on("data", (d) => {
    process.stderr.write(chalk.greenBright(String(d)))
  })

  function shutdown(child: ChildProcess, timeoutMs = 1500): void {
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {}
    }, timeoutMs)
    child.once("exit", () => {
      clearTimeout(killTimer)
    })
    child.kill("SIGTERM")
  }

  const result: WorkerResult = {
    workerPort,
    dbUrl,
    dbToken,
    workerd,
    sqld,
    stop: () => Promise.all([shutdown(workerd), shutdown(sqld)]),
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

  const { stop } = await startWorker({ baseDir })

  process.on("SIGINT", () => stop())
  process.on("SIGTERM", () => stop())
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
