import chalk from "chalk"
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs"
import { join, basename } from "path"
import { build } from "esbuild"
import { fileURLToPath } from "url"

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
  const sourceDir = options.sourceDir ?? PACKAGE_ROOT

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  // Build externals bundle to reduce app.js size
  const externalsBuild = await build({
    entryPoints: [join(sourceDir, "externals.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: join(targetDir, "externals.js"),
    metafile: true,
    external: [
      // Externalize Node-only deps that appear in optional/dynamic paths
      "path",
      "fs",
      "stream",
      "buffer",
      "events",
      "http",
      "ws",
      "node-mocks-http",
      "net",
      "querystring",
    ],
  })

  if (externalsBuild.metafile) {
    writeFileSync(
      join(targetDir, "externals.metafile.json"),
      JSON.stringify(externalsBuild.metafile, null, 2),
    )
  }

  const workerBuild = await build({
    entryPoints: [join(sourceDir, "services", "worker", "worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: join(targetDir, "worker.js"),
    metafile: true,
    external: [
      // Same externals as app; keep bundle minimal
      "path",
      "fs",
      "stream",
      "buffer",
      "events",
      "http",
      "ws",
      "node-mocks-http",
      // Treat embedded module as external so it's resolved at runtime by workerd
      "app.js",
    ],
  })

  if (workerBuild.metafile) {
    writeFileSync(
      join(targetDir, "worker.metafile.json"),
      JSON.stringify(workerBuild.metafile, null, 2),
    )
  }

  const workerSize = readFileSync(join(targetDir, "worker.js")).length
  const externalsSize = readFileSync(join(targetDir, "externals.js")).length
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
