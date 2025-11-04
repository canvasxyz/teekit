import { readFileSync, writeFileSync, existsSync } from "fs"
import { join, basename } from "path"
import { fileURLToPath } from "url"
import { createHash } from "crypto"
import chalk from "chalk"

const CURRENT_DIR = fileURLToPath(new URL(".", import.meta.url))
const DIR_NAME = basename(CURRENT_DIR)
const KETTLE_DIR =
  DIR_NAME === "lib"
    ? join(CURRENT_DIR, "..", "..")
    : join(CURRENT_DIR, "..")

const GITHUB_TOKEN_URL =
  "https://github.com/settings/tokens/new?description=Kettle&scopes=gist&default_expires_at=90"

async function createGist(
  appContent: string,
  token: string,
  filename: string,
): Promise<string> {
  const basename = filename.split(/[/\\]/).pop() || filename
  const response = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      description: `Kettle ${basename}`,
      public: false,
      files: {
        [basename]: {
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
  const rawUrl = gist.files[basename].raw_url

  if (!rawUrl) {
    throw new Error("Failed to get raw URL from Gist response")
  }

  return rawUrl
}

export async function buildRemoteManifestCommand(argv: any) {
  const filename = argv.file
  if (!filename) {
    console.error(
      chalk.red(
        "[remote-manifest] Error: Please provide a filename or relative path",
      ),
    )
    process.exit(1)
  }

  // Get the kettle package directory
  const kettleDir = KETTLE_DIR
  const appPath = join(kettleDir, filename)
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
        `[remote-manifest] GITHUB_TOKEN environment variable not found.\n` +
          `Please create a GitHub personal access token at:\n${GITHUB_TOKEN_URL}\n` +
          `Then set it in your .env file or provide it as GITHUB_TOKEN=<token>`,
      ),
    )
    process.exit(1)
  }

  // Read app.ts and calculate SHA256 hash
  const appFileContent = readFileSync(appPath, "utf-8")
  const sha256Hash = createHash("sha256")
    .update(appFileContent, "utf-8")
    .digest("hex")

  // Create Gist
  console.log(chalk.blueBright("[remote-manifest] Creating Gist..."))
  let gistRawUrl: string
  try {
    gistRawUrl = await createGist(appFileContent, token, filename)
    console.log(
      chalk.blueBright(`[remote-manifest] Created Gist: ${gistRawUrl}`),
    )
  } catch (err) {
    if (err instanceof Error) {
      console.error(chalk.blueBright(`[remote-manifest] Error: ${err.message}`))
      if (err.message.includes("token")) {
        console.error(
          chalk.blueBright(
            `\nPlease create a new GitHub personal access token at:\n${GITHUB_TOKEN_URL}`,
          ),
        )
      }
    } else {
      console.error(
        chalk.blueBright(`[remote-manifest] Unexpected error:`, err),
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

  console.log(chalk.blueBright(`[remote-manifest] Saved to ${manifestPath}`))
}

async function main() {
  // Get filename from command-line argument
  const filename = process.argv[2]
  if (!filename) {
    console.error(
      chalk.red(
        "[remote-manifest] Error: Please provide a filename or relative path",
      ),
    )
    console.error(
      chalk.red(
        "[remote-manifest] Usage: tsx services/buildRemoteManifest.ts <filename>",
      ),
    )
    process.exit(1)
  }

  // Get the kettle package directory
  const kettleDir = KETTLE_DIR
  const appPath = join(kettleDir, filename)
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
        `[remote-manifest] GITHUB_TOKEN environment variable not found.\n` +
          `Please create a GitHub personal access token at:\n${GITHUB_TOKEN_URL}\n` +
          `Then set it in your .env file or provide it as GITHUB_TOKEN=<token>`,
      ),
    )
    process.exit(1)
  }

  // Read app.ts and calculate SHA256 hash
  const appFileContent = readFileSync(appPath, "utf-8")
  const sha256Hash = createHash("sha256")
    .update(appFileContent, "utf-8")
    .digest("hex")

  // Create Gist
  console.log(chalk.blueBright("[remote-manifest] Creating Gist..."))
  let gistRawUrl: string
  try {
    gistRawUrl = await createGist(appFileContent, token, filename)
    console.log(
      chalk.blueBright(`[remote-manifest] Created Gist: ${gistRawUrl}`),
    )
  } catch (err) {
    if (err instanceof Error) {
      console.error(chalk.blueBright(`[remote-manifest] Error: ${err.message}`))
      if (err.message.includes("token")) {
        console.error(
          chalk.blueBright(
            `\nPlease create a new GitHub personal access token at:\n${GITHUB_TOKEN_URL}`,
          ),
        )
      }
    } else {
      console.error(
        chalk.blueBright(`[remote-manifest] Unexpected error:`, err),
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

  console.log(chalk.blueBright(`[remote-manifest] Saved to ${manifestPath}`))
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((err) => {
    console.error(chalk.red("[remote-manifest] Error:"), err)
    process.exit(1)
  })
}
