import { SimpleEventEmitter } from "./SimpleEventEmitter.js"

// Event types for ServerRAMockWebSocket
interface ServerRAMockWebSocketEvents {
  message: [data: string | Uint8Array]
  close: [code: number, reason: string]
  [event: string]: any[] // Allow additional events
}

// Mock WebSocket exposed to applications
export class ServerRAMockWebSocket extends SimpleEventEmitter<ServerRAMockWebSocketEvents> {
  public readonly CONNECTING = 0
  public readonly OPEN = 1
  public readonly CLOSING = 2
  public readonly CLOSED = 3

  public readyState = this.OPEN

  private onSendToClient: (data: string | Uint8Array) => void
  private onCloseToClient: (code?: number, reason?: string) => void

  constructor(
    onSendToClient: (data: string | Uint8Array) => void,
    onCloseToClient: (code?: number, reason?: string) => void,
  ) {
    super()
    this.onSendToClient = onSendToClient
    this.onCloseToClient = onCloseToClient
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== this.OPEN) return
    this.onSendToClient(data)
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) {
      return
    }
    this.readyState = this.CLOSING
    // Inform client then mark closed locally
    this.onCloseToClient(code, reason)
    this.emitClose(code, reason)
  }

  // Methods used by RA to inject events from client
  emitMessage(data: string | Uint8Array): void {
    if (this.readyState !== this.OPEN) return
    const payload = typeof data === "string" ? data : data
    this.emit("message", payload)
  }

  emitClose(code?: number, reason?: string): void {
    if (this.readyState === this.CLOSED) return
    this.readyState = this.CLOSED
    this.emit("close", code ?? 1000, reason ?? "")
  }

  public emit(eventName: string | symbol, ...args: any[]): boolean {
    return super.emit(eventName, ...args)
  }
}

// Event types for ServerRAMockWebSocketServer
interface ServerRAMockWebSocketServerEvents {
  connection: [ws: ServerRAMockWebSocket]
  [event: string]: any[] // Allow additional events
}

// Mock WebSocketServer exposed to application code
export class ServerRAMockWebSocketServer extends SimpleEventEmitter<ServerRAMockWebSocketServerEvents> {
  public clients: Set<ServerRAMockWebSocket> = new Set()

  addClient(ws: ServerRAMockWebSocket): void {
    this.clients.add(ws)
    this.emit("connection", ws)
  }

  deleteClient(ws: ServerRAMockWebSocket): void {
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
    } finally {
      if (cb) cb()
    }
  }
}
