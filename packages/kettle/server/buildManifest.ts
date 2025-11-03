import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { createHash } from "crypto"
import chalk from "chalk"

async function main() {
  // Get the kettle package directory
  const kettleDir = fileURLToPath(new URL("..", import.meta.url))
  const appPath = join(kettleDir, "app.ts")
  const manifestPath = join(kettleDir, "manifest.json")

  // Read app.ts and calculate SHA256 hash
  const appFileContent = readFileSync(appPath)
  const sha256Hash = createHash("sha256").update(appFileContent).digest("hex")

  // Generate manifest file
  const manifest = {
    app: `file://${appPath}`,
    sha256: sha256Hash,
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")

  console.log(
    chalk.blueBright(`[kettle] Generated manifest at ${manifestPath}`),
  )
}

main().catch((err) => {
  console.error(chalk.red("[kettle] Error:"), err)
  process.exit(1)
})
