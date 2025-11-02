import test from "ava"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startWorker } from "../server/startWorker.js"
import { buildKettleApp, buildKettleExternals } from "../server/buildWorker.js"
import { findFreePort, waitForPortOpen } from "../server/utils.js"
import { createClient } from "@libsql/client"
import { fileURLToPath } from "url"

test.serial("replicated data persists between runs", async (t) => {
  t.timeout(60000) // 60 second timeout
  let demo1: { stop: () => Promise<void>; workerPort: number } | null = null
  let demo2: { stop: () => Promise<void>; workerPort: number } | null = null

  t.teardown(async () => {
    if (demo1) await demo1.stop()
    if (demo2) await demo2.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
  })

  // Build the bundle before starting workers
  const projectDir = fileURLToPath(new URL("..", import.meta.url))
  const bundleDir = join(projectDir, "dist")
  await buildKettleApp({
    source: join(projectDir, "app.ts"),
    targetDir: bundleDir,
  })
  await buildKettleExternals({
    sourceDir: projectDir,
    targetDir: bundleDir,
  })

  const baseDir = mkdtempSync(join(tmpdir(), "kettle-replication-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const replicaDbPath = join(baseDir, "app.replica.db")

  // First run: create, update, and replicate
  const kettle1 = await startWorker({
    dbPath,
    replicaDbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    bundleDir,
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  demo1 = { stop: kettle1.stop, workerPort: kettle1.workerPort }
  const port = kettle1.workerPort
  await waitForPortOpen(port)

  // Probe readiness of worker + DB
  let healthOk = false
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/healthz`)
      if (r.ok) {
        healthOk = true
        break
      }
    } catch (e) {
      // Connection error, retry
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  t.truthy(healthOk, "worker should be healthy")

  // Test increment endpoint
  let resp = await fetch(`http://localhost:${port}/increment`, {
    method: "POST",
  })
  t.is(resp.status, 200)

  // Initialize the database table
  resp = await fetch(`http://localhost:${port}/db/init`, {
    method: "POST",
  })
  t.is(resp.status, 200)

  // Write data to primary via the API
  resp = await fetch(`http://localhost:${port}/db/put`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "foo", value: "bar" }),
  })
  t.is(resp.status, 200)

  // Verify data can be read from primary via API
  resp = await fetch(`http://localhost:${port}/db/get?key=foo`)
  t.is(resp.status, 200)
  let data = await resp.json()
  t.is(data.value, "bar")

  // Give replication time to sync
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // Now examine the replica database via HTTP
  t.truthy(kettle1.replicaDbUrl, "replica DB URL should be available")
  const replicaClient1 = createClient({
    url: kettle1.replicaDbUrl!,
    authToken: kettle1.dbToken,
  })

  // Verify the table exists in the replica
  const tables = await replicaClient1.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='kv'",
  )
  t.truthy(tables.rows.length > 0, "kv table should exist in replica")

  // Verify the data exists in the replica
  const result1 = await replicaClient1.execute({
    sql: "SELECT value FROM kv WHERE key = ?1",
    args: ["foo"],
  })

  t.truthy(result1.rows.length > 0, "replica should contain the written data")
  const replicaValue1 =
    result1.rows[0].value ?? Object.values(result1.rows[0])[0]
  t.is(replicaValue1, "bar", "replica should contain the correct value")

  // Stop the first worker
  if (demo1) await demo1.stop()
  demo1 = null

  await new Promise((resolve) => setTimeout(resolve, 1000))

  // Second run: verify persistence and replication of previous data
  const kettle2 = await startWorker({
    dbPath,
    replicaDbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    bundleDir,
  })
  demo2 = { stop: kettle2.stop, workerPort: kettle2.workerPort }
  const port2 = kettle2.workerPort
  await waitForPortOpen(port2)
  let healthOk2 = false
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`http://localhost:${port2}/healthz`)
      if (r.ok) {
        healthOk2 = true
        break
      }
    } catch (e) {
      // Connection error, retry
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  t.truthy(healthOk2, "second worker should be healthy")

  // Verify the table still exists (no need to init again)
  resp = await fetch(`http://localhost:${port2}/db/init`, {
    method: "POST",
  })
  t.is(resp.status, 200)

  // Verify persisted data from first run
  resp = await fetch(`http://localhost:${port2}/db/get?key=foo`)
  t.is(resp.status, 200)
  data = await resp.json()
  t.is(data.value, "bar", "data from first run should persist")

  // Give replication time to sync
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // Verify the persisted data exists in the replica after restart
  t.truthy(kettle2.replicaDbUrl, "replica DB URL should be available")
  const replicaClient2 = createClient({
    url: kettle2.replicaDbUrl!,
    authToken: kettle2.dbToken,
  })

  const result2 = await replicaClient2.execute({
    sql: "SELECT value FROM kv WHERE key = ?1",
    args: ["foo"],
  })

  t.truthy(
    result2.rows.length > 0,
    "replica should still contain data after restart",
  )
  const replicaValue2 =
    result2.rows[0].value ?? Object.values(result2.rows[0])[0]
  t.is(
    replicaValue2,
    "bar",
    "replica should contain the persisted value after restart",
  )
})

test.skip("replicated data persists with encryption", async (t) => {
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
