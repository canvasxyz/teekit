import { readFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { createHash } from "crypto"
import chalk from "chalk"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"

import { startWorker } from "./startWorker.js"
import { buildKettleApp, buildKettleExternals } from "./buildWorker.js"
import { findFreePort } from "./utils.js"

interface Manifest {
  app: string
  sha256: string
}

function parseManifest(manifestPath: string): Manifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`)
  }

  const content = readFileSync(manifestPath, "utf-8")

  let manifest
  try {
    manifest = JSON.parse(content)
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in manifest file: ${err.message}`)
    }
    throw err
  }

  if (!manifest || typeof manifest !== "object") {
    throw new Error("Manifest must be a JSON object")
  }

  if (!manifest.app || typeof manifest.app !== "string") {
    throw new Error("Manifest must contain an 'app' field with a string value")
  }

  if (!manifest.app.startsWith("file://")) {
    throw new Error("Manifest must contain an 'app' field with a file:/// URL")
  }

  if (!manifest.sha256 || typeof manifest.sha256 !== "string") {
    throw new Error("Manifest must contain a 'sha256' field with a string value")
  }

  const appPath = fileURLToPath(manifest.app)

  if (!existsSync(appPath)) {
    throw new Error(`App file not found: ${appPath}`)
  }

  // Read the app file and calculate its SHA256 hash
  const appFileContent = readFileSync(appPath)
  const calculatedHash = createHash("sha256").update(appFileContent).digest("hex")

  // Normalize the hashes (convert to lowercase for comparison)
  const expectedHash = manifest.sha256.toLowerCase()
  const actualHash = calculatedHash.toLowerCase()

  if (expectedHash !== actualHash) {
    throw new Error(
      `SHA256 hash mismatch: expected ${expectedHash}, got ${actualHash}`,
    )
  }

  return { app: appPath }
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("manifest", {
      alias: "m",
      type: "string",
      description: "Path to the manifest JSON file",
      demandOption: true,
    })
    .option("port", {
      alias: "p",
      type: "number",
      description: "Port for the worker HTTP server",
      default: 3001,
    })
    .option("db-dir", {
      type: "string",
      description: "Directory to store the database",
    })
    .help()
    .alias("help", "h")
    .parse()

  console.log(chalk.yellowBright("[launcher] Loading manifest..."))
  const manifest = parseManifest(argv.manifest)
  console.log(chalk.greenBright(`[launcher] App source: ${manifest.app}`))

  // Create temporary build directory
  const buildDir = mkdtempSync(join(tmpdir(), "kettle-launcher-build-"))
  console.log(chalk.yellowBright(`[launcher] Build directory: ${buildDir}`))

  // Build the app
  console.log(chalk.yellowBright("[launcher] Building app..."))
  await buildKettleApp({
    source: manifest.app,
    targetDir: buildDir,
    verbose: true,
  })

  // Build externals and worker
  const kettlePackageDir = fileURLToPath(new URL("..", import.meta.url))
  await buildKettleExternals({
    sourceDir: kettlePackageDir,
    targetDir: buildDir,
    verbose: true,
  })

  // Set up database directory
  const baseDir =
    argv["db-dir"] ?? mkdtempSync(join(tmpdir(), "kettle-launcher-db-"))
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }
  const dbPath = join(baseDir, "app.sqlite")

  console.log(chalk.yellowBright("[launcher] Starting worker..."))
  const { stop, workerPort } = await startWorker({
    dbPath,
    workerPort: argv.port,
    sqldPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    bundleDir: buildDir,
  })

  console.log(
    chalk.greenBright(
      `[launcher] Worker running at http://localhost:${workerPort}`,
    ),
  )

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log(chalk.yellowBright("\n[launcher] Shutting down..."))
    await stop()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((err) => {
    console.error(chalk.red("[launcher] Error:", err.message))
    process.exit(1)
  })
}

export { parseManifest }
