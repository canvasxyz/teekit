import test from "ava"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startWorker } from "../server/server.js"
import { findFreePortNear, waitForPortOpen } from "../server/utils.js"
import { createClient } from "@libsql/client"

test.serial(
  "replication: data written to primary is replicated to replica db",
  async (t) => {
    const baseDir = mkdtempSync(join(tmpdir(), "teekit-replication-test-"))
    const dbPath = join(baseDir, "app.sqlite")
    const replicaDbPath = join(baseDir, "app.replica.db")

    const runtime = await startWorker({
      dbPath,
      replicaDbPath,
      sqldPort: await findFreePortNear(8088),
      workerPort: await findFreePortNear(3001),
    })

    t.teardown(async () => {
      await runtime.stop()
      await new Promise((resolve) => setTimeout(resolve, 500))
    })

    const port = runtime.workerPort
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
    t.truthy(runtime.replicaDbUrl, "replica DB URL should be available")
    const replicaClient = createClient({
      url: runtime.replicaDbUrl!,
      authToken: runtime.dbToken,
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
    const replicaValue =
      (result.rows[0] as any).value ?? Object.values(result.rows[0])[0]
    t.is(replicaValue, "test-value", "replica should contain the correct value")
  },
)
