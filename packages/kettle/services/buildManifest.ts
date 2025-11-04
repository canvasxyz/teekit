import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { createHash } from "crypto"
import chalk from "chalk"

export interface BuildManifestArgs {
  file: string
}

export async function buildManifestCommand(argv: BuildManifestArgs) {
  const filename = argv.file
  if (!filename) {
    console.error(
      chalk.red("[kettle] Error: Please provide a filename or relative path"),
    )
    process.exit(1)
  }

  // Resolve file path relative to current working directory
  const cwd = process.cwd()
  const appPath = join(cwd, filename)
  const manifestPath = join(cwd, "manifest.json")

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
