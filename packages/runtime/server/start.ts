import { spawn, ChildProcess } from "child_process"
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
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
  logEnv?: boolean
}

export interface WorkerResult {
  workerPort: number
  dbUrl: string
  dbToken: string
  workerd: ChildProcess
  sqld: ChildProcess
  stop: () => void
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

  const sqldArgs = [
    "--http-listen-addr",
    `127.0.0.1:${sqldPort}`,
    "--db-path",
    dbPath,
  ]
  const sqldBin = resolveSqldBinary()
  const sqld = spawn(sqldBin, sqldArgs, { stdio: "inherit" })

  // make sure we attempt cleanup if sqld exits early
  sqld.on("exit", (code) => {
    console.error(`[sqld] exited with code ${code}`)
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
    { stdio: ["ignore", "inherit", "inherit"] },
  )

  const result: WorkerResult = {
    workerPort,
    dbUrl,
    dbToken,
    workerd,
    sqld,
    stop: () => {
      try {
        workerd.kill("SIGKILL")
      } catch {}
      try {
        sqld.kill("SIGKILL")
      } catch {}
    },
  }

  if (options.logEnv) {
    console.log(`WORKERD_PORT=${workerPort}`)
    console.log(`DB_URL=${dbUrl}`)
    console.log(`DB_TOKEN=${dbToken}`)
  }

  return result
}
