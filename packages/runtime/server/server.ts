import { spawn } from "child_process"
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  findFreePortNear,
  randomToken,
  resolveSqldBinary,
  waitForPortOpen,
} from "./utils.js"

async function main() {
  const baseDir = process.env.RUNTIME_DB_DIR
    ? process.env.RUNTIME_DB_DIR
    : mkdtempSync(join(tmpdir(), "teekit-runtime-"))
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })

  // Configure sqld, print config to be captured by tests
  const sqldPort = await findFreePortNear(8088)
  const workerPort = await findFreePortNear(3001)

  const dbPath = join(baseDir, "app.sqlite")
  const dbUrl = `http://127.0.0.1:${sqldPort}`
  const dbToken = randomToken()

  console.log(`WORKERD_PORT=${workerPort}`)
  console.log(`DB_URL=${dbUrl}`)
  console.log(`DB_TOKEN=${dbToken}`)

  // Configure workerd
  const cwd = process.cwd()
  const CONTRACT_JS = "dist/worker.js"
  const QUOTE_JS = "dist/bindings/quote.js"
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

  // Start sqld
  const sqldArgs = [
    "--http-listen-addr",
    `127.0.0.1:${sqldPort}`,
    "--no-welcome",
    "--db-path",
    dbPath,
  ]
  const sqldBin = resolveSqldBinary()
  const sqld = spawn(sqldBin, sqldArgs, { stdio: "inherit" })

  sqld.on("exit", (code) => {
    console.error(`[sqld] exited with code ${code}`)
  })

  try {
    await waitForPortOpen(sqldPort, 15000)
  } catch (err) {
    console.error(`[sqld] failed to open port ${sqldPort}:`, err)
    throw err
  }

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

  // Cleanup handlers
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
