import { existsSync, mkdirSync, mkdtempSync } from "fs"
import { join } from "path"
import { startWorker } from "./start.js"

async function main() {
  const baseDir = process.env.RUNTIME_DB_DIR
    ? process.env.RUNTIME_DB_DIR
    : mkdtempSync(join(process.env.TMPDIR || "/tmp", "teekit-runtime-"))
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })

  const { stop } = await startWorker({ baseDir, logEnv: true })

  const shutdown = () => {
    stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
