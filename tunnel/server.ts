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
  public x25519PublicKey: Uint8Array
  private x25519PrivateKey: Uint8Array

  private webSocketConnections = new Map<
    string,
    { ws: WebSocket; tunnelWs: WebSocket }
  >()
  private symmetricKeyBySocket = new Map<WebSocket, Uint8Array>()

  constructor(
    private app: Express,
    publicKey: Uint8Array,
    privateKey: Uint8Array
  ) {
    this.app = app
    this.x25519PublicKey = publicKey
    this.x25519PrivateKey = privateKey
    this.server = http.createServer(app)
    this.wss = new WebSocketServer({ server: this.server })

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

      // Intercept messages before they reach application handlers
      const originalEmit = ws.emit.bind(ws)

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

      ws.emit = function (event: string, ...args: any[]): boolean {
        if (event === "message") {
          const data = args[0] as Buffer
          try {
            let message = JSON.parse(data.toString())
            const ra = (this as any).ra as RA

            // Handle client key exchange
            if (message.type === "client_kx") {
              try {
                // Only accept a single symmetric key per WebSocket
                if (!ra.symmetricKeyBySocket.has(ws)) {
                  const sealed = sodium.from_base64(
                    message.sealedSymmetricKey,
                    sodium.base64_variants.ORIGINAL
                  )
                  const opened = sodium.crypto_box_seal_open(
                    sealed,
                    ra.x25519PublicKey,
                    ra.x25519PrivateKey
                  )
                  ra.symmetricKeyBySocket.set(ws, opened)
                } else {
                  console.warn(
                    "client_kx received after key already set; ignoring"
                  )
                }
              } catch (e) {
                console.error("Failed to process client_kx:", e)
              }
              return true
            }

            // If handshake not complete yet, ignore any other messages
            if (!ra.symmetricKeyBySocket.has(ws)) {
              console.warn("Dropping message before handshake completion")
              return true
            }

            // Require encryption post-handshake
            if (message.type !== "enc") {
              console.warn("Dropping non-encrypted message post-handshake")
              return true
            }

            // Decrypt envelope messages post-handshake
            if (message.type === "enc") {
              try {
                message = ra.decryptEnvelopeForSocket(ws, message as TunnelEncrypted)
              } catch (e) {
                console.error("Failed to decrypt envelope:", e)
                return true
              }
            }

            if (message.type === "http_request") {
              console.log(
                "Tunnel request received:",
                message.requestId,
                message.url
              )
              ra.handleTunnelHttpRequest(
                ws,
                message as TunnelHTTPRequest
              ).catch((error: Error) => {
                console.error("Error handling tunnel request:", error)

                // Send 500 error response back to client
                try {
                  ra.sendEncrypted(ws, {
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
              })
              return true
            } else if (message.type === "ws_connect") {
              ra.handleTunnelWebSocketConnect(
                ws,
                message as TunnelWSClientConnect
              )
              return true
            } else if (message.type === "ws_message") {
              ra.handleTunnelWebSocketMessage(message as TunnelWSMessage)
              return true
            } else if (message.type === "ws_close") {
              ra.handleTunnelWebSocketClose(message as TunnelWSClientClose)
              return true
            }
          } catch (error) {
            console.error(error)
          }
        }

        // Discard non-tunnel messages other than close
        if (event === "close") {
          return originalEmit(event, ...args)
        } else {
          console.error(event, ...args)
          return true
        }
      }
      ;(ws as any).ra = this
    })
  }
  // Handle tunnel requests by synthesizing `fetch` events and passing to Express
  async handleTunnelHttpRequest(
    ws: WebSocket,
    tunnelReq: TunnelHTTPRequest
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
    connectReq: TunnelWSClientConnect
  ): Promise<void> {
    try {
      console.log(`Creating WebSocket connection to ${connectReq.url}`)

      const ws = new WebSocket(connectReq.url, connectReq.protocols)

      // Store the connection
      this.webSocketConnections.set(connectReq.connectionId, { ws, tunnelWs })

      ws.on("open", () => {
        console.log(`WebSocket ${connectReq.connectionId} connected`)
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
      })

      ws.on("message", (data: Buffer) => {
        let messageData: string
        let dataType: "string" | "arraybuffer"

        // Check if data is text or binary
        if (this.isTextData(data)) {
          messageData = data.toString()
          dataType = "string"
        } else {
          // Convert binary data to base64
          messageData = data.toString("base64")
          dataType = "arraybuffer"
        }

        const message: TunnelWSMessage = {
          type: "ws_message",
          connectionId: connectReq.connectionId,
          data: messageData,
          dataType: dataType,
        }
        try {
          this.sendEncrypted(tunnelWs, message)
        } catch (e) {
          console.error("Failed to send encrypted ws_message:", e)
        }
      })

      ws.on("close", (code: number, reason: Buffer) => {
        console.log(`WebSocket ${connectReq.connectionId} closed`)
        const event: TunnelWSServerEvent = {
          type: "ws_event",
          connectionId: connectReq.connectionId,
          eventType: "close",
          code,
          reason: reason.toString(),
        }
        try {
          this.sendEncrypted(tunnelWs, event)
        } catch (e) {
          console.error("Failed to send encrypted ws_event(close):", e)
        }
        this.webSocketConnections.delete(connectReq.connectionId)
      })

      ws.on("error", (error: Error) => {
        console.log(
          `WebSocket ${connectReq.connectionId} error:`,
          error.message
        )
        const event: TunnelWSServerEvent = {
          type: "ws_event",
          connectionId: connectReq.connectionId,
          eventType: "error",
          error: error.message,
        }
        try {
          this.sendEncrypted(tunnelWs, event)
        } catch (e) {
          console.error("Failed to send encrypted ws_event(error):", e)
        }
      })
    } catch (error) {
      console.error("Error creating WebSocket connection:", error)
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
        let dataToSend: string | Buffer
        if (messageReq.dataType === "arraybuffer") {
          // Convert base64 back to binary data
          dataToSend = Buffer.from(messageReq.data, "base64")
        } else {
          dataToSend = messageReq.data
        }
        connection.ws.send(dataToSend)
      } catch (error) {
        console.error(
          `Error sending message to WebSocket ${messageReq.connectionId}:`,
          error
        )
      }
    }
  }

  handleTunnelWebSocketClose(closeReq: TunnelWSClientClose): void {
    const connection = this.webSocketConnections.get(closeReq.connectionId)
    if (connection) {
      try {
        connection.ws.close(closeReq.code, closeReq.reason)
      } catch (error) {
        console.error(
          `Error closing WebSocket ${closeReq.connectionId}:`,
          error
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
      ciphertext: sodium.to_base64(
        ciphertext,
        sodium.base64_variants.ORIGINAL
      ),
    }
  }

  private decryptEnvelopeForSocket(
    ws: WebSocket,
    envelope: TunnelEncrypted
  ): any {
    const key = this.symmetricKeyBySocket.get(ws)
    if (!key) {
      throw new Error("Missing symmetric key for socket")
    }
    const nonce = sodium.from_base64(
      envelope.nonce,
      sodium.base64_variants.ORIGINAL
    )
    const ciphertext = sodium.from_base64(
      envelope.ciphertext,
      sodium.base64_variants.ORIGINAL
    )
    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key)
    const text = sodium.to_string(plaintext)
    return JSON.parse(text)
  }

  private sendEncrypted(ws: WebSocket, payload: unknown): void {
    const env = this.encryptForSocket(ws, payload)
    ws.send(JSON.stringify(env))
  }
}
