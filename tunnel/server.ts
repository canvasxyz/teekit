import http from "http"
import { WebSocketServer, WebSocket } from "ws"
import { Express } from "express"
import httpMocks, { RequestMethod } from "node-mocks-http"
import { EventEmitter } from "events"
import sodium from "libsodium-wrappers"
import {
  TunnelHTTPRequest,
  TunnelHTTPResponse,
  TunnelWSClientConnect,
  TunnelWSMessage,
  TunnelWSClientClose,
  TunnelWSServerEvent,
  TunnelEncrypted,
} from "./types.js"
import { parseBody, sanitizeHeaders, getStatusText } from "./utils/server.js"

export class RA {
  public server: http.Server
  public wss: WebSocketServer
  public appWss: AppWebSocketServerMock
  public x25519PublicKey: Uint8Array
  private x25519PrivateKey: Uint8Array

  private webSocketConnections = new Map<
    string,
    { appWs: AppWebSocketMock; tunnelWs: WebSocket }
  >()
  private symmetricKeyBySocket = new Map<WebSocket, Uint8Array>()

  constructor(
    private app: Express,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
  ) {
    this.app = app
    this.x25519PublicKey = publicKey
    this.x25519PrivateKey = privateKey
    this.server = http.createServer(app)
    this.wss = new WebSocketServer({ server: this.server })
    this.appWss = new AppWebSocketServerMock()

    this.setupWebSocketHandler()
  }

  static async initialize(app: Express): Promise<RA> {
    await sodium.ready
    const { publicKey, privateKey } = sodium.crypto_box_keypair()
    return new RA(app, publicKey, privateKey)
  }

  /**
   * Intercept incoming WebSocket messages on `this.wss`.
   */
  private setupWebSocketHandler(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      console.log("Setting up tunnel handler")

      // Immediately announce server key-exchange public key to the client
      try {
        const serverKxMessage = {
          type: "server_kx",
          x25519PublicKey: Buffer.from(this.x25519PublicKey).toString("base64"),
        }
        ws.send(JSON.stringify(serverKxMessage))
      } catch (e) {
        console.error("Failed to send server_kx message:", e)
      }

      // Cleanup on close
      ws.on("close", () => {
        this.symmetricKeyBySocket.delete(ws)
      })

      ws.on("message", (data: Buffer) => {
        try {
          let message = JSON.parse(data.toString())

          // Handle client key exchange
          if (message.type === "client_kx") {
            try {
              if (!this.symmetricKeyBySocket.has(ws)) {
                const sealed = sodium.from_base64(
                  message.sealedSymmetricKey,
                  sodium.base64_variants.ORIGINAL,
                )
                const opened = sodium.crypto_box_seal_open(
                  sealed,
                  this.x25519PublicKey,
                  this.x25519PrivateKey,
                )
                this.symmetricKeyBySocket.set(ws, opened)
              } else {
                console.warn(
                  "client_kx received after key already set; ignoring",
                )
              }
            } catch (e) {
              console.error("Failed to process client_kx:", e)
            }
            return
          }

          // If handshake not complete yet, ignore any other messages
          if (!this.symmetricKeyBySocket.has(ws)) {
            console.warn("Dropping message before handshake completion")
            return
          }

          // Require encryption post-handshake
          if (message.type !== "enc") {
            console.warn("Dropping non-encrypted message post-handshake")
            return
          }

          // Decrypt envelope messages post-handshake
          try {
            message = this.decryptEnvelopeForSocket(
              ws,
              message as TunnelEncrypted,
            )
          } catch (e) {
            console.error("Failed to decrypt envelope:", e)
            return
          }

          if (message.type === "http_request") {
            console.log(
              "Tunnel request received:",
              message.requestId,
              message.url,
            )
            this.handleTunnelHttpRequest(ws, message as TunnelHTTPRequest).catch(
              (error: Error) => {
                console.error("Error handling tunnel request:", error)
                try {
                  this.sendEncrypted(ws, {
                    type: "http_response",
                    requestId: message.requestId,
                    status: 500,
                    statusText: "Internal Server Error",
                    headers: {},
                    body: "",
                    error: error.message,
                  } as TunnelHTTPResponse)
                } catch (sendError) {
                  console.error("Failed to send error response:", sendError)
                }
              },
            )
          } else if (message.type === "ws_connect") {
            this.handleTunnelWebSocketConnect(ws, message as TunnelWSClientConnect)
          } else if (message.type === "ws_message") {
            this.handleTunnelWebSocketMessage(message as TunnelWSMessage)
          } else if (message.type === "ws_close") {
            this.handleTunnelWebSocketClose(message as TunnelWSClientClose)
          }
        } catch (error) {
          console.error(error)
        }
      })
    })
  }
  // Handle tunnel requests by synthesizing `fetch` events and passing to Express
  async handleTunnelHttpRequest(
    ws: WebSocket,
    tunnelReq: TunnelHTTPRequest,
  ): Promise<void> {
    try {
      // Parse URL to extract pathname and query
      const urlObj = new URL(tunnelReq.url, "http://localhost")
      const query: Record<string, string> = {}
      urlObj.searchParams.forEach((value, key) => {
        query[key] = value
      })

      const req = httpMocks.createRequest({
        method: tunnelReq.method as RequestMethod,
        url: tunnelReq.url,
        path: urlObj.pathname,
        headers: tunnelReq.headers,
        body: tunnelReq.body
          ? parseBody(tunnelReq.body, tunnelReq.headers["content-type"])
          : undefined,
        query: query,
      })

      const res = httpMocks.createResponse({
        eventEmitter: EventEmitter,
      })

      // Pass responses back through the tunnel
      // TODO: if ws.send() fails due to connectivity, the client could
      // get out of sync.

      res.on("end", () => {
        const response: TunnelHTTPResponse = {
          type: "http_response",
          requestId: tunnelReq.requestId,
          status: res.statusCode,
          statusText: res.statusMessage || getStatusText(res.statusCode),
          headers: sanitizeHeaders(res.getHeaders()),
          body: res._getData(),
        }

        try {
          this.sendEncrypted(ws, response)
        } catch (e) {
          console.error("Failed to send encrypted http_response:", e)
        }
      })

      // Handle errors generically. TODO: better error handling.
      res.on("error", (error) => {
        const errorResponse: TunnelHTTPResponse = {
          type: "http_response",
          requestId: tunnelReq.requestId,
          status: 500,
          statusText: "Internal Server Error",
          headers: {},
          body: "",
          error: error.message,
        }

        try {
          this.sendEncrypted(ws, errorResponse)
        } catch (e) {
          console.error("Failed to send encrypted error http_response:", e)
        }
      })

      // Execute the request against the Express app
      this.app(req, res)
    } catch (error) {
      const errorResponse: TunnelHTTPResponse = {
        type: "http_response",
        requestId: tunnelReq.requestId,
        status: 500,
        statusText: "Internal Server Error",
        headers: {},
        body: "",
        error: error instanceof Error ? error.message : "Unknown error",
      }

      try {
        this.sendEncrypted(ws, errorResponse)
      } catch (e) {
        console.error("Failed to send encrypted catch http_response:", e)
      }
    }
  }

  async handleTunnelWebSocketConnect(
    tunnelWs: WebSocket,
    connectReq: TunnelWSClientConnect,
  ): Promise<void> {
    try {
      // Validate that the requested URL targets this server (no proxying)
      const address = this.server.address()
      if (!address || typeof address === "string") {
        throw new Error("Server is not listening yet")
      }
      const { port } = address
      const url = new URL(connectReq.url)
      const reqPort = Number(url.port || (url.protocol === "wss:" ? 443 : 80))

      if (reqPort !== port) {
        const errorMessage = `WebSocket target port ${reqPort} does not match server port ${port}`
        const event: TunnelWSServerEvent = {
          type: "ws_event",
          connectionId: connectReq.connectionId,
          eventType: "error",
          error: errorMessage,
        }
        try {
          this.sendEncrypted(tunnelWs, event)
        } catch {}
        throw new Error(errorMessage)
      }

      console.log(
        `Establishing app WebSocket mock for connection ${connectReq.connectionId} -> ${url.href}`,
      )

      // Create an app-level WebSocket mock and expose via appWss
      const appWs = new AppWebSocketMock(
        this,
        connectReq.connectionId,
        tunnelWs,
      )

      // Track connection
      this.webSocketConnections.set(connectReq.connectionId, { appWs, tunnelWs })

      // Add to app client set and emit to application handlers
      this.appWss._addClient(appWs)
      this.appWss._emitConnection(appWs)

      // Notify client that connection is open
      const event: TunnelWSServerEvent = {
        type: "ws_event",
        connectionId: connectReq.connectionId,
        eventType: "open",
      }
      try {
        this.sendEncrypted(tunnelWs, event)
      } catch (e) {
        console.error("Failed to send encrypted ws_event(open):", e)
      }
    } catch (error) {
      console.error("Error handling virtual WebSocket connection:", error)
      const event: TunnelWSServerEvent = {
        type: "ws_event",
        connectionId: connectReq.connectionId,
        eventType: "error",
        error: error instanceof Error ? error.message : "Connection failed",
      }
      try {
        this.sendEncrypted(tunnelWs, event)
      } catch (e) {
        console.error("Failed to send encrypted ws_event(error catch):", e)
      }
    }
  }

  handleTunnelWebSocketMessage(messageReq: TunnelWSMessage): void {
    const connection = this.webSocketConnections.get(messageReq.connectionId)
    if (connection) {
      try {
        let dataToDeliver: string | Buffer
        if (messageReq.dataType === "arraybuffer") {
          dataToDeliver = Buffer.from(messageReq.data, "base64")
        } else {
          dataToDeliver = messageReq.data
        }
        console.log(
          `Delivering client message to app for ${messageReq.connectionId} (${messageReq.dataType}, ${typeof dataToDeliver})`,
        )
        // Deliver message from client to application
        connection.appWs._deliverFromClient(dataToDeliver)
      } catch (error) {
        console.error(
          `Error delivering message to virtual WebSocket ${messageReq.connectionId}:`,
          error,
        )
      }
    }
  }

  handleTunnelWebSocketClose(closeReq: TunnelWSClientClose): void {
    const connection = this.webSocketConnections.get(closeReq.connectionId)
    if (connection) {
      try {
        connection.appWs._closedByClient(closeReq.code, closeReq.reason)
      } catch (error) {
        console.error(
          `Error closing virtual WebSocket ${closeReq.connectionId}:`,
          error,
        )
      }
      this.webSocketConnections.delete(closeReq.connectionId)
    }
  }

  private isTextData(data: Buffer): boolean {
    // Simple heuristic to detect if data is likely text
    // Check for null bytes and high-bit characters
    for (let i = 0; i < Math.min(data.length, 1024); i++) {
      const byte = data[i]
      if (byte === 0 || (byte > 127 && byte < 160)) {
        return false
      }
    }
    return true
  }

  private encryptForSocket(ws: WebSocket, payload: unknown): TunnelEncrypted {
    const key = this.symmetricKeyBySocket.get(ws)
    if (!key) {
      throw new Error("Missing symmetric key for socket")
    }
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
    const plaintext = sodium.from_string(JSON.stringify(payload))
    const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key)
    return {
      type: "enc",
      nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
      ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
    }
  }

  private decryptEnvelopeForSocket(
    ws: WebSocket,
    envelope: TunnelEncrypted,
  ): any {
    const key = this.symmetricKeyBySocket.get(ws)
    if (!key) {
      throw new Error("Missing symmetric key for socket")
    }
    const nonce = sodium.from_base64(
      envelope.nonce,
      sodium.base64_variants.ORIGINAL,
    )
    const ciphertext = sodium.from_base64(
      envelope.ciphertext,
      sodium.base64_variants.ORIGINAL,
    )
    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key)
    const text = sodium.to_string(plaintext)
    return JSON.parse(text)
  }

  public sendEncrypted(ws: WebSocket, payload: unknown): void {
    const env = this.encryptForSocket(ws, payload)
    ws.send(JSON.stringify(env))
  }
}

/**
 * Virtual in-process WebSocket that represents an application-level connection
 * terminated at the server without creating an outbound proxy socket.
 */
class AppWebSocketMock {
  public readonly CONNECTING = 0
  public readonly OPEN = 1
  public readonly CLOSING = 2
  public readonly CLOSED = 3

  public readyState: number = this.OPEN
  public protocol: string = ""
  public extensions: string = ""
  public binaryType: string = "nodebuffer"

  private handlers: Map<string, Set<(...args: any[]) => void>> = new Map()

  constructor(
    private ra: RA,
    private connectionId: string,
    private tunnelWs: WebSocket,
  ) {}

  public on(event: string, listener: (...args: any[]) => void): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(listener)
    return this
  }

  public off(event: string, listener: (...args: any[]) => void): this {
    this.handlers.get(event)?.delete(listener)
    return this
  }

  private emit(event: string, ...args: any[]): void {
    const listeners = this.handlers.get(event)
    if (!listeners) return
    for (const fn of listeners) {
      try {
        fn(...args)
      } catch (e) {
        // Swallow handler errors to avoid breaking others
        console.error(e)
      }
    }
  }

  // Application sends data to client
  public send(data: string | Buffer): void {
    if (this.readyState !== this.OPEN) {
      throw new Error("WebSocket is not open")
    }

    let messageData: string
    let dataType: "string" | "arraybuffer"
    if (typeof data === "string") {
      messageData = data
      dataType = "string"
    } else if (Buffer.isBuffer(data)) {
      if (this.isTextData(data)) {
        messageData = data.toString()
        dataType = "string"
      } else {
        messageData = data.toString("base64")
        dataType = "arraybuffer"
      }
    } else {
      // Coerce other types to string
      messageData = String(data)
      dataType = "string"
    }

    try {
      console.log(
        `VirtualServerWebSocket send -> client (${dataType}), len=${messageData.length}`,
      )
    } catch {}

    const message: TunnelWSMessage = {
      type: "ws_message",
      connectionId: this.connectionId,
      data: messageData,
      dataType: dataType,
    }
    try {
      this.ra.sendEncrypted(this.tunnelWs, message)
    } catch (e) {
      console.error("Failed to send encrypted ws_message:", e)
    }
  }

  // Server closes connection
  public close(code?: number, reason?: string): void {
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) {
      return
    }
    this.readyState = this.CLOSING

    // Notify application handlers
    const reasonBuf = Buffer.from(reason || "")
    this.emit("close", code ?? 1000, reasonBuf)

    // Remove from broadcast set
    this.ra.appWss._removeClient(this)

    this.readyState = this.CLOSED

    // Inform client
    const event: TunnelWSServerEvent = {
      type: "ws_event",
      connectionId: this.connectionId,
      eventType: "close",
      code,
      reason,
    }
    try {
      this.ra.sendEncrypted(this.tunnelWs, event)
    } catch (e) {
      console.error("Failed to send encrypted ws_event(close):", e)
    }
  }

  public terminate(): void {
    this.close(1006, "terminated")
  }

  // Deliver message from client to application handlers
  public _deliverFromClient(data: string | Buffer): void {
    if (typeof data === "string") {
      this.emit("message", Buffer.from(data))
    } else {
      this.emit("message", data)
    }
  }

  public _closedByClient(code?: number, reason?: string): void {
    if (this.readyState === this.CLOSED) return
    this.readyState = this.CLOSING
    const reasonBuf = Buffer.from(reason || "")
    this.emit("close", code ?? 1000, reasonBuf)
    this.readyState = this.CLOSED
    this.ra.appWss._removeClient(this)
  }

  private isTextData(data: Buffer): boolean {
    for (let i = 0; i < Math.min(data.length, 1024); i++) {
      const byte = data[i]
      if (byte === 0 || (byte > 127 && byte < 160)) {
        return false
      }
    }
    return true
  }
}

class AppWebSocketServerMock {
  public clients: Set<AppWebSocketMock> = new Set()
  private handlers: Map<string, Set<(...args: any[]) => void>> = new Map()

  public on(event: "connection", listener: (ws: AppWebSocketMock) => void): this
  public on(event: string, listener: (...args: any[]) => void): this
  public on(event: string, listener: (...args: any[]) => void): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(listener)
    return this
  }

  public off(event: string, listener: (...args: any[]) => void): this {
    this.handlers.get(event)?.delete(listener)
    return this
  }

  public close(cb?: () => void): void {
    for (const client of [...this.clients]) {
      try {
        client.terminate()
      } catch {}
    }
    if (cb) cb()
  }

  _addClient(ws: AppWebSocketMock): void {
    this.clients.add(ws)
  }

  _removeClient(ws: AppWebSocketMock): void {
    this.clients.delete(ws)
  }

  _emitConnection(ws: AppWebSocketMock): void {
    const listeners = this.handlers.get("connection")
    if (!listeners) return
    for (const fn of listeners) {
      try {
        ;(fn as (ws: AppWebSocketMock) => void)(ws)
      } catch (e) {
        console.error(e)
      }
    }
  }
}
