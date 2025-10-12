import test from "ava"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startWorker } from "../server/start.js"
import { waitForPortOpen } from "../server/utils.js"

test.serial("sqlite: create, update, persist between runs", async (t) => {
  let demo1: { stop: () => void; workerPort: number } | null = null
  let demo2: { stop: () => void; workerPort: number } | null = null

  t.teardown(() => {
    if (demo1) demo1.stop()
    if (demo2) demo2.stop()
  })

  const baseDir = mkdtempSync(join(tmpdir(), "teekit-runtime-test-"))

  const runtime1 = await startWorker({ baseDir, logEnv: true })
  demo1 = { stop: runtime1.stop, workerPort: runtime1.workerPort }
  const port = runtime1.workerPort
  await waitForPortOpen(port)

  // test other requests
  let resp = await fetch(`http://localhost:${port}/increment`, {
    method: "POST",
  })
  t.is(resp.status, 200)

  resp = await fetch(`http://localhost:${port}/db/init`, {
    method: "POST",
  })
  t.is(resp.status, 200)

  resp = await fetch(`http://localhost:${port}/db/put`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "foo", value: "bar" }),
  })
  t.is(resp.status, 200)

  resp = await fetch(`http://localhost:${port}/db/get?key=foo`)
  t.is(resp.status, 200)
  let data: any = await resp.json()
  t.is(data.value, "bar")

  if (demo1) demo1.stop()
  demo1 = null

  // Second run to verify persistence of previous key
  const runtime2 = await startWorker({ baseDir, logEnv: true })
  demo2 = { stop: runtime2.stop, workerPort: runtime2.workerPort }
  const port2 = runtime2.workerPort
  await waitForPortOpen(port2)

  resp = await fetch(`http://localhost:${port2}/db/init`, {
    method: "POST",
  })
  t.is(resp.status, 200)
  resp = await fetch(`http://localhost:${port2}/db/get?key=foo`)
  t.is(resp.status, 200)
  data = await resp.json()
  t.is(data.value, "bar")
})
