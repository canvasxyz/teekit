import test from "ava"
import { registerTestLogging } from "./setup-logging.js"
import { mkdtempSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { fileURLToPath } from "url"

import { buildKettleApp, buildKettleExternals } from "../server/index.js"

registerTestLogging(test)

test.serial("build worker", async (t) => {
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
})
