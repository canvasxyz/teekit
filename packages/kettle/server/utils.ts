import net from "net"
import { existsSync } from "fs"
import { ChildProcess } from "child_process"

export function randomToken(len = 48): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Buffer.from(bytes).toString("base64url")
}

export async function waitForPortOpen(
  port: number,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.end()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
      setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, 300)
    })
    if (connected) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Port ${port} did not open in ${timeoutMs}ms`)
}

export async function waitForPortClosed(
  port: number,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const isOpen = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.end()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
      setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, 200)
    })
    if (!isOpen) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Port ${port} did not close in ${timeoutMs}ms`)
}

export async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address === "object") {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error("Could not determine free port")))
      }
    })
  })
}

export function shutdown(child: ChildProcess, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    try {
      // Avoid keeping the event loop alive because of stdio
      ;(child.stdout as any)?.unref?.()
      ;(child.stderr as any)?.unref?.()
    } catch {}
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {}
    }, timeoutMs)

    child.once("exit", () => {
      clearTimeout(killTimer)
      resolve()
    })

    try {
      child.kill("SIGTERM")
    } catch {
      // Process might already be dead
      clearTimeout(killTimer)
      resolve()
    }
  })
}

export function resolveSqldBinary(): string {
  const candidates = [
    process.env.SQLD_BIN,
    "sqld",
    "/home/linuxbrew/.linuxbrew/bin/sqld",
    "/opt/homebrew/bin/sqld",
    "/usr/local/bin/sqld",
    "/usr/bin/sqld",
  ].filter(Boolean) as string[]
  for (const bin of candidates) {
    try {
      if (existsSync(bin)) return bin
    } catch {}
  }
  return candidates[0]!
}

export function resolveWorkerdBinary(): string {
  const cwd = process.cwd()
  const candidates = [
    process.env.WORKERD_BIN,
    // Prefer local project bin if available
    `${cwd}/node_modules/.bin/workerd`,
    // Monorepo root fallback
    `${cwd}/../node_modules/.bin/workerd`,
    `${cwd}/../../node_modules/.bin/workerd`,
    `/workspace/node_modules/.bin/workerd`,
    // Global PATH resolution
    "workerd",
  ].filter(Boolean) as string[]
  for (const bin of candidates) {
    try {
      if (existsSync(bin)) return bin
    } catch {}
  }
  return candidates[0]!
}

export function isSuppressedSqldLogs(msg: string) {
  if (
    msg.includes(
      "INFO restore: libsql_server::namespace::meta_store: restoring meta store",
    ) ||
    msg.includes(
      "INFO restore: libsql_server::namespace::meta_store: meta store restore completed",
    ) ||
    msg.includes(
      "INFO libsql_server: Server sending heartbeat to URL <not supplied> every 30s",
    ) ||
    msg.includes(
      "INFO create:try_new_primary:make_primary_connection_maker: libsql_server::replication::primary::logger: SQLite autocheckpoint: 1000",
    )
  ) {
    return true
  }
}
