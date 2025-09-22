import http from "http"
import { WebSocketServer, WebSocket } from "ws"
import { Express } from "express"
import httpMocks, { RequestMethod } from "node-mocks-http"
import { EventEmitter } from "events"
import sodium from "libsodium-wrappers"
import { encode, decode } from "cbor-x"
import createDebug from "debug"

import {
  RAEncryptedHTTPRequest,
  RAEncryptedHTTPResponse,
  RAEncryptedClientConnectEvent,
  RAEncryptedWSMessage,
  RAEncryptedClientCloseEvent,
  RAEncryptedServerEvent,
  ControlChannelEncryptedMessage,
} from "./types.js"
import {
  isControlChannelKXConfirm,
  isControlChannelEncryptedMessage,
  isRAEncryptedHTTPRequest,
  isRAEncryptedClientConnectEvent,
  isRAEncryptedWSMessage,
  isRAEncryptedClientCloseEvent,
} from "./typeguards.js"
import {
  isTextData,
  parseBody,
  sanitizeHeaders,
  getStatusText,
} from "./utils/server.js"
import {
  ServerRAMockWebSocket,
  ServerRAMockWebSocketServer,
} from "./ServerRAWebSocket.js"

const debug = createDebug("ra-https:TunnelServer")

/**
 * Virtual server for remote-attested encrypted channels.
 *
 * For HTTP requests, the virtual server binds to an Express server,
 * and decrypts and forwards requests to it.
 *
 * For Websockets, use the `wss` instance as a regular WebSocket server,
 * and messages will be encrypted and decrypted in-flight.
 *
 * ```
 * const { wss, server } = await TunnelServer.initialize(app)
 *
 * wss.on("connection", (ws: WebSocket) => {
 *   // Handle incoming messages
 *   ws.on("message", (data: Buffer) => { ... })
 *
 *   // Send an initial message
 *   ws.send(...)
 *
 *   // Handle disconnects
 *   ws.on("close", () => { ... })
 * })
 * ```
 *
 * You must use server.listen() to bind to a port:
 *
 * ```
 * server.listen(process.env.PORT, () => {
 *   console.log(`Server running on port ${PORT}`)
 * })
 * ```
 */
export class TunnelServer {
  public readonly server: http.Server
  public readonly quote: Uint8Array
  public readonly wss: ServerRAMockWebSocketServer
  private readonly controlWss: WebSocketServer

  public readonly x25519PublicKey: Uint8Array
  private readonly x25519PrivateKey: Uint8Array

  private webSocketConnections = new Map<
    string,
    { mockWs: ServerRAMockWebSocket; controlWs: WebSocket }
  >()
  private symmetricKeyBySocket = new Map<WebSocket, Uint8Array>()

  private constructor(
    private app: Express,
    quote: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
  ) {
    this.app = app
    this.quote = quote
    this.x25519PublicKey = publicKey
    this.x25519PrivateKey = privateKey
    this.server = http.createServer(app)

    // Expose a mock WebSocketServer to application code
    this.wss = new ServerRAMockWebSocketServer()

    // Route upgrades to the control channel WebSocketServer
    this.controlWss = new WebSocketServer({ noServer: true })
    this.#setupControlChannel()
    this.server.on("upgrade", (req, socket, head) => {
      const url = req.url || ""
      if (url.startsWith("/__ra__")) {
        this.controlWss.handleUpgrade(req, socket, head, (controlWs) => {
          this.controlWss.emit("connection", controlWs, req)
        })
      } else {
        // Don't allow other WebSocket servers to bind to the server;
        // all WebSocket connections go to the encrypted channel.
        socket.destroy()
      }
    })
  }

  static async initialize(
    app: Express,
    quote: Uint8Array,
  ): Promise<TunnelServer> {
    await sodium.ready
    const { publicKey, privateKey } = sodium.crypto_box_keypair()
    return new TunnelServer(app, quote, publicKey, privateKey)
  }

  /**
   * Intercept incoming WebSocket messages on `this.wss`.
   */
  #setupControlChannel(): void {
    this.controlWss.on("connection", (controlWs: WebSocket) => {
      debug("New WebSocket connection, setting up control channel")

      // Intercept messages before they reach application handlers
      const originalEmit = controlWs.emit.bind(controlWs)

      // Immediately announce server key-exchange public key to the client
      try {
        const serverKxMessage = {
          type: "server_kx",
          x25519PublicKey: Buffer.from(this.x25519PublicKey).toString("base64"),
          quote: Buffer.from(this.quote).toString("base64"),
        }
        controlWs.send(encode(serverKxMessage))
      } catch (e) {
        console.error("Failed to send server_kx message:", e)
      }

      // Cleanup on close
      controlWs.on("close", () => {
        this.symmetricKeyBySocket.delete(controlWs)

        const toRemove: string[] = []
        for (const [connId, conn] of this.webSocketConnections.entries()) {
          if (conn.controlWs === controlWs) {
            try {
              conn.mockWs.emitClose(1006, "tunnel closed")
              this.wss.deleteClient(conn.mockWs)
              this.symmetricKeyBySocket.delete(conn.controlWs)
              toRemove.push(connId)
            } catch (e) {
              console.error("Unexpected error cleaning up control ws:", e)
            }
          }
        }
        for (const id of toRemove) {
          this.webSocketConnections.delete(id)
        }
      })

      controlWs.emit = function (event: string, ...args: any[]): boolean {
        if (event === "message") {
          // Decode incoming message from client
          let message
          try {
            const data = args[0] as Buffer
            message = decode(new Uint8Array(data))
          } catch (error: any) {
            console.error("Received invalid CBOR message")
            return true
          }

          const ra = (this as any).ra as TunnelServer

          // Handle client key exchange
          if (isControlChannelKXConfirm(message)) {
            try {
              // Only accept a single symmetric key per WebSocket
              if (!ra.symmetricKeyBySocket.has(controlWs)) {
                const sealed = sodium.from_base64(
                  message.sealedSymmetricKey,
                  sodium.base64_variants.ORIGINAL,
                )
                const opened = sodium.crypto_box_seal_open(
                  sealed,
                  ra.x25519PublicKey,
                  ra.x25519PrivateKey,
                )
                ra.symmetricKeyBySocket.set(controlWs, opened)
              } else {
                console.warn(
                  "client_kx received after key already set; ignoring",
                )
              }
            } catch (e) {
              console.error("Failed to process client_kx:", e)
            }
            return true
          }

          // If handshake not complete yet, ignore any other messages
          if (!ra.symmetricKeyBySocket.has(controlWs)) {
            console.warn("Dropping message before handshake completion")
            return true
          }

          // Require encryption post-handshake
          if (!isControlChannelEncryptedMessage(message)) {
            console.warn("Dropping non-encrypted message post-handshake")
            return true
          }

          // Decrypt envelope messages post-handshake
          if (isControlChannelEncryptedMessage(message)) {
            try {
              message = ra.#decryptEnvelopeForSocket(
                controlWs,
                message as ControlChannelEncryptedMessage,
              )
            } catch (e) {
              console.error("Failed to decrypt envelope:", e)
              return true
            }
          }

          if (isRAEncryptedHTTPRequest(message)) {
            ra.logWebSocketConnections()
            debug(
              `Encrypted HTTP request (${message.requestId}): ${message.url}`,
            )
            ra.#handleTunnelHttpRequest(controlWs, message).catch(
              (error: Error) => {
                console.error("Error handling encrypted request:", error)

                // Send 500 error response back to client
                try {
                  ra.sendEncrypted(controlWs, {
                    type: "http_response",
                    requestId: message.requestId,
                    status: 500,
                    statusText: "Internal Server Error",
                    headers: {},
                    body: "",
                    error: error.message,
                  } as RAEncryptedHTTPResponse)
                } catch (sendError) {
                  console.error("Failed to send error response:", sendError)
                }
              },
            )
            return true
          } else if (isRAEncryptedClientConnectEvent(message)) {
            ra.#handleTunnelWebSocketConnect(controlWs, message)
            return true
          } else if (isRAEncryptedWSMessage(message)) {
            ra.#handleTunnelWebSocketMessage(message)
            return true
          } else if (isRAEncryptedClientCloseEvent(message)) {
            ra.#handleTunnelWebSocketClose(message)
            return true
          }
        }

        // Discard non-tunnel messages other than close
        if (event === "close") {
          return originalEmit(event, ...args)
        } else {
          console.error("Received message after close:", event, ...args)
          return true
        }
      }
      ;(controlWs as any).ra = this
    })
  }

  // Handle tunnel requests by synthesizing `fetch` events and passing to Express
  async #handleTunnelHttpRequest(
    controlWs: WebSocket,
    tunnelReq: RAEncryptedHTTPRequest,
  ): Promise<void> {
    try {
      // Parse URL to extract pathname and query
      const urlObj = new URL(tunnelReq.url, "http://localhost")
      const query: Record<string, string> = {}
      urlObj.searchParams.forEach((value, key) => {
        query[key] = value
      })

      const parsedBody =
        tunnelReq.body !== undefined
          ? parseBody(tunnelReq.body, tunnelReq.headers["content-type"])
          : undefined

      const req = httpMocks.createRequest({
        method: tunnelReq.method as RequestMethod,
        url: tunnelReq.url,
        path: urlObj.pathname,
        headers: tunnelReq.headers,
        body: parsedBody,
        query: query,
      })

      // Ensure req.body reflects parsed body exactly, including empty string
      ;(req as any).body = parsedBody as any

      const res = httpMocks.createResponse({
        eventEmitter: EventEmitter,
      })

      // Some Express internals (finalhandler) may call req.unpipe(). Ensure it's safe on mocks.
      try {
        ;(req as any).unpipe = (_dest?: any) => req as any
      } catch {}

      // Pass responses back through the tunnel
      // TODO: if ws.send() fails due to connectivity, the client could
      // get out of sync.

      res.on("end", () => {
        const response: RAEncryptedHTTPResponse = {
          type: "http_response",
          requestId: tunnelReq.requestId,
          status: res.statusCode,
          statusText: res.statusMessage || getStatusText(res.statusCode),
          headers: sanitizeHeaders(res.getHeaders()),
          body: res._getData(),
        }

        try {
          this.sendEncrypted(controlWs, response)
        } catch (e) {
          console.error("Failed to send encrypted http_response:", e)
        }
      })

      // Handle errors generically. TODO: better error handling.
      res.on("error", (error) => {
        const errorResponse: RAEncryptedHTTPResponse = {
          type: "http_response",
          requestId: tunnelReq.requestId,
          status: 500,
          statusText: "Internal Server Error",
          headers: {},
          body: "",
          error: error.message,
        }

        try {
          this.sendEncrypted(controlWs, errorResponse)
        } catch (e) {
          console.error("Failed to send encrypted error http_response:", e)
        }
      })

      // Execute the request against the Express app
      this.app(req, res)
    } catch (error) {
      const errorResponse: RAEncryptedHTTPResponse = {
        type: "http_response",
        requestId: tunnelReq.requestId,
        status: 500,
        statusText: "Internal Server Error",
        headers: {},
        body: "",
        error: error instanceof Error ? error.message : "Unknown error",
      }

      try {
        this.sendEncrypted(controlWs, errorResponse)
      } catch (e) {
        console.error("Failed to send encrypted catch http_response:", e)
      }
    }
  }

  async #handleTunnelWebSocketConnect(
    controlWs: WebSocket,
    connectReq: RAEncryptedClientConnectEvent,
  ): Promise<void> {
    try {
      // Create a mock socket and expose it to application via mock server
      const mock = new ServerRAMockWebSocket(
        // onSend: application -> client
        (payload) => {
          let messageData: string | Uint8Array
          let dataType: "string" | "arraybuffer"
          if (typeof payload === "string") {
            messageData = payload
            dataType = "string"
          } else if (Buffer.isBuffer(payload)) {
            if (isTextData(payload)) {
              messageData = payload.toString()
              dataType = "string"
            } else {
              messageData = new Uint8Array(payload)
              dataType = "arraybuffer"
            }
          } else {
            messageData = String(payload)
            dataType = "string"
          }
          const message: RAEncryptedWSMessage = {
            type: "ws_message",
            connectionId: connectReq.connectionId,
            data: messageData,
            dataType,
          }
          try {
            this.sendEncrypted(controlWs, message)
          } catch (e) {
            console.error("Failed to send encrypted ws_message:", e)
          }
        },
        // onClose: application -> client
        (code?: number, reason?: string) => {
          const event: RAEncryptedServerEvent = {
            type: "ws_event",
            connectionId: connectReq.connectionId,
            eventType: "close",
            code,
            reason,
          }
          try {
            this.sendEncrypted(controlWs, event)
          } catch (e) {
            console.error("Failed to send encrypted ws_event(close):", e)
          }
        },
      )

      // Track mapping
      this.webSocketConnections.set(connectReq.connectionId, {
        mockWs: mock,
        controlWs: controlWs,
      })

      // Register with mock server and notify application
      this.wss.addClient(mock)

      // Signal open to client
      const openEvt: RAEncryptedServerEvent = {
        type: "ws_event",
        connectionId: connectReq.connectionId,
        eventType: "open",
      }
      try {
        this.sendEncrypted(controlWs, openEvt)
      } catch (e) {
        console.error("Failed to send encrypted ws_event(open):", e)
      }
    } catch (error) {
      console.error("Error creating WebSocket connection:", error)
      const event: RAEncryptedServerEvent = {
        type: "ws_event",
        connectionId: connectReq.connectionId,
        eventType: "error",
        error: error instanceof Error ? error.message : "Connection failed",
      }
      try {
        this.sendEncrypted(controlWs, event)
      } catch (e) {
        console.error("Failed to send encrypted ws_event(error catch):", e)
      }
    }
  }

  #handleTunnelWebSocketMessage(messageReq: RAEncryptedWSMessage): void {
    const connection = this.webSocketConnections.get(messageReq.connectionId)
    if (connection) {
      try {
        let dataToSend: string | Buffer
        if (messageReq.dataType === "arraybuffer") {
          dataToSend = Buffer.from(messageReq.data as Uint8Array)
        } else {
          dataToSend = messageReq.data as string
        }
        connection.mockWs.emitMessage(dataToSend)
      } catch (error) {
        console.error(
          `Error sending message to WebSocket ${messageReq.connectionId}:`,
          error,
        )
      }
    }
  }

  #handleTunnelWebSocketClose(closeReq: RAEncryptedClientCloseEvent): void {
    const connection = this.webSocketConnections.get(closeReq.connectionId)
    if (connection) {
      try {
        connection.mockWs.emitClose(closeReq.code, closeReq.reason)
      } catch (error) {
        console.error(
          `Error closing WebSocket ${closeReq.connectionId}:`,
          error,
        )
      }
      try {
        this.wss.deleteClient(connection.mockWs)
      } catch {}
      this.webSocketConnections.delete(closeReq.connectionId)
    }
  }

  #encryptForSocket(
    controlWs: WebSocket,
    payload: unknown,
  ): ControlChannelEncryptedMessage {
    const key = this.symmetricKeyBySocket.get(controlWs)
    if (!key) {
      this.logWebSocketConnections()
      throw new Error("Missing symmetric key for socket (outbound)")
    }
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
    const plaintext = encode(payload)
    const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key)
    return {
      type: "enc",
      nonce: nonce,
      ciphertext: ciphertext,
    }
  }

  #decryptEnvelopeForSocket(
    controlWs: WebSocket,
    envelope: ControlChannelEncryptedMessage,
  ): unknown {
    const key = this.symmetricKeyBySocket.get(controlWs)
    if (!key) {
      this.logWebSocketConnections()
      throw new Error("Missing symmetric key for socket (inbound)")
    }
    const nonce = envelope.nonce
    const ciphertext = envelope.ciphertext
    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key)
    return decode(plaintext)
  }

  /**
   * Encrypt and send a payload.
   */
  private sendEncrypted(controlWs: WebSocket, payload: unknown): void {
    const env = this.#encryptForSocket(controlWs, payload)
    controlWs.send(encode(env))
  }

  /**
   * Helper to log current WebSocket connections and whether they have
   * established symmetric keys.
   */
  public logWebSocketConnections(): void {
    try {
      const entries = Array.from(this.webSocketConnections.entries())
      debug(`WebSocket connections: ${entries.length}`)
      for (const [connectionId, { controlWs: tunnelWs }] of entries) {
        const hasKey = this.symmetricKeyBySocket.has(tunnelWs)
        let state
        switch (tunnelWs.readyState) {
          case 0:
            state = "CONNECTING"
            break
          case 1:
            state = "OPEN"
            break
          case 2:
            state = "CLOSING"
            break
          case 3:
            state = "CLOSED"
            break
        }
        debug(
          `- ${connectionId}: state=${state}, symmetricKey=${
            hasKey ? "set" : "missing"
          }`,
        )
      }

      // Also warn if there are symmetric keys not tied to tracked connections
      const trackedSockets = new Set(entries.map(([, v]) => v.controlWs))
      const strayKeys = Array.from(this.symmetricKeyBySocket.keys()).filter(
        (controlWs) => !trackedSockets.has(controlWs),
      )
      if (strayKeys.length > 0) {
        console.warn(
          `- ${strayKeys.length} symmetric key(s) not associated with a tracked connection`,
        )
      }
    } catch (e) {
      console.error("Failed to log WebSocket connections:", e)
    }
  }
}
