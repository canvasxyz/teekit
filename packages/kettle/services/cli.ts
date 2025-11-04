#!/usr/bin/env node
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import chalk from "chalk"

import { startWorkerCommand } from "./startWorker.js"
import { buildManifestCommand } from "./buildManifest.js"
import { buildRemoteManifestCommand } from "./buildRemoteManifest.js"
import { buildAppCommand, buildWorkerCommand } from "./buildWorker.js"
import { launcherCommand } from "./launcher.js"

async function main() {
  await yargs(hideBin(process.argv))
    .scriptName("kettle")
    .wrap(90)
    .command(
      "publish [file]",
      "Generate an app manifest, by publishing to GitHub",
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
      "publish-local [file]",
      "Generate an app manifest, using a file:/// url",
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
      "launch",
      "Start app runtime from a manifest file",
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
    .command(
      "start-worker [file]",
      "[Internal] Start app runtime with workerd/sqld directly",
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
      "build-app [file]",
      "[Internal] Build the app bundle (app.js)",
      (yargs) => {
        return yargs.positional("file", {
          describe: "Path to the app source file (relative to package root)",
          type: "string",
          default: "app.ts",
        })
      },
      buildAppCommand,
    )
    .command(
      "build-worker",
      "[Internal] Build the worker bundle (worker.js, externals.js)",
      buildWorkerCommand,
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
