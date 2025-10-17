import type { Server as HttpServer, IncomingMessage } from "http"
import type { Socket } from "net"
import type { WebSocketServer, WebSocket } from "ws"
import sodium from "./crypto.js"
import { encode as encodeCbor, decode as decodeCbor } from "cbor-x"
import createDebug from "debug"
import type {
  createRequest,
  createResponse,
  RequestMethod,
} from "node-mocks-http"
import type { Express } from "express"
import type { Context, Env, Hono } from "hono"
import type { NodeWebSocket } from "@hono/node-ws"
import type { UpgradeWebSocket, WSContext, WSEvents } from "hono/ws"

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

type TunnelExtraContext<TApp extends TunnelApp> = TApp extends Hono<any, any, any>
  ? Context
  : undefined

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

export class TunnelServer<TApp extends TunnelApp = TunnelApp> {
  public server?: HttpServer
  public quote: Uint8Array | null = null
  public verifierData: VerifierData | null = null
  public runtimeData: Uint8Array | null = null
  public readonly wss: ServerRAMockWebSocketServer<TunnelExtraContext<TApp>>

  private controlWss?: WebSocketServer // for express
  private controlClients = new Set<WebSocket | WSContext>() // for hono/workerd

  public x25519PublicKey: Uint8Array | null = null
  private x25519PrivateKey: Uint8Array | null = null

  private sockets = new Map<
    string,
    {
      mockWs: ServerRAMockWebSocket<TunnelExtraContext<TApp>>
      controlWs: WebSocket | WSContext
    }
  >()
  private symmetricKeyBySocket = new Map<any, Uint8Array>()
  private livenessBySocket = new Map<
    any,
    { isAlive: boolean; lastActivityMs: number }
  >()
  private envBySocket = new Map<any, Env>()
  private extraContextBySocket = new Map<any, TunnelExtraContext<TApp>>()
  private heartbeatTimer?: ReturnType<typeof setInterval>

  private heartbeatInterval: number
  private heartbeatTimeout: number

  private keyReady: boolean

  private constructor(
    public readonly app: TApp,
    private getQuote: (
      x25519PublicKey: Uint8Array,
    ) => Promise<QuoteData> | QuoteData,
    config?: TunnelServerConfig,
  ) {
    this.keyReady = false
    this.wss = new ServerRAMockWebSocketServer<TunnelExtraContext<TApp>>()

    this.heartbeatInterval = config?.heartbeatInterval || 30000
    this.heartbeatTimeout = config?.heartbeatTimeout || 60000

    // Only enable Node-style heartbeat when using Node ws server
    if (!isHonoApp(app)) {
      this.heartbeatTimer = setInterval(
        () => this.#heartbeatSweep(),
        this.heartbeatInterval,
      )
      if (typeof this.heartbeatTimer.unref === "function") {
        this.heartbeatTimer.unref()
      }
    }

    // If this looks like a Hono app (has a fetch handler), bind the control
    // WebSocket channel using Hono's upgradeWebSocket helper.
    //
    // Otherwise, Express apps will have WebSocket messages handled via an
    // http server, created immediately after this constructor returns.
    if (isHonoApp(app)) {
      this.#setupHonoWebSocketChannel(app, config)
    }

    // Also get a quote
    this.#getQuote()
  }

  static async initialize<TApp extends TunnelApp>(
    app: TApp,
    getQuote: (x25519PublicKey: Uint8Array) => Promise<QuoteData> | QuoteData,
    config?: TunnelServerConfig,
  ): Promise<TunnelServer<TApp>> {
    const server = new TunnelServer<TApp>(app, getQuote, config)

    // Setup http and WebSocketServer for Express apps
    if (!config?.upgradeWebSocket) {
      await server.#setupExpressHttpServer()
      await server.#bindExpressWebSocketServer()
    }

    return server
  }

  async #setupHonoWebSocketChannel(app: Hono, config?: TunnelServerConfig) {
    if (!config?.upgradeWebSocket) {
      throw new Error("Hono apps must provide { upgradeWebSocket } argument")
    }

    try {
      app.get(
        "/__ra__",
        config.upgradeWebSocket((c: Context) => {
          // Capture env outside the handlers since it's available in the upgrade context
          const env = c.env
          const self = this
          let wsInitialized = false
          return {
            onOpen: (_event, ws) => {
              // Initialize when onOpen is called, for Node.js WS environments
              if (!wsInitialized) {
                wsInitialized = true
                self.#onHonoOpen(
                  ws,
                  env,
                  c as TunnelExtraContext<TApp>,
                )
              }
            },
            onMessage: async (event, ws) => {
              try {
                // Initialize on first message, if onOpen isn't called in non-Node environments
                if (!wsInitialized) {
                  wsInitialized = true
                  self.#onHonoOpen(
                    ws,
                    env,
                    c as TunnelExtraContext<TApp>,
                  )
                }

                // Decode incoming messages
                let bytes: Uint8Array
                if (typeof event.data === "string") {
                  bytes = new TextEncoder().encode(event.data)
                } else if (event.data instanceof Uint8Array) {
                  bytes = event.data
                } else if (event.data instanceof ArrayBuffer) {
                  bytes = new Uint8Array(event.data)
                } else if (ArrayBuffer.isView(event.data)) {
                  const view = event.data as ArrayBufferView
                  bytes = new Uint8Array(
                    view.buffer as ArrayBuffer,
                    view.byteOffset,
                    view.byteLength,
                  )
                } else if (event.data instanceof Blob) {
                  bytes = new Uint8Array(await event.data.arrayBuffer())
                } else {
                  bytes = new Uint8Array(event.data)
                }
                self.#onHonoMessage(ws, bytes)
              } catch (e) {
                console.error("Failed to process Hono WS message:", e)
              }
            },
            onClose: (_event, ws) => {
              self.#onHonoClose(ws)
            },
            onError: (event) => {
              console.error("Control channel error:", event)
            },
          } as WSEvents
        }),
      )
    } catch (e) {
      console.error("Failed to attach Hono upgradeWebSocket control channel")
      throw e
    }
  }

  async #setupExpressHttpServer(): Promise<void> {
    try {
      const httpModule = await import("http")
      this.server = httpModule.createServer(this.app as any) // TODO
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
   * Setup WebSocketServer for Express apps, bind to `this.server`
   */
  async #bindExpressWebSocketServer(): Promise<void> {
    const wsModule = await import("ws")
    const WebSocketServer = wsModule.WebSocketServer
    this.controlWss = new WebSocketServer({ noServer: true })

    this.controlWss!.on("connection", (controlWs: WebSocket) => {
      debug("New WebSocket connection, setting up control channel")
      this.#onExpressControlConnection(controlWs)
    })

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
  }

  #onHonoOpen(
    controlWs: WebSocket | WSContext,
    env: Env,
    extraContext: TunnelExtraContext<TApp>,
  ): void {
    this.controlClients.add(controlWs)
    this.envBySocket.set(controlWs, env)
    this.extraContextBySocket.set(controlWs, extraContext)

    // Run async initialization without blocking the onOpen callback
    this.#sendServerKx(controlWs).catch((e) => {
      console.error("sendServerKx failed:", e)
      controlWs.close(1011, "Initialization failed")
    })
  }

  #onHonoMessage(controlWs: WSContext, bytes: Uint8Array): void {
    this.#handleControlMessage(controlWs, bytes)
  }

  #onHonoClose(controlWs: WSContext): void {
    this.controlClients.delete(controlWs)
    this.symmetricKeyBySocket.delete(controlWs)
    this.livenessBySocket.delete(controlWs)
    this.envBySocket.delete(controlWs)
    this.extraContextBySocket.delete(controlWs)

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
  }

  // Shared setup for a new control channel connection
  async #onExpressControlConnection(controlWs: WebSocket): Promise<void> {
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

    // Run async initialization without blocking the connection callback
    this.#sendServerKx(controlWs).catch((e) => {
      console.error("sendServerKx failed:", e)
      controlWs.close(1011, "Initialization failed")
    })

    // Cleanup on close
    controlWs.on("close", () => {
      this.controlClients.delete(controlWs)
      this.symmetricKeyBySocket.delete(controlWs)
      this.livenessBySocket.delete(controlWs)
      this.extraContextBySocket.delete(controlWs)

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
        try {
          const data = args[0] as Uint8Array
          ra.#handleControlMessage(controlWs, data)
        } catch (e) {
          console.error("Failed to process control message:", e)
        }
      }

      // Forward all non-message events to the original emitter
      return originalEmit(event, ...args)
    }
    ;(controlWs as any).ra = this
  }

  async #getQuote() {
    const keypair = sodium.crypto_box_keypair()
    this.x25519PublicKey = keypair.publicKey
    this.x25519PrivateKey = keypair.privateKey
    const quoteData = await this.getQuote(this.x25519PublicKey)
    this.quote = quoteData.quote
    this.verifierData = quoteData.verifier_data ?? null
    this.runtimeData = quoteData.runtime_data ?? null
    this.keyReady = true
  }

  // Shared server kx
  async #sendServerKx(controlWs: WebSocket | WSContext): Promise<void> {
    if (!this.keyReady) {
      try {
        await this.#getQuote()
      } catch (e) {
        console.error("Quote fetch failed:", e)
        try {
          controlWs.close(1011, "Initialization failed")
        } catch {}
      }
    }

    if (this.x25519PublicKey === null || this.quote === null) {
      throw new Error("expected publickey, privatekey, quote to be set")
    }

    // Announce server key-exchange public key to the client
    try {
      const serverKxMessage: ControlChannelKXAnnounce = {
        type: "server_kx",
        x25519PublicKey: this.x25519PublicKey,
        quote: this.quote,
        runtime_data: this.runtimeData ? this.runtimeData : null,
        verifier_data: this.verifierData ? this.verifierData : null,
      }
      controlWs.send(encodeCbor(serverKxMessage) as unknown as ArrayBuffer)
    } catch (e) {
      console.error("Failed to send server_kx message:", e)
    }
  }

  // Handle generic control messages, by completing KX or calling handleTunnel methods
  async #handleControlMessage(
    controlWs: WebSocket | WSContext,
    bytes: Uint8Array,
  ): Promise<void> {
    const live = this.livenessBySocket.get(controlWs)
    if (live) live.lastActivityMs = Date.now()

    let message: unknown
    try {
      message = decodeCbor(bytes)
    } catch (error) {
      console.error("Received invalid CBOR message")
      return
    }

    if (this.x25519PublicKey === null || this.x25519PrivateKey === null) {
      throw new Error("expected publickey, privatekey, quote to be set")
    }

    if (isControlChannelKXConfirm(message)) {
      try {
        if (!this.symmetricKeyBySocket.has(controlWs)) {
          const sealed = message.sealedSymmetricKey
          const opened = sodium.crypto_box_seal_open(
            sealed,
            this.x25519PublicKey,
            this.x25519PrivateKey,
          )
          this.symmetricKeyBySocket.set(controlWs, opened)
        } else {
          debug("client_kx received after key already set; ignoring")
        }
      } catch (e) {
        console.error("Failed to process client_kx:", e)
      }
      return
    }

    if (!this.symmetricKeyBySocket.has(controlWs)) {
      debug("Dropping message before handshake completion")
      return
    }

    if (!isControlChannelEncryptedMessage(message)) {
      debug("Dropping non-encrypted message post-handshake")
      return
    }

    try {
      message = this.#decryptEnvelopeForSocket(
        controlWs,
        message as ControlChannelEncryptedMessage,
      )
    } catch (e) {
      console.error("Failed to decrypt envelope:", e)
      return
    }

    if (isRAEncryptedHTTPRequest(message)) {
      this.logWebSocketConnections()
      debug(`Encrypted HTTP request (${message.requestId}): ${message.url}`)
      this.#handleTunnelHttpRequest(controlWs, message).catch(
        (error: Error) => {
          console.error("Error handling encrypted request:", error)
          try {
            this.sendEncrypted(controlWs, {
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
      return
    }

    if (isRAEncryptedClientConnectEvent(message)) {
      this.#handleTunnelWebSocketConnect(controlWs, message)
      return
    }
    if (isRAEncryptedWSMessage(message)) {
      this.#handleTunnelWebSocketMessage(message)
      return
    }
    if (isRAEncryptedClientCloseEvent(message)) {
      this.#handleTunnelWebSocketClose(message)
      return
    }
  }

  // Handle tunnel requests by synthesizing requests, and routing to Express or Hono
  async #handleTunnelHttpRequest(
    controlWs: WebSocket | WSContext,
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
    controlWs: WebSocket | WSContext,
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
    // Propagate per-socket env (for DB/QUOTE bindings) when available
    const env = this.envBySocket.get(controlWs)
    const response = await app.fetch(request, env)

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
    controlWs: WebSocket | WSContext,
    tunnelReq: RAEncryptedHTTPRequest,
    app: Express | Hono,
  ): Promise<void> {
    type HttpMocksType = {
      createRequest: typeof createRequest
      createResponse: typeof createResponse
    }
    let httpMocks: HttpMocksType
    let EventEmitter

    if (isHonoApp(app)) {
      throw new Error("unexpected: express app should not export fetch")
    }

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
      method: tunnelReq.method as RequestMethod,
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
      req.unpipe = () => {
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
    controlWs: WebSocket | WSContext,
    connectReq: RAEncryptedClientConnectEvent,
  ): Promise<void> {
    try {
      const extraContext = this.extraContextBySocket.get(controlWs)
      if (isHonoApp(this.app) && extraContext === undefined) {
        throw new Error("Missing Hono context for WebSocket connection")
      }
      // Create a mock socket and expose it to application via mock server
      const mock = new ServerRAMockWebSocket<TunnelExtraContext<TApp>>(
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
        extraContext as TunnelExtraContext<TApp>,
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
    controlWs: WebSocket | WSContext,
    payload: unknown,
  ): ControlChannelEncryptedMessage {
    const key = this.symmetricKeyBySocket.get(controlWs)
    if (!key) {
      this.logWebSocketConnections()
      throw new Error("Missing symmetric key for socket (outbound)")
    }
    const nonce = new Uint8Array(24)
    crypto.getRandomValues(nonce)
    const plaintext = encodeCbor(payload)
    const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key)
    return {
      type: "enc",
      nonce: nonce,
      ciphertext: ciphertext,
    }
  }

  #decryptEnvelopeForSocket(
    controlWs: WebSocket | WSContext,
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
  private sendEncrypted(
    controlWs: WebSocket | WSContext,
    payload: unknown,
  ): void {
    const env = this.#encryptForSocket(controlWs, payload)
    controlWs.send(encodeCbor(env) as unknown as ArrayBuffer)
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

  // TODO: Make sure heartbeat sweep works on Hono WSContext.
  #heartbeatSweep(): void {
    const now = Date.now()
    const iterableClients = this.controlWss
      ? Array.from(this.controlWss.clients.values())
      : Array.from(this.controlClients.values())

    // Periodic heartbeat to prune dead sockets and cleanup keys
    for (const ws of iterableClients) {
      const l = this.livenessBySocket.get(ws)
      if (!l) {
        this.livenessBySocket.set(ws, { isAlive: true, lastActivityMs: now })
        if ("ping" in ws) ws.ping()
        continue
      }

      // If a previous ping went unanswered, terminate to trigger cleanup
      if (
        l.isAlive === false ||
        now - l.lastActivityMs > this.heartbeatTimeout
      ) {
        if ("terminate" in ws) ws.terminate()
        continue
      }

      // Ask for a pong next interval
      l.isAlive = false
      if ("ping" in ws) ws.ping()
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
  }
}
