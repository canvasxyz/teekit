import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { createHash } from "crypto"
import chalk from "chalk"

async function main() {
  // Get filename from command-line argument
  const filename = process.argv[2]
  if (!filename) {
    console.error(chalk.red("[kettle] Error: Please provide a filename or relative path"))
    console.error(chalk.red("[kettle] Usage: tsx server/buildManifest.ts <filename>"))
    process.exit(1)
  }

  // Get the kettle package directory
  const kettleDir = fileURLToPath(new URL("..", import.meta.url))
  const appPath = join(kettleDir, filename)
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
