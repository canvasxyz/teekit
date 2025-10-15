import type { Server as HttpServer, IncomingMessage } from "http"
import type { Socket } from "net"
import type { WebSocketServer, WebSocket } from "ws"
import sodium from "libsodium-wrappers"
import { encode as encodeCbor, decode as decodeCbor } from "cbor-x"
import createDebug from "debug"
import type { createRequest, createResponse } from "node-mocks-http"
import type { Express } from "express"
import type { Hono } from "hono"
import type { NodeWebSocket } from "@hono/node-ws"
import type { UpgradeWebSocket } from "hono/ws"

import {
  RAEncryptedHTTPRequest,
  RAEncryptedHTTPResponse,
  RAEncryptedClientConnectEvent,
  RAEncryptedWSMessage,
  RAEncryptedClientCloseEvent,
  RAEncryptedServerEvent,
  ControlChannelEncryptedMessage,
  QuoteData,
  VerifierData,
  ControlChannelKXAnnounce,
  TunnelApp,
} from "./types.js"
import {
  isControlChannelKXConfirm,
  isControlChannelEncryptedMessage,
  isRAEncryptedHTTPRequest,
  isRAEncryptedClientConnectEvent,
  isRAEncryptedWSMessage,
  isRAEncryptedClientCloseEvent,
  isHonoApp,
} from "./typeguards.js"
import { parseBody, sanitizeHeaders, getStatusText } from "./utils/server.js"
import { ENCRYPTED_REQUEST, markRequestAsEncrypted } from "./encryptedOnly.js"
import {
  ServerRAMockWebSocket,
  ServerRAMockWebSocketServer,
} from "./ServerRAWebSocket.js"

const debug = createDebug("teekit:TunnelServer")

type TunnelServerConfig = {
  heartbeatInterval?: number
  heartbeatTimeout?: number

  // Required for Hono: Provide an `upgradeWebSocket` handler
  // from hono/deno, hono/cloudflare-workers, etc.
  upgradeWebSocket?:
    | NodeWebSocket["upgradeWebSocket"]
    | UpgradeWebSocket<any, any, any>
}

/**
 * Virtual server for remote-attested encrypted channels.
 *
 * ## Hono instructions:
 *
 * ```
 * import { Hono } from 'hono'
 * import { upgradeWebSocket } from 'hono/ws'
 *
 * const app = new Hono()
 * app.get('/', (c) => c.text("Hello world!"))
 *
 * const { wss } = await TunnelServer.initialize(
 *   app,
 *   async (x25519PublicKey) => {
 *     // return a Uint8Array quote bound to x25519PublicKey
 *     return myQuote
 *   },
 *   { upgradeWebSocket },
 * )
 *
 * // No need to call server.listen for Hono — your platform/router hosts the app.
 * export default app
 * ```
 *
 * ## Express instructions:
 *
 * For HTTP requests, the virtual server binds to an Express server,
 * and decrypts and forwards requests to it.
 *
 * For Websockets, use the `wss` instance as a regular WebSocket server,
 * and messages will be encrypted and decrypted in-flight.
 *
 * ```
 * const { wss, server } = await TunnelServer.initialize(app, async (x25519PublicKey) => {
 *   // return a Uint8Array quote bound to x25519PublicKey
 *   return myQuote
 * })
 *
 * wss.on("connection", (ws: WebSocket) => {
 *   // Handle incoming messages
 *   ws.on("message", (data: Uint8Array) => { ... })
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
  public readonly server?: HttpServer
  public readonly quote: Uint8Array
  public readonly verifierData: VerifierData | null
  public readonly runtimeData: Uint8Array | null
  public readonly wss: ServerRAMockWebSocketServer
  private readonly controlWss?: WebSocketServer // for express
  private controlClients = new Set<WebSocket>() // for hono

  public readonly x25519PublicKey: Uint8Array
  private readonly x25519PrivateKey: Uint8Array

  private sockets = new Map<
    string,
    { mockWs: ServerRAMockWebSocket; controlWs: WebSocket }
  >()
  private symmetricKeyBySocket = new Map<WebSocket, Uint8Array>()
  private livenessBySocket = new Map<
    WebSocket,
    { isAlive: boolean; lastActivityMs: number }
  >()
  private heartbeatTimer?: ReturnType<typeof setInterval>

  private heartbeatInterval: number
  private heartbeatTimeout: number

  private constructor(
    private app: TunnelApp,
    quoteData: QuoteData,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    config?: TunnelServerConfig,
  ) {
    this.app = app
    this.quote = quoteData.quote
    this.verifierData = quoteData.verifier_data ?? null
    this.runtimeData = quoteData.runtime_data ?? null

    if (
      typeof this.runtimeData === "string" ||
      Object.values(this.verifierData ?? []).some(
        (value) => typeof value === "string",
      )
    ) {
      throw new Error("quoteData fields must be Uint8Array")
    }

    this.x25519PublicKey = publicKey
    this.x25519PrivateKey = privateKey

    // If this looks like a Hono app (has a fetch handler), optionally bind the
    // control WebSocket channel using Hono's upgradeWebSocket helper when provided.
    // Otherwise, create an HTTP server to host the control WebSocket channel.
    if (isHonoApp(app)) {
      // Call upgradeWebSocket on the existing Hono server
      if (!config?.upgradeWebSocket) {
        throw new Error("Hono apps must provide { upgradeWebSocket } argument")
      }
      try {
        app.get(
          "/__ra__",
          config.upgradeWebSocket(() => ({
            onOpen: (_event, context) => {
              if (context.raw === undefined) {
                throw new Error("incompatible upgradeWebSocket adapter")
              }
              this.#onControlConnection(context.raw)
            },
          })),
        )
      } catch (e) {
        console.error("Failed to attach Hono upgradeWebSocket control channel")
        throw e
      }
    } else {
      // Express apps will have the http server created during initialize()
    }

    this.heartbeatInterval = config?.heartbeatInterval || 30000
    this.heartbeatTimeout = config?.heartbeatTimeout || 60000

    // Expose a mock WebSocketServer to application code
    this.wss = new ServerRAMockWebSocketServer()

    // Heartbeat to detect dead control sockets and cleanup
    this.heartbeatTimer = setInterval(
      () => this.#heartbeatSweep(),
      this.heartbeatInterval,
    )
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref()
    }

    // http server close handler is attached when server is created
  }

  static async initialize(
    app: TunnelApp,
    getQuote: (x25519PublicKey: Uint8Array) => Promise<QuoteData> | QuoteData,
    config?: TunnelServerConfig,
  ): Promise<TunnelServer> {
    await sodium.ready
    const { publicKey, privateKey } = sodium.crypto_box_keypair()
    const quote = await Promise.resolve(getQuote(publicKey))
    const server = new TunnelServer(app, quote, publicKey, privateKey, config)

    // Setup http and WebSocketServer for Express apps (requires dynamic import)
    if (!config?.upgradeWebSocket) {
      await server.#setupHttpServer()
      await server.#setupWebSocketServer()
    }

    return server
  }

  /**
   * Setup WebSocketServer for Express apps (requires dynamic import of 'ws')
   */
  async #setupWebSocketServer(): Promise<void> {
    try {
      const wsModule = await import("ws")
      const WebSocketServer = wsModule.WebSocketServer
      ;(this as any).controlWss = new WebSocketServer({ noServer: true })
      this.#setupControlChannel()

      if (this.server) {
        this.server.on(
          "upgrade",
          (req: IncomingMessage, socket: Socket, head: Buffer) => {
            const url = req.url || ""
            if (url.startsWith("/__ra__")) {
              this.controlWss!.handleUpgrade(req, socket, head, (controlWs) => {
                this.controlWss!.emit("connection", controlWs, req)
              })
            } else {
              // Don't allow other WebSocket servers to bind to the server;
              // all WebSocket connections go to the encrypted channel.
              socket.destroy()
            }
          },
        )
      }
    } catch (error) {
      throw new Error(
        "ws module is required for Express support but could not be loaded. " +
          "Install it with: npm install ws",
      )
    }
  }

  /**
   * Setup http.Server for Express apps (dynamic import to avoid bundling for Hono)
   */
  async #setupHttpServer(): Promise<void> {
    try {
      const httpModule = await import("http")
      ;(this as any).server = httpModule.createServer(this.app as any)
      if (this.server) {
        this.server.on("close", () => {
          if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = undefined
          }
        })
      }
    } catch (error) {
      throw new Error(
        "http module is required for Express support but could not be loaded",
      )
    }
  }

  /**
   * Intercept incoming WebSocket messages on `this.wss`.
   */
  #setupControlChannel(): void {
    this.controlWss!.on("connection", (controlWs: WebSocket) => {
      debug("New WebSocket connection, setting up control channel")
      this.#onControlConnection(controlWs)
    })
  }

  // Shared setup for a new control channel connection (Hono or ws server)
  #onControlConnection(controlWs: WebSocket): void {
    this.controlClients.add(controlWs)

    // Intercept messages before they reach application handlers
    const originalEmit = controlWs.emit.bind(controlWs)

    // Initialize liveness tracking
    this.livenessBySocket.set(controlWs, {
      isAlive: true,
      lastActivityMs: Date.now(),
    })
    try {
      controlWs.on("pong", () => {
        const l = this.livenessBySocket.get(controlWs)
        if (l) {
          l.isAlive = true
          l.lastActivityMs = Date.now()
        }
      })
    } catch {}

    // Immediately announce server key-exchange public key to the client
    try {
      const serverKxMessage: ControlChannelKXAnnounce = {
        type: "server_kx",
        x25519PublicKey: this.x25519PublicKey,
        quote: this.quote,
        runtime_data: this.runtimeData ? this.runtimeData : null,
        verifier_data: this.verifierData ? this.verifierData : null,
      }
      controlWs.send(encodeCbor(serverKxMessage))
    } catch (e) {
      console.error("Failed to send server_kx message:", e)
    }

    // Cleanup on close
    controlWs.on("close", () => {
      this.controlClients.delete(controlWs)
      this.symmetricKeyBySocket.delete(controlWs)
      this.livenessBySocket.delete(controlWs)

      const toRemove: string[] = []
      for (const [connId, conn] of this.sockets.entries()) {
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
        this.sockets.delete(id)
      }
    })

    controlWs.emit = function (event: string, ...args: any[]): boolean {
      if (event === "message") {
        const ra = (this as any).ra as TunnelServer

        const live = ra.livenessBySocket.get(controlWs)
        if (live) live.lastActivityMs = Date.now()
        // Decode incoming message from client
        let message
        try {
          const data = args[0] as Uint8Array
          message = decodeCbor(data)
        } catch (error: any) {
          console.error("Received invalid CBOR message")
          return true
        }

        // Handle client key exchange
        if (isControlChannelKXConfirm(message)) {
          try {
            // Only accept a single symmetric key per WebSocket
            if (!ra.symmetricKeyBySocket.has(controlWs)) {
              const sealed = message.sealedSymmetricKey
              const opened = sodium.crypto_box_seal_open(
                sealed,
                ra.x25519PublicKey,
                ra.x25519PrivateKey,
              )
              ra.symmetricKeyBySocket.set(controlWs, opened)
            } else {
              console.warn("client_kx received after key already set; ignoring")
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
          debug(`Encrypted HTTP request (${message.requestId}): ${message.url}`)
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

      // Forward all non-message events to the original emitter
      return originalEmit(event, ...args)
    }
    ;(controlWs as any).ra = this
  }

  // Handle tunnel requests by synthesizing requests, and routing to Express or Hono
  async #handleTunnelHttpRequest(
    controlWs: WebSocket,
    tunnelReq: RAEncryptedHTTPRequest,
  ): Promise<void> {
    try {
      const app = this.app
      if (isHonoApp(app)) {
        await this.#handleTunnelHttpRequestHono(controlWs, tunnelReq, app)
      } else {
        await this.#handleTunnelHttpRequestExpress(controlWs, tunnelReq, app)
      }
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

  async #handleTunnelHttpRequestHono(
    controlWs: WebSocket,
    tunnelReq: RAEncryptedHTTPRequest,
    app: Hono,
  ): Promise<void> {
    const urlObj = new URL(tunnelReq.url, "http://localhost")
    const headers = new Headers(tunnelReq.headers || {})

    // Inject pseudo-headers commonly provided by proxies
    if (!headers.has("x-forwarded-proto")) {
      headers.set("x-forwarded-proto", urlObj.protocol.replace(":", ""))
    }
    if (!headers.has("x-forwarded-host")) {
      headers.set("x-forwarded-host", urlObj.host)
    }
    if (!headers.has("x-forwarded-port") && urlObj.port) {
      headers.set("x-forwarded-port", urlObj.port)
    }

    const init: RequestInit = {
      method: tunnelReq.method,
      headers,
    }
    if (
      tunnelReq.body !== undefined &&
      tunnelReq.method !== "GET" &&
      tunnelReq.method !== "HEAD"
    ) {
      init.body = tunnelReq.body
    }
    const request = new Request(urlObj, init)
    // Mark request as arriving via encrypted tunnel for Hono middleware
    try {
      ;(request as any)[ENCRYPTED_REQUEST] = true
    } catch {}
    const response = await app.fetch(request)

    const respHeaders: Record<string, string | string[]> = {}
    response.headers.forEach((value: string, key: string) => {
      const existing = respHeaders[key]
      if (existing === undefined) {
        respHeaders[key] = value
      } else if (Array.isArray(existing)) {
        existing.push(value)
      } else {
        respHeaders[key] = [existing, value]
      }
    })

    // Preserve multiple Set-Cookie values if supported by the runtime
    try {
      const getSetCookie = response.headers.getSetCookie
      if (typeof getSetCookie === "function") {
        const setCookies = getSetCookie.call(response.headers)
        if (Array.isArray(setCookies) && setCookies.length > 0) {
          respHeaders["set-cookie"] = setCookies as string[]
        }
      }
    } catch {}

    let body: string | Uint8Array<ArrayBuffer>
    try {
      const ab = await response.arrayBuffer()
      body = new Uint8Array(ab)
    } catch {
      body = await response.text()
    }

    const resp: RAEncryptedHTTPResponse = {
      type: "http_response",
      requestId: tunnelReq.requestId,
      status: response.status,
      statusText: response.statusText || getStatusText(response.status),
      headers: respHeaders,
      body,
    }
    this.sendEncrypted(controlWs, resp)
  }

  async #handleTunnelHttpRequestExpress(
    controlWs: WebSocket,
    tunnelReq: RAEncryptedHTTPRequest,
    app: Express,
  ): Promise<void> {
    type HttpMocksType = {
      createRequest: typeof createRequest
      createResponse: typeof createResponse
    }
    let httpMocks: HttpMocksType
    let EventEmitter: any

    // Dynamically import node-mocks-http and events if we're using Express
    try {
      httpMocks = (await import("node-mocks-http")).default
    } catch (error) {
      throw new Error(
        "node-mocks-http is required for Express support but could not be loaded",
      )
    }

    try {
      const eventsModule = await import("events")
      EventEmitter = eventsModule.EventEmitter
    } catch (error) {
      throw new Error(
        "events module is required for Express support but could not be loaded",
      )
    }

    const urlObj = new URL(tunnelReq.url, "http://localhost")
    const query: Record<string, string> = {}
    urlObj.searchParams.forEach((value, key) => {
      query[key] = value
    })

    const req = httpMocks.createRequest({
      method: tunnelReq.method as any,
      url: tunnelReq.url,
      path: urlObj.pathname,
      headers: tunnelReq.headers,
      query: query,
    })

    req.body =
      tunnelReq.body !== undefined
        ? parseBody(tunnelReq.body, tunnelReq.headers["content-type"])
        : undefined

    try {
      req.unpipe = (_dest?: any) => {
        debug("req.unpipe called")
        return req
      }
      req.resume = () => {
        debug("req.resume called")
        return req
      }
    } catch {}

    const res = httpMocks.createResponse({
      eventEmitter: EventEmitter,
    })

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

    markRequestAsEncrypted(req)
    app(req, res)
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
          } else if (payload instanceof Uint8Array) {
            messageData = payload
            dataType = "arraybuffer"
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
      this.sockets.set(connectReq.connectionId, {
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
    const connection = this.sockets.get(messageReq.connectionId)
    if (!connection) {
      console.error("Failed to handle tunnel websocket message")
      return
    }

    try {
      connection.mockWs.emitMessage(messageReq.data)
    } catch (error) {
      console.error(
        `Error sending message to WebSocket ${messageReq.connectionId}:`,
        error,
      )
    }
  }

  #handleTunnelWebSocketClose(closeReq: RAEncryptedClientCloseEvent): void {
    const connection = this.sockets.get(closeReq.connectionId)
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
      this.sockets.delete(closeReq.connectionId)
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
    const plaintext = encodeCbor(payload)
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
    return decodeCbor(plaintext)
  }

  /**
   * Encrypt and send a payload.
   */
  private sendEncrypted(controlWs: WebSocket, payload: unknown): void {
    const env = this.#encryptForSocket(controlWs, payload)
    controlWs.send(encodeCbor(env))
    const l = this.livenessBySocket.get(controlWs)
    if (l) l.lastActivityMs = Date.now()
  }

  /**
   * Helper to log current WebSocket connections and whether they have
   * established symmetric keys.
   */
  public logWebSocketConnections(): void {
    try {
      const entries = Array.from(this.sockets.entries())
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

      // Also warn if there are symmetric keys not tied to tracked WS connections,
      // but only if their socket is not currently OPEN. HTTP-only control sockets
      // are expected to have a symmetric key without a tracked WS connection.
      const trackedSockets = new Set(entries.map(([, v]) => v.controlWs))
      const strayKeys = Array.from(this.symmetricKeyBySocket.keys()).filter(
        (controlWs) =>
          !trackedSockets.has(controlWs) && controlWs.readyState !== 1, // WebSocket.OPEN
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

  // Periodic heartbeat to prune dead sockets and cleanup keys
  #heartbeatSweep(): void {
    try {
      const now = Date.now()

      const iterableClients = this.controlWss
        ? Array.from(this.controlWss.clients.values())
        : Array.from(this.controlClients.values())
      for (const ws of iterableClients) {
        const l = this.livenessBySocket.get(ws)
        if (!l) {
          this.livenessBySocket.set(ws, { isAlive: true, lastActivityMs: now })
          try {
            ws.ping()
          } catch {}
          continue
        }

        // If a previous ping went unanswered, terminate to trigger cleanup
        if (
          l.isAlive === false ||
          now - l.lastActivityMs > this.heartbeatTimeout
        ) {
          try {
            ws.terminate()
          } catch {}
          continue
        }

        // Ask for a pong next interval
        l.isAlive = false
        try {
          ws.ping()
        } catch {}
      }

      // Proactively remove keys for sockets that are CLOSED or no longer tracked by ws server
      for (const controlWs of Array.from(this.symmetricKeyBySocket.keys())) {
        const known = this.controlWss
          ? this.controlWss.clients.has(controlWs)
          : this.controlClients.has(controlWs)
        if (controlWs.readyState === 3 || !known) {
          // WebSocket.CLOSED
          this.symmetricKeyBySocket.delete(controlWs)
          this.livenessBySocket.delete(controlWs)
        }
      }
    } catch (e) {
      console.error("Heartbeat sweep failed:", e)
    }
  }
}
