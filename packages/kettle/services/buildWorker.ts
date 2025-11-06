import chalk from "chalk"
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs"
import { join, basename } from "path"
import { fileURLToPath } from "url"
import { EXTERNALS_JS, WORKER_JS } from "./embeddedSources.js"

const CURRENT_DIR = fileURLToPath(new URL(".", import.meta.url))
const DIR_NAME = basename(CURRENT_DIR)
const PACKAGE_ROOT =
  DIR_NAME === "lib" ? join(CURRENT_DIR, "..", "..") : join(CURRENT_DIR, "..")

type BuildConfig = {
  source: string
  targetDir: string
  verbose?: boolean
}

type BuildExternalsConfig = {
  sourceDir?: string
  targetDir: string
  verbose?: boolean
}

export async function buildKettleApp(options: BuildConfig) {
  const { source, targetDir, verbose } = options

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  // Dynamic import of esbuild to avoid loading it at module initialization
  const { build } = await import("esbuild")

  const appBuild = await build({
    entryPoints: [source],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: join(targetDir, "app.js"),
    metafile: true,
    external: [
      // Externalize Node-only deps that appear in optional/dynamic paths of @teekit/tunnel
      "path",
      "fs",
      "stream",
      "buffer",
      "events",
      "http",
      "ws",
      "node-mocks-http",
      // Externalize large packages to reduce app.js size - workerd will resolve to externals.js module
      "hono",
      "hono/cors",
      "hono/ws",
      "hono/cloudflare-workers",
      "hono/utils/http-status",
      "@libsql/client",
      "@teekit/kettle/worker",
      "@teekit/tunnel",
      "@teekit/tunnel/samples",
      "@teekit/qvl",
      "@teekit/qvl/utils",
      "cbor-x",
      "@noble/ciphers",
      "@noble/ciphers/salsa",
      "@noble/hashes",
      "@noble/hashes/sha256",
      "@noble/hashes/sha512",
      "@noble/hashes/blake2b",
      "@noble/hashes/crypto",
      "@noble/hashes/sha1",
      "@noble/hashes/sha2",
      "@noble/hashes/utils",
      "@noble/curves",
      "@noble/curves/ed25519",
      "@scure/base",
    ],
  })

  if (appBuild.metafile) {
    writeFileSync(
      join(targetDir, "app.metafile.json"),
      JSON.stringify(appBuild.metafile, null, 2),
    )
  }

  const appSize = readFileSync(join(targetDir, "app.js")).length

  if (verbose) {
    console.log(chalk.yellowBright(`[kettle] Built app.js (${appSize} bytes)`))
  }
}

export async function buildKettleExternals(options: BuildExternalsConfig) {
  const { targetDir, verbose } = options

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  // Write pre-built files from embedded sources
  // (these are either read from dist/ in dev mode, or bundled as strings in the CLI bundle)
  writeFileSync(join(targetDir, "externals.js"), EXTERNALS_JS)
  writeFileSync(join(targetDir, "worker.js"), WORKER_JS)

  const externalsSize = EXTERNALS_JS.length
  const workerSize = WORKER_JS.length

  if (verbose) {
    console.log(
      chalk.yellowBright(
        `[kettle] Built worker.js (${workerSize} bytes)\n` +
          `[kettle] Built externals.js (${externalsSize} bytes)\n` +
          `[kettle] Use https://esbuild.github.io/analyze/ on dist/app.metafile.json to analyze bundle size`,
      ),
    )
  }
}

export interface BuildAppArgs {
  file?: string
}

export async function buildAppCommand(argv: BuildAppArgs) {
  // Resolve file path relative to current working directory
  const cwd = process.cwd()
  const projectDir = PACKAGE_ROOT
  const filename = argv.file ?? "app.ts"
  const appSourcePath = join(cwd, filename)
  await buildKettleApp({
    source: appSourcePath,
    targetDir: join(projectDir, "dist"),
    verbose: true,
  })
}

export async function buildWorkerCommand() {
  const projectDir = PACKAGE_ROOT
  await buildKettleExternals({
    targetDir: join(projectDir, "dist"),
    verbose: true,
  })
}
