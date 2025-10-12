import test from "ava"
import chalk from "chalk"
import { spawn, ChildProcess } from "child_process"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

async function waitForServer(port: number, timeout = 15000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`http://localhost:${port}/uptime`)
      if (response.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("server did not start")
}

function kill(proc: ChildProcess | null) {
  return new Promise<void>((resolve) => {
    if (!proc) return resolve()
    try {
      // Kill entire process group if possible to ensure sqld/workerd children exit
      if (proc.pid) {
        try {
          process.kill(-proc.pid, "SIGKILL" as any)
        } catch {}
      }
      proc.kill("SIGKILL")
    } catch {}
    setTimeout(() => resolve(), 300)
  })
}

function parseEnvFromStdout(buf: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of buf.split(/\r?\n/)) {
    const m = line.match(/^(WORKERD_PORT|DB_URL|DB_TOKEN)=(.+)$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

test.serial("sqlite: create, update, persist between runs", async (t) => {
  let demo1: ChildProcess | null = null
  let demo2: ChildProcess | null = null
  let logs = ""

  try {
    const baseDir = mkdtempSync(join(tmpdir(), "teekit-runtime-test-"))

    demo1 = spawn("npm", ["run", "demo"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "inherit"],
      detached: true,
      env: { ...process.env, RUNTIME_DB_DIR: baseDir },
    })
    demo1.stdout!.on("data", (d) => {
      process.stdout.write(chalk.greenBright(String(d)))
      logs += String(d)
    })

    // Wait until we see WORKERD_PORT and DB_*
    const env1 = await new Promise<Record<string, string>>(
      (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), 20000)
        const check = () => {
          const e = parseEnvFromStdout(logs)
          if (e.WORKERD_PORT && e.DB_URL && e.DB_TOKEN) {
            clearTimeout(timeout)
            resolve(e)
          } else setTimeout(check, 100)
        }
        check()
      },
    )

    const port = Number(env1.WORKERD_PORT)
    await waitForServer(port)

    // test other requests
    let resp = await fetch(`http://localhost:${port}/increment`, {
      method: "POST",
    })
    t.is(resp.status, 200)

    // init
    resp = await fetch(`http://localhost:${port}/db/init`, {
      method: "POST",
    })
    t.is(resp.status, 200)

    // put value
    resp = await fetch(`http://localhost:${port}/db/put`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "foo", value: "bar" }),
    })
    t.is(resp.status, 200)

    // get value
    resp = await fetch(`http://localhost:${port}/db/get?key=foo`)
    t.is(resp.status, 200)
    let data: any = await resp.json()
    t.is(data.value, "bar")

    // Shutdown first run
    await kill(demo1)
    demo1 = null

    // Start second run (new temp DB path); validate DB usable again
    demo2 = spawn("npm", ["run", "demo"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "inherit"],
      detached: true,
      env: { ...process.env, RUNTIME_DB_DIR: baseDir },
    })

    let logs2 = ""
    demo2.stdout!.on("data", (d) => {
      process.stdout.write(chalk.greenBright(String(d)))
      logs2 += String(d)
    })
    const env2 = await new Promise<Record<string, string>>(
      (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout2")), 20000)
        const check = () => {
          const e = parseEnvFromStdout(logs2)
          if (e.WORKERD_PORT && e.DB_URL && e.DB_TOKEN) {
            clearTimeout(timeout)
            resolve(e)
          } else setTimeout(check, 100)
        }
        check()
      },
    )
    const port2 = Number(env2.WORKERD_PORT)
    await waitForServer(port2)

    // DB init on new run (idempotent) and verify persistence of previous key
    resp = await fetch(`http://localhost:${port2}/db/init`, {
      method: "POST",
    })
    t.is(resp.status, 200)
    resp = await fetch(`http://localhost:${port2}/db/get?key=foo`)
    t.is(resp.status, 200)
    data = await resp.json()
    t.is(data.value, "bar")
  } finally {
    await kill(demo1)
    await kill(demo2)
  }
})
