import net from "net"
import { existsSync } from "fs"
import { ChildProcess } from "child_process"

export function randomToken(len = 48): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Buffer.from(bytes).toString("base64url")
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
