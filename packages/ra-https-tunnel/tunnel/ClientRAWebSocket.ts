import {
  RAEncryptedClientConnectEvent,
  RAEncryptedWSMessage,
  RAEncryptedClientCloseEvent,
  RAEncryptedServerEvent,
} from "./types.js"
import { RA } from "./client.js"
import {
  generateConnectionId,
  getOriginPort,
  toArrayBuffer,
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from "./utils/client.js"

export class ClientRAMockWebSocket extends EventTarget {
  public readonly CONNECTING = 0
  public readonly OPEN = 1
  public readonly CLOSING = 2
  public readonly CLOSED = 3

  public connectionId: string
  public url: string
  public protocol: string = ""
  public readyState: number = this.CONNECTING
  public bufferedAmount: number = 0
  public extensions: string = ""
  public binaryType: BinaryType = "blob"

  public onopen: ((this: WebSocket, ev: Event) => any) | null = null
  public onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null
  public onmessage: ((this: WebSocket, ev: MessageEvent) => any) | null = null
  public onerror: ((this: WebSocket, ev: Event) => any) | null = null

  private ra: RA
  private messageQueue: string[] = []

  constructor(ra: RA, url: string, protocols?: string | string[]) {
    super()
    this.ra = ra
    this.url = url
    this.connectionId = generateConnectionId()

    // Register this connection with the RA instance
    ra.registerWebSocketTunnel(this)

    // Send connection request through tunnel
    this.connect(protocols)
  }

  private async connect(protocols?: string | string[]): Promise<void> {
    try {
      await this.ra.ensureConnection()

      // Enforce that client WS targets the same server port as RA origin
      const originPort = getOriginPort(this.ra.origin)
      const target = new URL(this.url)
      const targetPort = target.port
        ? Number(target.port)
        : target.protocol === "wss:" || target.protocol === "https:"
        ? 443
        : 80
      if (originPort !== targetPort) {
        throw new Error(
          `Port mismatch: RA origin port ${originPort} != target port ${targetPort}`,
        )
      }

      const protocolArray = protocols
        ? Array.isArray(protocols)
          ? protocols
          : [protocols]
        : undefined

      const connectMessage: RAEncryptedClientConnectEvent = {
        type: "ws_connect",
        connectionId: this.connectionId,
        url: this.url,
        protocols: protocolArray,
      }

      if (this.ra.ws && this.ra.ws.readyState === WebSocket.OPEN) {
        this.ra.send(connectMessage)
      } else {
        throw new Error("Tunnel WebSocket not connected")
      }
    } catch (error) {
      this.handleError(
        error instanceof Error ? error.message : "Connection failed",
      )
    }
  }

  public send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState === this.CONNECTING) {
      // Queue messages until connection is open
      if (typeof data === "string") {
        this.messageQueue.push(data)
      } else {
        // Convert binary data to base64 for queueing
        const arrayBuffer = toArrayBuffer(data)
        const base64 = arrayBufferToBase64(arrayBuffer)
        this.messageQueue.push(`binary:${base64}`)
      }
      return
    }

    if (this.readyState !== this.OPEN) {
      throw new Error("WebSocket is not open")
    }

    let messageData: string
    let dataType: "string" | "arraybuffer"

    if (typeof data === "string") {
      messageData = data
      dataType = "string"
    } else {
      // Convert binary data to base64 for transport
      const arrayBuffer = toArrayBuffer(data)
      messageData = arrayBufferToBase64(arrayBuffer)
      dataType = "arraybuffer"
    }

    const message: RAEncryptedWSMessage = {
      type: "ws_message",
      connectionId: this.connectionId,
      data: messageData,
      dataType: dataType,
    }

    try {
      if (this.ra.ws && this.ra.ws.readyState === WebSocket.OPEN) {
        this.ra.send(message)
        this.bufferedAmount += String(data).length
      } else {
        throw new Error("Tunnel WebSocket not connected")
      }
    } catch (error) {
      this.handleError(error instanceof Error ? error.message : "Send failed")
    }
  }

  public close(code?: number, reason?: string): void {
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) {
      return
    }

    this.readyState = this.CLOSING

    const closeMessage: RAEncryptedClientCloseEvent = {
      type: "ws_close",
      connectionId: this.connectionId,
      code,
      reason,
    }

    try {
      if (this.ra.ws && this.ra.ws.readyState === WebSocket.OPEN) {
        this.ra.send(closeMessage)
      }
    } catch (error) {
      console.error("Error sending close message:", error)
    }

    // Clean up
    this.ra.unregisterWebSocketTunnel(this.connectionId)
  }

  // Handle events from the tunnel
  public handleTunnelEvent(event: RAEncryptedServerEvent): void {
    switch (event.eventType) {
      case "open":
        this.readyState = this.OPEN
        this.bufferedAmount = 0

        // Send any queued messages
        while (this.messageQueue.length > 0) {
          const queuedData = this.messageQueue.shift()!
          if (queuedData.startsWith("binary:")) {
            // Decode base64 back to ArrayBuffer
            const base64 = queuedData.substring(7)
            const arrayBuffer = base64ToArrayBuffer(base64)
            this.send(arrayBuffer)
          } else {
            this.send(queuedData)
          }
        }

        const openEvent = new Event("open")
        this.dispatchEvent(openEvent)
        if (this.onopen) {
          this.onopen.call(this as any, openEvent)
        }
        break

      case "close":
        this.readyState = this.CLOSED
        const closeEvent = new CloseEvent("close", {
          code: event.code || 1000,
          reason: event.reason || "",
          wasClean: true,
        })
        this.dispatchEvent(closeEvent)
        if (this.onclose) {
          this.onclose.call(this as any, closeEvent)
        }
        this.ra.unregisterWebSocketTunnel(this.connectionId)
        break

      case "error":
        this.handleError(event.error || "WebSocket error")
        break
    }
  }

  public handleTunnelMessage(message: RAEncryptedWSMessage): void {
    let messageData: any
    if (message.dataType === "arraybuffer") {
      messageData = base64ToArrayBuffer(message.data)
    } else {
      messageData = message.data
    }

    const messageEvent = new MessageEvent("message", {
      data: messageData,
    })

    this.dispatchEvent(messageEvent)
    if (this.onmessage) {
      this.onmessage.call(this as any, messageEvent)
    }
  }

  private handleError(errorMessage: string): void {
    const errorEvent = new Event("error")
    ;(errorEvent as any).message = errorMessage

    this.dispatchEvent(errorEvent)
    if (this.onerror) {
      this.onerror.call(this as any, errorEvent)
    }
  }

  // helpers are imported from utils.ts
}
