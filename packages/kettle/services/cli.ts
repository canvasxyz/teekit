#!/usr/bin/env node
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import chalk from "chalk"

// Import command handlers
import { startWorkerCommand } from "./startWorker.js"
import { buildManifestCommand } from "./buildManifest.js"
import { buildRemoteManifestCommand } from "./buildRemoteManifest.js"
import { buildWorkerCommand } from "./buildWorker.js"
import { launcherCommand } from "./launcher.js"

async function main() {
  await yargs(hideBin(process.argv))
    .scriptName("kettle")
    .command(
      "start-worker [file]",
      "Start the Kettle worker with sqld and workerd",
      (yargs) => {
        return yargs
          .positional("file", {
            describe: "Path to the app source file (relative to package root)",
            type: "string",
            default: "app.ts",
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
      },
      startWorkerCommand,
    )
    .command(
      "build-manifest <file>",
      "Build a manifest.json file for the specified app",
      (yargs) => {
        return yargs.positional("file", {
          describe: "Path to the app source file (relative to package root)",
          type: "string",
          demandOption: true,
        })
      },
      buildManifestCommand,
    )
    .command(
      "build-remote-manifest <file>",
      "Build a remote manifest.json by uploading the app to GitHub Gist",
      (yargs) => {
        return yargs.positional("file", {
          describe: "Path to the app source file (relative to package root)",
          type: "string",
          demandOption: true,
        })
      },
      buildRemoteManifestCommand,
    )
    .command(
      "build-worker [file]",
      "Build the worker bundle (app.js, worker.js, externals.js)",
      (yargs) => {
        return yargs.positional("file", {
          describe: "Path to the app source file (relative to package root)",
          type: "string",
          default: "app.ts",
        })
      },
      buildWorkerCommand,
    )
    .command(
      "launcher",
      "Launch a Kettle app from a manifest file",
      (yargs) => {
        return yargs
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
      },
      launcherCommand,
    )
    .demandCommand(1, "You must specify a command")
    .help()
    .alias("help", "h")
    .version(false)
    .strict()
    .parse()
}

main().catch((err) => {
  console.error(chalk.red("[kettle] Error:"), err.message || err)
  process.exit(1)
})
