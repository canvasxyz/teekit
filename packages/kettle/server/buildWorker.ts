import chalk from "chalk"
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"
import { build } from "esbuild"
import { fileURLToPath, pathToFileURL } from "url"

export async function buildWorker(projectDir: string, verbose?: boolean) {
  const distDir = join(projectDir, "dist")
  try {
    if (!existsSync(distDir)) {
      mkdirSync(distDir, { recursive: true })
    }
    if (verbose) {
      console.log(chalk.yellowBright("[kettle] Building worker bundle..."))
    }

    // Build externals bundle to reduce app.js size
    const externalsBuild = await build({
      entryPoints: [join(projectDir, "externals.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      outfile: join(distDir, "externals.js"),
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
        join(distDir, "externals.metafile.json"),
        JSON.stringify(externalsBuild.metafile, null, 2),
      )
    }

    const appBuild = await build({
      entryPoints: [join(projectDir, "app.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      outfile: join(distDir, "app.js"),
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
        join(distDir, "app.metafile.json"),
        JSON.stringify(appBuild.metafile, null, 2),
      )
    }

    const workerBuild = await build({
      entryPoints: [join(projectDir, "worker.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      outfile: join(distDir, "worker.js"),
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
        join(distDir, "worker.metafile.json"),
        JSON.stringify(workerBuild.metafile, null, 2),
      )
    }

    const workerSize = readFileSync(join(distDir, "worker.js")).length
    const appSize = readFileSync(join(distDir, "app.js")).length
    const externalsSize = readFileSync(join(distDir, "externals.js")).length
    if (verbose) {
      console.log(
        chalk.yellowBright(
          `[kettle] Built app.js (${appSize} bytes), worker.js (${workerSize} bytes), externals.js (${externalsSize} bytes)\n` +
            `[kettle] Use https://esbuild.github.io/analyze/ on dist/app.metafile.json to analyze bundle size`,
        ),
      )
    }
  } catch (e) {
    console.error("[kettle] Failed to build worker bundle:", e)
    throw e
  }
}

async function main() {
  const projectDir = fileURLToPath(new URL("..", import.meta.url))
  await buildWorker(projectDir, true)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
