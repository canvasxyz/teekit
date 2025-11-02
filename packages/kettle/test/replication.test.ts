import test from "ava"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startWorker } from "../server/startWorker.js"
import { findFreePort, waitForPortOpen } from "../server/utils.js"
import { createClient } from "@libsql/client"
import { fileURLToPath } from "url"
import { logWithTimestamp, checkWhyNodeRunning } from "./helpers.js"

test.serial("replicate data written to primary", async (t) => {
  logWithTimestamp("Test: replicate data written to primary - START")
  const baseDir = mkdtempSync(join(tmpdir(), "kettle-replication-test-"))
  const dbPath = join(baseDir, "app.sqlite")
  const replicaDbPath = join(baseDir, "app.replica.db")

  const kettle = await startWorker({
    dbPath,
    replicaDbPath,
    sqldPort: await findFreePort(),
    workerPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    bundleDir: join(fileURLToPath(new URL("..", import.meta.url)), "dist"),
  })

  t.teardown(async () => {
    logWithTimestamp("replication.test.ts: teardown - Starting cleanup")
    await kettle.stop()
    logWithTimestamp("replication.test.ts: teardown - Kettle stopped")
    await new Promise((resolve) => setTimeout(resolve, 500))
    logWithTimestamp("replication.test.ts: teardown - Cleanup complete")
    await checkWhyNodeRunning()
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
  logWithTimestamp("Test: replicate data written to primary - END")
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
