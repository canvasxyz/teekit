import { readFileSync, existsSync, writeFileSync, mkdtempSync } from "fs"
import { join, basename } from "path"
import { fileURLToPath } from "url"
import { tmpdir } from "os"
import { createHash } from "crypto"
import * as chalk from "colorette"

import { startWorker } from "./startWorker.js"
import { buildKettleApp, buildKettleExternals } from "./buildWorker.js"
import { findFreePort } from "./utils.js"

const CURRENT_DIR = fileURLToPath(new URL(".", import.meta.url))
const DIR_NAME = basename(CURRENT_DIR)
const KETTLE_DIR =
  DIR_NAME === "lib"
    ? join(CURRENT_DIR, "..")
    : join(CURRENT_DIR, "..")

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

        if (!value) continue
        totalSize += value.length
        if (totalSize > MAX_APP_FILE_SIZE) {
          reader.releaseLock()
          throw new Error(
            `App file size exceeds maximum allowed size (${MAX_APP_FILE_SIZE} bytes)`,
          )
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }

    appFileContent = Buffer.concat(chunks)

    // Write fetched app to a temporary file inside the package root
    const kettleDir = KETTLE_DIR
    appPath = join(kettleDir, "app-remote.tmp.ts")
    writeFileSync(appPath, appFileContent)
  } else if (manifestObj.app.startsWith("file://")) {
    // Handle file:/// URL
    appPath = fileURLToPath(manifestObj.app)

    if (!existsSync(appPath)) {
      throw new Error(`App file not found: ${appPath}`)
    }

    // Verify SHA256 hash for all files
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

export interface LauncherArgs {
  manifest: string
  port?: number
  verbose?: boolean
  dbDir?: string
}

export async function launcherCommand(argv: LauncherArgs) {
  const manifest = await parseManifest(argv.manifest)
  if (argv.verbose) {
    console.log(chalk.yellowBright(`[launcher] App source: ${manifest.app}`))
  }

  // Determine bundle directory based on whether app is pre-built or needs building
  let bundleDir: string
  const isPrebuilt = manifest.app.endsWith(".js")

  if (isPrebuilt) {
    // App is already built, use the directory containing the built files
    const appDir = manifest.app.substring(0, manifest.app.lastIndexOf("/"))
    let appDirPath = appDir.startsWith("file://")
      ? fileURLToPath(appDir)
      : appDir

    if (argv.verbose) {
      console.log(
        chalk.yellowBright(
          `[launcher] Using pre-built app from: ${appDirPath}`,
        ),
      )
    }

    // For pre-built apps, assume worker.js and externals.js are in the same directory
    bundleDir = appDirPath
  } else {
    // Create temporary build directory
    const tempBuildDir = mkdtempSync(join(tmpdir(), "kettle-launcher-build-"))
    bundleDir = tempBuildDir
    if (argv.verbose) {
      console.log(chalk.yellowBright(`[launcher] Build directory: ${bundleDir}`))
    }

    // Build the app
    if (argv.verbose) {
      console.log(chalk.yellowBright("[launcher] Building app..."))
    }
    await buildKettleApp({
      source: manifest.app,
      targetDir: bundleDir,
      verbose: argv.verbose,
    })

    // Build externals and worker
    const kettlePackageDir = KETTLE_DIR
    await buildKettleExternals({
      sourceDir: kettlePackageDir,
      targetDir: bundleDir,
      verbose: argv.verbose,
    })
  }

  if (argv.verbose) {
    console.log(chalk.yellowBright("[launcher] Starting worker..."))
  }
  const { stop } = await startWorker({
    workerPort: argv.port ?? 3001,
    quoteServicePort: await findFreePort(),
    bundleDir: bundleDir,
    dbDir: argv.dbDir,
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

 

export { parseManifest }
