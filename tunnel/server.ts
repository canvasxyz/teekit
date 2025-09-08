import http from "http"
import { WebSocketServer, WebSocket } from "ws"
import { Express } from "express"
import httpMocks from "node-mocks-http"
import { EventEmitter } from "events"
import {
  TunnelRequest,
  TunnelResponse,
  TunnelWebSocketConnect,
  TunnelWebSocketMessage,
  TunnelWebSocketClose,
  TunnelWebSocketEvent,
} from "./types.js"
import { parseBody, sanitizeHeaders, getStatusText } from "./utils/server.js"

export class RA {
  public server: http.Server
  public wss: WebSocketServer
  private app: Express
  private webSocketConnections = new Map<
    string,
    { ws: WebSocket; tunnelWs: WebSocket }
  >()

  constructor(app: Express) {
    this.app = app
    this.server = http.createServer(app)
    this.wss = new WebSocketServer({ server: this.server })

    this.setupTunnelHandler()
  }

  private setupTunnelHandler(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      console.log("Setting up tunnel handler")

      // Intercept messages before they reach application handlers
      const originalEmit = ws.emit.bind(ws)

      ws.emit = function (event: string, ...args: any[]): boolean {
        if (event === "message") {
          const data = args[0] as Buffer
          try {
            const message = JSON.parse(data.toString())

            if (message.type === "tunnel_request") {
              console.log(
                "Tunnel request received:",
                message.requestId,
                message.url,
              )
              ;(this as any).ra
                .handleTunnelRequest(ws, message as TunnelRequest)
                .catch((error: Error) => {
                  console.error("Error handling tunnel request:", error)

                  // Send 500 error response back to client
                  const errorResponse = {
                    type: "tunnel_response",
                    requestId: message.requestId,
                    status: 500,
                    statusText: "Internal Server Error",
                    headers: {},
                    body: "",
                    error: error.message,
                  }

                  try {
                    ws.send(JSON.stringify(errorResponse))
                  } catch (sendError) {
                    console.error("Failed to send error response:", sendError)
                  }
                })
              return true
            } else if (message.type === "ws_connect") {
              console.log(
                "WebSocket connect request:",
                message.connectionId,
                message.url,
              )
              ;(this as any).ra.handleWebSocketConnect(
                ws,
                message as TunnelWebSocketConnect,
              )
              return true
            } else if (message.type === "ws_message") {
              ;(this as any).ra.handleWebSocketMessage(
                message as TunnelWebSocketMessage,
              )
              return true
            } else if (message.type === "ws_close") {
              ;(this as any).ra.handleWebSocketClose(
                message as TunnelWebSocketClose,
              )
              return true
            }
          } catch (error) {
            // If parsing fails, fall through to application
          }
        }

        // For non-tunnel messages, use original emit
        return originalEmit(event, ...args)
      }
      ;(ws as any).ra = this
    })
  }

  // Handle tunnel requests by synthesizing `fetch` events and passing
  // them to express
  async handleTunnelRequest(
    ws: WebSocket,
    tunnelReq: TunnelRequest,
  ): Promise<void> {
    try {
      // Parse URL to extract pathname and query
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
        const response: TunnelResponse = {
          type: "tunnel_response",
          requestId: tunnelReq.requestId,
          status: res.statusCode,
          statusText: res.statusMessage || getStatusText(res.statusCode),
          headers: sanitizeHeaders(res.getHeaders()),
          body: res._getData(),
        }

        ws.send(JSON.stringify(response))
      })

      // Handle errors generically. TODO: better error handling.
      res.on("error", (error) => {
        const errorResponse: TunnelResponse = {
          type: "tunnel_response",
          requestId: tunnelReq.requestId,
          status: 500,
          statusText: "Internal Server Error",
          headers: {},
          body: "",
          error: error.message,
        }

        ws.send(JSON.stringify(errorResponse))
      })

      // Execute the request against the Express app
      this.app(req, res)
    } catch (error) {
      const errorResponse: TunnelResponse = {
        type: "tunnel_response",
        requestId: tunnelReq.requestId,
        status: 500,
        statusText: "Internal Server Error",
        headers: {},
        body: "",
        error: error instanceof Error ? error.message : "Unknown error",
      }

      ws.send(JSON.stringify(errorResponse))
    }
  }

  async handleWebSocketConnect(
    tunnelWs: WebSocket,
    connectReq: TunnelWebSocketConnect,
  ): Promise<void> {
    try {
      console.log(`Creating WebSocket connection to ${connectReq.url}`)

      const ws = new WebSocket(connectReq.url, connectReq.protocols)

      // Store the connection
      this.webSocketConnections.set(connectReq.connectionId, { ws, tunnelWs })

      ws.on("open", () => {
        console.log(`WebSocket ${connectReq.connectionId} connected`)
        const event: TunnelWebSocketEvent = {
          type: "ws_event",
          connectionId: connectReq.connectionId,
          eventType: "open",
        }
        tunnelWs.send(JSON.stringify(event))
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

        const message: TunnelWebSocketMessage = {
          type: "ws_message",
          connectionId: connectReq.connectionId,
          data: messageData,
          dataType: dataType,
        }
        tunnelWs.send(JSON.stringify(message))
      })

      ws.on("close", (code: number, reason: Buffer) => {
        console.log(`WebSocket ${connectReq.connectionId} closed`)
        const event: TunnelWebSocketEvent = {
          type: "ws_event",
          connectionId: connectReq.connectionId,
          eventType: "close",
          code,
          reason: reason.toString(),
        }
        tunnelWs.send(JSON.stringify(event))
        this.webSocketConnections.delete(connectReq.connectionId)
      })

      ws.on("error", (error: Error) => {
        console.log(
          `WebSocket ${connectReq.connectionId} error:`,
          error.message,
        )
        const event: TunnelWebSocketEvent = {
          type: "ws_event",
          connectionId: connectReq.connectionId,
          eventType: "error",
          error: error.message,
        }
        tunnelWs.send(JSON.stringify(event))
      })
    } catch (error) {
      console.error("Error creating WebSocket connection:", error)
      const event: TunnelWebSocketEvent = {
        type: "ws_event",
        connectionId: connectReq.connectionId,
        eventType: "error",
        error: error instanceof Error ? error.message : "Connection failed",
      }
      tunnelWs.send(JSON.stringify(event))
    }
  }

  handleWebSocketMessage(messageReq: TunnelWebSocketMessage): void {
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
          error,
        )
      }
    }
  }

  handleWebSocketClose(closeReq: TunnelWebSocketClose): void {
    const connection = this.webSocketConnections.get(closeReq.connectionId)
    if (connection) {
      try {
        connection.ws.close(closeReq.code, closeReq.reason)
      } catch (error) {
        console.error(
          `Error closing WebSocket ${closeReq.connectionId}:`,
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
}
