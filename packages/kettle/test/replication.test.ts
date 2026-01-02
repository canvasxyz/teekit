import test from "ava"
import { join } from "path"
import { startWorker } from "../src/startWorker.js"
import { findFreePort, waitForPortOpen } from "../src/utils.js"
import { fileURLToPath } from "url"

/**
 * Tests for Durable Objects SQLite storage.
 *
 * Note: DO SQLite uses local disk storage but with a fresh temp directory
 * per worker instance, so data does NOT persist between restarts.
 * These tests verify basic database CRUD operations work correctly.
 */

test.serial("database operations work via DO SQLite", async (t) => {
  t.timeout(60000)
  let worker: { stop: () => Promise<void>; workerPort: number } | null = null

  t.teardown(async () => {
    if (worker) await worker.stop()
    await new Promise((resolve) => setTimeout(resolve, 500))
  })

  // Start worker with DO SQLite storage
  const kettle = await startWorker({
    workerPort: await findFreePort(),
    quoteServicePort: await findFreePort(),
    bundleDir: join(fileURLToPath(new URL("..", import.meta.url)), "dist"),
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  worker = { stop: kettle.stop, workerPort: kettle.workerPort }
  const port = kettle.workerPort
  await waitForPortOpen(port)

  // Wait for health check
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`http://localhost:${port}/healthz`)
    if (r.ok) break
    await new Promise((r) => setTimeout(r, 100))
  }

  // Test increment endpoint (uses in-memory counter)
  let resp = await fetch(`http://localhost:${port}/increment`, {
    method: "POST",
  })
  t.is(resp.status, 200)

  // Initialize the database table
  resp = await fetch(`http://localhost:${port}/db/init`, {
    method: "POST",
  })
  t.is(resp.status, 200, "db/init should succeed")

  // Write data to database via the API
  resp = await fetch(`http://localhost:${port}/db/put`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "foo", value: "bar" }),
  })
  t.is(resp.status, 200, "db/put should succeed")

  // Verify data can be read via API
  resp = await fetch(`http://localhost:${port}/db/get?key=foo`)
  t.is(resp.status, 200, "db/get should succeed")
  const data = await resp.json()
  t.is(data.value, "bar", "retrieved value should match")

  // Write another value
  resp = await fetch(`http://localhost:${port}/db/put`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "baz", value: "qux" }),
  })
  t.is(resp.status, 200)

  // Verify both values exist
  resp = await fetch(`http://localhost:${port}/db/get?key=baz`)
  t.is(resp.status, 200)
  const data2 = await resp.json()
  t.is(data2.value, "qux")

  // Update existing value
  resp = await fetch(`http://localhost:${port}/db/put`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "foo", value: "updated" }),
  })
  t.is(resp.status, 200)

  // Verify updated value
  resp = await fetch(`http://localhost:${port}/db/get?key=foo`)
  t.is(resp.status, 200)
  const data3 = await resp.json()
  t.is(data3.value, "updated", "value should be updated")

  // Test non-existent key
  resp = await fetch(`http://localhost:${port}/db/get?key=nonexistent`)
  t.is(resp.status, 404, "should return 404 for non-existent key")
})
