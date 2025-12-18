#!/usr/bin/env node
import yargs, { type Argv } from "yargs"
import { hideBin } from "yargs/helpers"
import * as chalk from "colorette"

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
      "publish <file>",
      "Generate an app manifest, by publishing to GitHub",
      (yargs: Argv) => {
        return yargs.positional("file", {
          describe: "Path to the app source file (relative to package root)",
          type: "string",
          demandOption: true,
        })
      },
      buildRemoteManifestCommand,
    )
    .command(
      "publish-local <file>",
      "Generate an app manifest, using a file:/// url",
      (yargs: Argv) => {
        return yargs
          .positional("file", {
            describe: "Path to the app source file (relative to package root)",
            type: "string",
            demandOption: true,
          })
          .option("path", {
            type: "string",
            description: "Custom path to use in manifest (overrides default file:/// path)",
          })
      },
      buildManifestCommand,
    )
    .command(
      "launch <manifest>",
      "Start app runtime from a manifest file",
      (yargs: Argv) => {
        return yargs
          .positional("manifest", {
            describe: "Manifest identifier (path, file:/// or http/https URL)",
            type: "string",
            demandOption: true,
          })
          .option("port", {
            alias: "p",
            type: "number",
            description: "Port for the worker HTTP server",
            default: 3001,
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
      "[Internal] Start app runtime with workerd directly",
      (yargs: Argv) => {
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
      },
      startWorkerCommand,
    )
    .command(
      "build-app [file]",
      "[Internal] Build the app bundle (app.js)",
      (yargs: Argv) => {
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
