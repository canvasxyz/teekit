import {
  TunnelWebSocketConnect,
  TunnelWebSocketMessage,
  TunnelWebSocketClose,
  TunnelWebSocketEvent,
} from "./types.js"
import { generateConnectionId } from "./utils/client.js"

export class TunnelWebSocket extends EventTarget {
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

  private ra: any
  private messageQueue: string[] = []

  constructor(ra: any, url: string, protocols?: string | string[]) {
    super()
    this.ra = ra
    this.url = url
    this.connectionId = generateConnectionId()

    // Register this connection with the RA instance
    ra.registerWebSocketConnection(this)

    // Send connection request through tunnel
    this.connect(protocols)
  }

  private async connect(protocols?: string | string[]): Promise<void> {
    try {
      await this.ra.ensureConnection()

      const protocolArray = protocols
        ? Array.isArray(protocols)
          ? protocols
          : [protocols]
        : undefined

      const connectMessage: TunnelWebSocketConnect = {
        type: "ws_connect",
        connectionId: this.connectionId,
        url: this.url,
        protocols: protocolArray,
      }

      if (this.ra.ws && this.ra.ws.readyState === WebSocket.OPEN) {
        this.ra.ws.send(JSON.stringify(connectMessage))
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
        const arrayBuffer = this.toArrayBuffer(data)
        const base64 = this.arrayBufferToBase64(arrayBuffer)
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
      const arrayBuffer = this.toArrayBuffer(data)
      messageData = this.arrayBufferToBase64(arrayBuffer)
      dataType = "arraybuffer"
    }

    const message: TunnelWebSocketMessage = {
      type: "ws_message",
      connectionId: this.connectionId,
      data: messageData,
      dataType: dataType,
    }

    try {
      if (this.ra.ws && this.ra.ws.readyState === WebSocket.OPEN) {
        this.ra.ws.send(JSON.stringify(message))
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

    const closeMessage: TunnelWebSocketClose = {
      type: "ws_close",
      connectionId: this.connectionId,
      code,
      reason,
    }

    try {
      if (this.ra.ws && this.ra.ws.readyState === WebSocket.OPEN) {
        this.ra.ws.send(JSON.stringify(closeMessage))
      }
    } catch (error) {
      console.error("Error sending close message:", error)
    }

    // Clean up
    this.ra.unregisterWebSocketConnection(this.connectionId)
  }

  // Handle events from the tunnel
  public handleTunnelEvent(event: TunnelWebSocketEvent): void {
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
            const arrayBuffer = this.base64ToArrayBuffer(base64)
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
        this.ra.unregisterWebSocketConnection(this.connectionId)
        break

      case "error":
        this.handleError(event.error || "WebSocket error")
        break
    }
  }

  public handleTunnelMessage(message: TunnelWebSocketMessage): void {
    if (this.readyState !== this.OPEN) return

    let messageData: any
    if (message.dataType === "arraybuffer") {
      messageData = this.base64ToArrayBuffer(message.data)
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

  private toArrayBuffer(
    data: ArrayBufferLike | Blob | ArrayBufferView,
  ): ArrayBufferLike {
    if (data instanceof ArrayBuffer) {
      return data
    } else if (ArrayBuffer.isView(data)) {
      return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      )
    } else {
      throw new Error("Blob data not supported yet")
    }
  }

  private arrayBufferToBase64(buffer: ArrayBufferLike): string {
    const bytes = new Uint8Array(buffer)
    let binary = ""
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes.buffer
  }
}
