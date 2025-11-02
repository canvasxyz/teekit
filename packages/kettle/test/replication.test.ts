import test from "ava"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startWorker } from "../server/startWorker.js"
import { findFreePort, waitForPortOpen } from "../server/utils.js"
import { createClient } from "@libsql/client"
import { fileURLToPath } from "url"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test.serial("replicate data persists across restarts", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "kettle-replication-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const replicaDbPath = join(baseDir, "app.replica.db")
  const bundleDir = join(fileURLToPath(new URL("..", import.meta.url)), "dist")

  let kettle1: Awaited<ReturnType<typeof startWorker>> | null = null
  let kettle2: Awaited<ReturnType<typeof startWorker>> | null = null

  t.teardown(async () => {
    if (kettle1) {
      await kettle1.stop()
      kettle1 = null
    }
    if (kettle2) {
      await kettle2.stop()
      kettle2 = null
    }
    await wait(500)
  })

  const waitForReady = async (port: number) => {
    await waitForPortOpen(port)
    for (let i = 0; i < 10; i++) {
      const response = await fetch(`http://localhost:${port}/healthz`)
      if (response.ok) return
      await wait(100)
    }
    throw new Error(`worker on port ${port} did not become healthy`)
  }

  const startAndReady = async () => {
    const instance = await startWorker({
      dbPath,
      replicaDbPath,
      sqldPort: await findFreePort(),
      workerPort: await findFreePort(),
      quoteServicePort: await findFreePort(),
      bundleDir,
    })
    await waitForReady(instance.workerPort)
    return instance
  }

  kettle1 = await startAndReady()
  const port1 = kettle1.workerPort

  let resp = await fetch(`http://localhost:${port1}/increment`, {
    method: "POST",
  })
  t.is(resp.status, 200, "increment should succeed")

  resp = await fetch(`http://localhost:${port1}/db/init`, {
    method: "POST",
  })
  t.is(resp.status, 200, "db/init should succeed")

  resp = await fetch(`http://localhost:${port1}/db/put`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "foo", value: "bar" }),
  })
  t.is(resp.status, 200, "db/put should succeed")

  resp = await fetch(`http://localhost:${port1}/db/get?key=foo`)
  t.is(resp.status, 200, "db/get should succeed")
  let data = await resp.json()
  t.is(data.value, "bar", "value should match what was written")

  await wait(2000)

  t.truthy(kettle1.replicaDbUrl, "replica DB URL should be available")
  const replicaClient1 = createClient({
    url: kettle1.replicaDbUrl!,
    authToken: kettle1.dbToken,
  })

  const tables1 = await replicaClient1.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='kv'",
  )
  t.truthy(tables1.rows.length > 0, "kv table should exist in replica")

  const result1 = await replicaClient1.execute({
    sql: "SELECT value FROM kv WHERE key = ?1",
    args: ["foo"],
  })
  t.truthy(result1.rows.length > 0, "replica should contain the written data")
  const replicaValue1 =
    result1.rows[0].value ?? Object.values(result1.rows[0])[0]
  t.is(replicaValue1, "bar", "replica should contain the correct value")

  await kettle1.stop()
  kettle1 = null
  await wait(1000)

  kettle2 = await startAndReady()
  const port2 = kettle2.workerPort

  resp = await fetch(`http://localhost:${port2}/db/init`, {
    method: "POST",
  })
  t.is(resp.status, 200, "db/init should succeed after restart")

  resp = await fetch(`http://localhost:${port2}/db/get?key=foo`)
  t.is(resp.status, 200, "db/get should succeed after restart")
  data = await resp.json()
  t.is(
    data.value,
    "bar",
    "value should persist across primary restarts",
  )

  await wait(2000)

  t.truthy(
    kettle2.replicaDbUrl,
    "replica DB URL should be available after restart",
  )
  const replicaClient2 = createClient({
    url: kettle2.replicaDbUrl!,
    authToken: kettle2.dbToken,
  })

  const tables2 = await replicaClient2.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='kv'",
  )
  t.truthy(tables2.rows.length > 0, "kv table should exist in replica after restart")

  const result2 = await replicaClient2.execute({
    sql: "SELECT value FROM kv WHERE key = ?1",
    args: ["foo"],
  })
  t.truthy(
    result2.rows.length > 0,
    "replica should contain persisted data after restart",
  )
  const replicaValue2 =
    result2.rows[0].value ?? Object.values(result2.rows[0])[0]
  t.is(replicaValue2, "bar", "replica should preserve data across restarts")
})

test.skip("replicate data written to primary with encryption", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "kettle-replication-encrypted-"))
  const dbPath = join(baseDir, "app.sqlite")
  const replicaDbPath = join(baseDir, "app.replica.db")
  const encryptionKey = "test-encryption-key"

  const kettle = await startWorker({
    dbPath,
    replicaDbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    encryptionKey,
    bundleDir: join(fileURLToPath(new URL("..", import.meta.url)), "dist"),
  })

  t.teardown(async () => {
    await kettle.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
  })

  const port = kettle.workerPort
  await waitForPortOpen(port)

  // Wait for health check
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`http://localhost:${port}/healthz`)
    if (r.ok) break
    await new Promise((r) => setTimeout(r, 100))
  }

  // Initialize the database table
  let resp = await fetch(`http://localhost:${port}/db/init`, {
    method: "POST",
  })
  t.is(resp.status, 200, "db/init should succeed")

  // Write data to primary via the API
  resp = await fetch(`http://localhost:${port}/db/put`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "test-key", value: "test-value" }),
  })
  t.is(resp.status, 200, "db/put should succeed")

  // Verify data can be read from primary via API
  resp = await fetch(`http://localhost:${port}/db/get?key=test-key`)
  t.is(resp.status, 200, "db/get should succeed")
  const data = await resp.json()
  t.is(data.value, "test-value", "value should match what was written")

  // Give replication time to sync
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // Now examine the replica database via HTTP
  t.truthy(kettle.replicaDbUrl, "replica DB URL should be available")
  const replicaClient = createClient({
    url: kettle.replicaDbUrl!,
    authToken: kettle.dbToken,
    encryptionKey,
  })

  // Verify the table exists in the replica
  const tables = await replicaClient.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='kv'",
  )
  t.truthy(tables.rows.length > 0, "kv table should exist in replica")

  // Verify the data exists in the replica
  const result = await replicaClient.execute({
    sql: "SELECT value FROM kv WHERE key = ?1",
    args: ["test-key"],
  })

  t.truthy(result.rows.length > 0, "replica should contain the written data")
  const replicaValue = result.rows[0].value ?? Object.values(result.rows[0])[0]
  t.is(replicaValue, "test-value", "replica should contain the correct value")
})
