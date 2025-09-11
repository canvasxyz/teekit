import { EventEmitter } from "events"
import { Server as MockSocketServer, WebSocket as MockSocketWebSocket } from "mock-socket"

// NOTE: The previous custom mocks are intentionally commented out in favor of mock-socket-based implementations below.
// export class ServerRAMockWebSocket extends EventEmitter { /* ...custom mock... */ }
// export class ServerRAMockWebSocketServer extends EventEmitter { /* ...custom mock server... */ }

export class NewServerRAMockWebSocket extends EventEmitter {
  public readonly CONNECTING = 0
  public readonly OPEN = 1
  public readonly CLOSING = 2
  public readonly CLOSED = 3

  public readyState = this.CONNECTING

  private serverSocket: MockSocketWebSocket | null = null
  private clientSocket: MockSocketWebSocket | null = null

  private onSendToClient: (data: string | Buffer) => void
  private onCloseToClient: (code?: number, reason?: string) => void

  constructor(
    onSendToClient: (data: string | Buffer) => void,
    onCloseToClient: (code?: number, reason?: string) => void,
  ) {
    super()
    this.onSendToClient = onSendToClient
    this.onCloseToClient = onCloseToClient
  }

  // Called by NewServerRAMockWebSocketServer when pairing sockets
  attachServerSocket(serverSocket: MockSocketWebSocket, clientSocket: MockSocketWebSocket): void {
    this.serverSocket = serverSocket
    this.clientSocket = clientSocket
    this.readyState = this.OPEN

    // Application -> Remote: when app sends using this wrapper, we intercept in send()
    // Remote -> Application: forward messages arriving on server socket to app listeners
    this.serverSocket.addEventListener("message", (evt: any) => {
      const data = (evt && (evt.data ?? evt)) as any
      const payload = typeof data === "string" ? data : Buffer.from(data as any)
      if (this.readyState === this.OPEN) {
        this.emit("message", payload as any)
      }
    })

    // When the server-side socket is closed, notify app listeners
    this.serverSocket.addEventListener("close", (evt: any) => {
      const code = evt && typeof evt.code === "number" ? evt.code : 1000
      const reason = evt && typeof evt.reason === "string" ? evt.reason : ""
      if (this.readyState !== this.CLOSED) {
        this.readyState = this.CLOSED
        this.emit("close", code, reason)
      }
    })
  }

  // Connects the internal client socket to a given server URL
  connectTo(url: string): void {
    // Create client which will trigger a server-side connection
    this.clientSocket = new MockSocketWebSocket(url)
  }

  send(data: string | Buffer): void {
    if (this.readyState !== this.OPEN) return
    // Inform the remote client via provided callback
    this.onSendToClient(data)
    // Also forward through the mock server socket for completeness
    try {
      this.serverSocket?.send(data as any)
    } catch {}
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) {
      return
    }
    this.readyState = this.CLOSING
    // Inform remote then close locally
    try {
      this.onCloseToClient(code, reason)
    } catch {}
    try {
      this.serverSocket?.close()
    } catch {}
    this.emitClose(code, reason)
  }

  // Methods used by RA to inject events from client
  emitMessage(data: string | Buffer): void {
    if (this.readyState !== this.OPEN) return
    try {
      // Route via client side to trigger server-side "message"
      this.clientSocket?.send(data as any)
    } catch {
      // Fallback: emit directly
      const payload = typeof data === "string" ? data : Buffer.from(data)
      this.emit("message", payload as any)
    }
  }

  emitClose(code?: number, reason?: string): void {
    if (this.readyState === this.CLOSED) return
    try {
      this.clientSocket?.close()
    } catch {}
    this.readyState = this.CLOSED
    this.emit("close", code ?? 1000, reason ?? "")
  }
}

export class NewServerRAMockWebSocketServer extends EventEmitter {
  public clients: Set<NewServerRAMockWebSocket> = new Set()

  private server: MockSocketServer
  private url: string
  private pendingWrappers: NewServerRAMockWebSocket[] = []

  constructor() {
    super()
    // Use a unique URL namespace per instance
    const uid = Math.random().toString(36).slice(2)
    this.url = `ws://ra-mock/${uid}`
    this.server = new MockSocketServer(this.url)

    this.server.on("connection", (serverSocket: any) => {
      // Pair with the next pending wrapper added by addClient()
      const wrapper = this.pendingWrappers.shift()
      if (!wrapper) {
        try {
          serverSocket.close()
        } catch {}
        return
      }
      // Ensure wrapper has a client socket created
      if (!wrapper["clientSocket"]) {
        // Should not happen, but ensure a client exists
        try {
          ;(wrapper as any).connectTo(this.url)
        } catch {}
      }
      wrapper.attachServerSocket(serverSocket, (wrapper as any).clientSocket)
      this.clients.add(wrapper)
      this.emit("connection", wrapper)
    })
  }

  addClient(ws: NewServerRAMockWebSocket): void {
    this.pendingWrappers.push(ws)
    // Trigger a connection by connecting the internal client
    ws.connectTo(this.url)
  }

  deleteClient(ws: NewServerRAMockWebSocket): void {
    this.clients.delete(ws)
  }

  close(cb?: () => void): void {
    try {
      for (const ws of Array.from(this.clients)) {
        try {
          ws.close(1000, "server closing")
        } catch {}
      }
      this.clients.clear()
      try {
        this.server.stop()
      } catch {}
    } finally {
      if (cb) cb()
    }
  }
}
