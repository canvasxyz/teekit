import test from "ava"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startWorker } from "../server/server.js"
import { findFreePort, waitForPortOpen } from "../server/utils.js"

test.serial("Kettle direct: GET /uptime returns uptime data", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "kettle-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const kettle = await startWorker({
    dbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
  })
  t.teardown(async () => {
    await kettle.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
  })

  await waitForPortOpen(kettle.workerPort)
  const response = await fetch(`http://localhost:${kettle.workerPort}/uptime`)
  t.is(response.status, 200)
  const data = await response.json()
  t.truthy(data.uptime)
  t.truthy(data.uptime.formatted)
  t.regex(data.uptime.formatted, /\d+m \d+/)
})

test.serial("Kettle direct: POST /increment increments counter", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "kettle-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const kettle = await startWorker({
    dbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
  })
  t.teardown(async () => {
    await kettle.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
  })

  await waitForPortOpen(kettle.workerPort)
  const response1 = await fetch(
    `http://localhost:${kettle.workerPort}/increment`,
    { method: "POST" },
  )
  t.is(response1.status, 200)
  const data1 = await response1.json()
  const counter1 = data1.counter
  t.true(typeof counter1 === "number")
  t.true(counter1 > 0)
  const response2 = await fetch(
    `http://localhost:${kettle.workerPort}/increment`,
    { method: "POST" },
  )
  const data2 = await response2.json()
  t.is(data2.counter, counter1 + 1)
})

test.serial("Kettle direct: POST /quote returns quote data", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "kettle-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const kettle = await startWorker({
    dbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
  })
  t.teardown(async () => {
    await kettle.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
  })

  await waitForPortOpen(kettle.workerPort)
  const testPublicKey = new Array(32).fill(0).map((_, i) => i)
  const response = await fetch(`http://localhost:${kettle.workerPort}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: testPublicKey }),
  })
  t.is(response.status, 200)
  const data = await response.json()
  t.truthy(data.quote, "quote should be present")
  t.true(Array.isArray(data.quote), "quote should be an array")
  t.true(data.quote.length > 0, "quote should not be empty")
  t.true(data.quote.length > 100, "quote should be substantial in size")
})
