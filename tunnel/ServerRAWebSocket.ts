import { EventEmitter } from "events"
import { Server as MockServer, WebSocket as MockWebSocket } from "mock-socket"

// NOTE: The legacy custom mocks are intentionally commented out in favor of mock-socket.
//
// export class ServerRAMockWebSocket extends EventEmitter { /* ...legacy implementation... */ }
// export class ServerRAMockWebSocketServer extends EventEmitter { /* ...legacy implementation... */ }

/**
 * New mock-socket-based WebSocketServer exposed to application code.
 * Provides a Node ws-like interface with a `clients` Set and `on('connection', ...)`.
 */
export class NewServerRAMockWebSocketServer {
  public readonly url: string
  private readonly server: MockServer
  public readonly clients: Set<any> = new Set()

  constructor(url?: string) {
    // Use a unique in-memory URL if not provided
    this.url = url ?? `ws://ra-mock-${Math.random().toString(36).slice(2)}`
    const previousGlobalWebSocket = (globalThis as any).WebSocket
    this.server = new MockServer(this.url)
    // Restore any pre-existing global WebSocket to avoid intercepting real sockets
    try {
      ;(globalThis as any).WebSocket = previousGlobalWebSocket
    } catch {}

    // Track connected clients for app-level broadcasting
    this.server.on("connection", (socket: any) => {
      this.clients.add(socket)
      try {
        socket.on("close", () => {
          this.clients.delete(socket)
        })
      } catch {}
    })
  }

  on(event: string, listener: (...args: any[]) => void): this {
    // Forward event subscription to underlying mock-socket server
    ;(this.server as any).on(event, listener)
    return this
  }

  off(event: string, listener: (...args: any[]) => void): this {
    ;(this.server as any).off?.(event, listener)
    return this
  }

  close(cb?: () => void): void {
    try {
      // Close all clients first so application sees close events
      for (const client of Array.from(this.clients)) {
        try {
          client.close(1000, "server closing")
        } catch {}
      }
      this.clients.clear()
    } finally {
      try {
        this.server.stop({ immediate: true } as any)
      } catch {}
      if (cb) cb()
    }
  }
}

/**
 * New mock-socket-based WebSocket used internally by RA to bridge
 * tunnel messages to the application server via the in-memory server.
 */
export class NewServerRAMockWebSocket {
  private readonly socket: MockWebSocket
  private readonly pendingSends: Array<string | ArrayBuffer | Buffer> = []

  constructor(
    url: string,
    onAppSend: (data: string | Buffer) => void,
    onAppClose: (code?: number, reason?: string) => void,
  ) {
    this.socket = new MockWebSocket(url)

    ;(this.socket as any).onopen = () => {
      // Flush any queued messages from remote to application once open
      try {
        for (const item of this.pendingSends.splice(0)) {
          this.socket.send(item as any)
        }
      } catch {}
    }

    // Application -> Client path: The app calls serverSocket.send(data),
    // which is received by this client as a message event.
    ;(this.socket as any).onmessage = (event: any) => {
      const data: any = event?.data
      if (typeof data === "string") {
        onAppSend(data)
      } else if (data instanceof ArrayBuffer) {
        onAppSend(Buffer.from(new Uint8Array(data)))
      } else if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(data)) {
        onAppSend(data as Buffer)
      } else {
        try {
          onAppSend(String(data))
        } catch {
          onAppSend("")
        }
      }
    }

    // Application -> Client close path: When the app closes the server-side
    // socket, the client observes a close event.
    ;(this.socket as any).onclose = (event: any) => {
      const code = event?.code as number | undefined
      const reason = event?.reason as string | undefined
      onAppClose(code, reason)
    }
  }

  /** Remote -> Application: deliver a message to the app. */
  public deliverToApplication(data: string | Buffer): void {
    const payload: string | Buffer = typeof data === "string" ? data : data
    if ((this.socket as any).readyState === 1) {
      this.socket.send(payload as any)
    } else {
      this.pendingSends.push(payload)
    }
  }

  /** Remote -> Application: close the connection visible to the app. */
  public closeApplicationView(code?: number, reason?: string): void {
    ;(this.socket as any).close(code, reason)
  }
}
