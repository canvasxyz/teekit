import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { createHash } from "crypto"
import chalk from "chalk"

const GITHUB_TOKEN_URL =
  "https://github.com/settings/tokens/new?description=Kettle&scopes=gist&default_expires_at=90"

async function createGist(appContent: string, token: string): Promise<string> {
  const response = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      description: "Kettle app.ts",
      public: false,
      files: {
        "app.ts": {
          content: appContent,
        },
      },
    }),
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    const status = response.status

    if (status === 401) {
      console.log(errorData)
      throw new Error(`GitHub token is invalid or expired.`)
    }

    if (status === 403) {
      console.log(errorData)
      throw new Error(`GitHub token does not have gist scope.`)
    }

    throw new Error(
      `Failed to create Gist: ${status} ${response.statusText}. ${
        errorData.message || ""
      }`,
    )
  }

  const gist = await response.json()
  const rawUrl = gist.files["app.ts"].raw_url

  if (!rawUrl) {
    throw new Error("Failed to get raw URL from Gist response")
  }

  return rawUrl
}

async function main() {
  // Get the kettle package directory
  const kettleDir = fileURLToPath(new URL("..", import.meta.url))
  const appPath = join(kettleDir, "app.ts")
  const manifestPath = join(kettleDir, "manifest.json")

  // Prefer GITHUB_TOKEN from .env over process.env
  let tokenFromDotEnv: string | undefined
  const dotEnvPath = join(kettleDir, ".env")
  if (existsSync(dotEnvPath)) {
    try {
      const envContent = readFileSync(dotEnvPath, "utf-8")
      const line = envContent
        .split(/\r?\n/)
        .find((l) => /^\s*GITHUB_TOKEN\s*=/.test(l))
      if (line) {
        const value = line.split("=").slice(1).join("=").trim()
        tokenFromDotEnv = value.replace(/^['\"]|['\"]$/g, "") || undefined
      }
    } catch {
      // ignore .env read errors and fall back to process.env
    }
  }
  const token = tokenFromDotEnv || process.env.GITHUB_TOKEN
  if (!token) {
    console.error(
      chalk.red(
        `[buildRemoteManifest] GITHUB_TOKEN environment variable not found.\n` +
          `Please create a GitHub personal access token at:\n${GITHUB_TOKEN_URL}\n` +
          `Then set it in your .env file or provide it as GITHUB_TOKEN=<token>`,
      ),
    )
    process.exit(1)
  }

  // Read app.ts and calculate SHA256 hash
  console.log(chalk.yellowBright("[buildRemoteManifest] Reading app.ts..."))
  const appFileContent = readFileSync(appPath, "utf-8")
  const sha256Hash = createHash("sha256")
    .update(appFileContent, "utf-8")
    .digest("hex")

  // Create Gist
  console.log(chalk.yellowBright("[buildRemoteManifest] Creating Gist..."))
  let gistRawUrl: string
  try {
    gistRawUrl = await createGist(appFileContent, token)
    console.log(
      chalk.greenBright(`[buildRemoteManifest] Created Gist: ${gistRawUrl}`),
    )
  } catch (err) {
    if (err instanceof Error) {
      console.error(
        chalk.yellowBright(`[buildRemoteManifest] Error: ${err.message}`),
      )
      if (err.message.includes("token")) {
        console.error(
          chalk.yellowBright(
            `\nPlease create a new GitHub personal access token at:\n${GITHUB_TOKEN_URL}`,
          ),
        )
      }
    } else {
      console.error(
        chalk.yellowBright(`[buildRemoteManifest] Unexpected error:`, err),
      )
    }
    process.exit(1)
  }

  // Generate manifest file
  const manifest = {
    app: gistRawUrl,
    sha256: sha256Hash,
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")

  console.log(
    chalk.greenBright(
      `[buildRemoteManifest] Generated manifest at ${manifestPath}`,
    ),
  )
  console.log(
    chalk.greenBright(`[buildRemoteManifest] Manifest app URL: ${gistRawUrl}`),
  )
}

main().catch((err) => {
  console.error(chalk.red("[buildRemoteManifest] Error:"), err)
  process.exit(1)
})
