import test from "ava"
import { mkdtempSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { fileURLToPath } from "url"

import { buildKettleApp, buildKettleExternals } from "../server/index.js"
import { logWithTimestamp } from "./helpers.js"

test.serial("build worker", async (t) => {
  logWithTimestamp("Test: build worker - START")
  const subpackageDir = fileURLToPath(new URL("..", import.meta.url))
  const targetDir = mkdtempSync(join(tmpdir(), "kettle-build-test"))

  await buildKettleApp({
    source: join(subpackageDir, "app.ts"),
    targetDir,
  })
  await buildKettleExternals({ targetDir })

  t.true(existsSync(join(targetDir, "app.js")))
  t.true(existsSync(join(targetDir, "worker.js")))
  t.true(existsSync(join(targetDir, "externals.js")))
  logWithTimestamp("Test: build worker - END")
})
