import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs"
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

interface ParsedManifest {
  app: string
}

const MAX_APP_FILE_SIZE = 5 * 1024 * 1024 // 5MB

async function parseManifest(
  manifestIdentifier: string,
): Promise<ParsedManifest> {
  let manifestContent: string

  // Handle manifest identifier (file:/// or http/https URL)
  if (
    manifestIdentifier.startsWith("http://") ||
    manifestIdentifier.startsWith("https://")
  ) {
    // Fetch manifest from URL
    const response = await fetch(manifestIdentifier)
    if (!response.ok) {
      throw new Error(
        `Failed to fetch manifest: ${response.status} ${response.statusText}`,
      )
    }
    manifestContent = await response.text()
  } else if (manifestIdentifier.startsWith("file://")) {
    // Handle file:/// URL
    const manifestPath = fileURLToPath(manifestIdentifier)
    if (!existsSync(manifestPath)) {
      throw new Error(`Manifest file not found: ${manifestPath}`)
    }
    manifestContent = readFileSync(manifestPath, "utf-8")
  } else {
    // Treat as file path (backward compatibility)
    if (!existsSync(manifestIdentifier)) {
      throw new Error(`Manifest file not found: ${manifestIdentifier}`)
    }
    manifestContent = readFileSync(manifestIdentifier, "utf-8")
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(manifestContent)
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in manifest file: ${err.message}`)
    }
    throw err
  }

  if (!manifest || typeof manifest !== "object") {
    throw new Error("Manifest must be a JSON object")
  }

  const manifestObj = manifest as Partial<Manifest>

  if (!manifestObj.app || typeof manifestObj.app !== "string") {
    throw new Error("Manifest must contain an 'app' field with a string value")
  }

  if (!manifestObj.sha256 || typeof manifestObj.sha256 !== "string") {
    throw new Error(
      "Manifest must contain a 'sha256' field with a string value",
    )
  }

  let appPath: string
  let appFileContent: Buffer

  // Handle app URL (file:/// or http/https)
  if (
    manifestObj.app.startsWith("http://") ||
    manifestObj.app.startsWith("https://")
  ) {
    // Fetch app file from URL
    const response = await fetch(manifestObj.app)
    if (!response.ok) {
      throw new Error(
        `Failed to fetch app file: ${response.status} ${response.statusText}`,
      )
    }

    // Check Content-Length header if available
    const contentLength = response.headers.get("content-length")
    if (contentLength) {
      const size = parseInt(contentLength, 10)
      if (size > MAX_APP_FILE_SIZE) {
        throw new Error(
          `App file size (${size} bytes) exceeds maximum allowed size (${MAX_APP_FILE_SIZE} bytes)`,
        )
      }
    }

    // Stream the file and stop if we exceed MAX_APP_FILE_SIZE
    const chunks: Uint8Array[] = []
    let totalSize = 0

    if (!response.body) {
      throw new Error("Response body is null")
    }

    const reader = response.body.getReader()

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          break
        }

        totalSize += value.length

        if (totalSize > MAX_APP_FILE_SIZE) {
          reader.cancel()
          throw new Error(
            `App file size exceeds maximum allowed size (${MAX_APP_FILE_SIZE} bytes)`,
          )
        }

        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }

    // Combine chunks into a single buffer
    appFileContent = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))

    // Verify SHA256 hash
    const calculatedHash = createHash("sha256")
      .update(appFileContent)
      .digest("hex")
    const expectedHash = manifestObj.sha256.toLowerCase()
    const actualHash = calculatedHash.toLowerCase()

    if (expectedHash !== actualHash) {
      throw new Error(
        `SHA256 hash mismatch: expected ${expectedHash}, got ${actualHash}`,
      )
    }

    // Write to kettle directory so relative imports can be resolved
    // Get the kettle package directory
    const kettleDir = fileURLToPath(new URL("..", import.meta.url))
    appPath = join(kettleDir, "app-remote.tmp.ts")
    writeFileSync(appPath, appFileContent)
  } else if (manifestObj.app.startsWith("file://")) {
    // Handle file:/// URL
    appPath = fileURLToPath(manifestObj.app)

    if (!existsSync(appPath)) {
      throw new Error(`App file not found: ${appPath}`)
    }

    // Read the app file and calculate its SHA256 hash
    appFileContent = readFileSync(appPath)
    const calculatedHash = createHash("sha256")
      .update(appFileContent)
      .digest("hex")

    // Normalize the hashes (convert to lowercase for comparison)
    const expectedHash = manifestObj.sha256.toLowerCase()
    const actualHash = calculatedHash.toLowerCase()

    if (expectedHash !== actualHash) {
      throw new Error(
        `SHA256 hash mismatch: expected ${expectedHash}, got ${actualHash}`,
      )
    }
  } else {
    throw new Error(
      "Manifest must contain an 'app' field with a file:/// or http/https URL",
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
    .option("verbose", {
      type: "boolean",
      description: "Include verbose logging",
    })
    .help()
    .alias("help", "h")
    .parse()

  const manifest = await parseManifest(argv.manifest)
  if (argv.verbose) {
    console.log(chalk.yellowBright(`[launcher] App source: ${manifest.app}`))
  }

  // Create temporary build directory
  const buildDir = mkdtempSync(join(tmpdir(), "kettle-launcher-build-"))
  if (argv.verbose) {
    console.log(chalk.yellowBright(`[launcher] Build directory: ${buildDir}`))
  }

  // Build the app
  if (argv.verbose) {
    console.log(chalk.yellowBright("[launcher] Building app..."))
  }
  await buildKettleApp({
    source: manifest.app,
    targetDir: buildDir,
    verbose: argv.verbose,
  })

  // Build externals and worker
  const kettlePackageDir = fileURLToPath(new URL("..", import.meta.url))
  await buildKettleExternals({
    sourceDir: kettlePackageDir,
    targetDir: buildDir,
    verbose: argv.verbose,
  })

  // Set up database directory
  const baseDir =
    argv["db-dir"] ?? mkdtempSync(join(tmpdir(), "kettle-launcher-db-"))
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }
  const dbPath = join(baseDir, "app.sqlite")

  if (argv.verbose) {
    console.log(chalk.yellowBright("[launcher] Starting worker..."))
  }
  const { stop } = await startWorker({
    dbPath,
    workerPort: argv.port,
    sqldPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    bundleDir: buildDir,
  })

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
