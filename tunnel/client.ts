import {
  TunnelHTTPRequest,
  TunnelHTTPResponse,
  TunnelWSServerEvent,
  TunnelWSMessage,
  TunnelServerKX,
  TunnelClientKX,
  TunnelEncrypted,
} from "./types.js"
import { generateRequestId } from "./utils/client.js"
import { TunnelWebSocket } from "./TunnelWebSocket.js"
import sodium from "libsodium-wrappers"

export class RA {
  public ws: WebSocket | null = null

  public serverX25519PublicKey?: Uint8Array
  public symmetricKey?: Uint8Array // 32 byte key for XSalsa20-Poly1305

  private pendingRequests = new Map<
    string,
    { resolve: (response: Response) => void; reject: (error: Error) => void }
  >()
  private webSocketConnections = new Map<string, TunnelWebSocket>()
  private reconnectDelay = 1000
  private connectionPromise: Promise<void> | null = null

  constructor(private origin: string) {
    this.origin = origin
  }

  static async initialize(origin: string): Promise<RA> {
    await sodium.ready
    return new RA(origin)
  }

  /**
   * Helper for establishing connections. Waits for a connection on `this.ws`,
   * creating a new WebSocket to replace this.ws if necessary.
   */

  public async ensureConnection(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve()
    }

    if (this.connectionPromise) {
      return this.connectionPromise
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      const controlUrl = new URL(this.origin)
      controlUrl.protocol = controlUrl.protocol.replace(/^http/, "ws")
      // Use dedicated control channel path
      controlUrl.pathname = "/__ra__"
      this.ws = new WebSocket(controlUrl.toString())

      this.ws.onopen = () => {
        // Wait for server_kx to complete handshake before resolving
      }

      this.ws.onclose = () => {
        this.connectionPromise = null
        setTimeout(() => {
          this.ensureConnection()
        }, this.reconnectDelay)
      }

      this.ws.onerror = (error) => {
        this.connectionPromise = null
        console.error(error)
        reject(new Error("WebSocket connection failed"))
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          if (message.type === "server_kx") {
            try {
              const serverKx = message as TunnelServerKX
              const serverPub = sodium.from_base64(
                serverKx.x25519PublicKey,
                sodium.base64_variants.ORIGINAL,
              )

              const symmetricKey = sodium.crypto_secretbox_keygen()
              const sealed = sodium.crypto_box_seal(symmetricKey, serverPub)

              this.serverX25519PublicKey = serverPub
              this.symmetricKey = symmetricKey

              const reply: TunnelClientKX = {
                type: "client_kx",
                sealedSymmetricKey: sodium.to_base64(
                  sealed,
                  sodium.base64_variants.ORIGINAL,
                ),
              }
              this.send(reply)

              this.connectionPromise = null
              resolve()
            } catch (e) {
              this.connectionPromise = null
              reject(
                e instanceof Error
                  ? e
                  : new Error("Failed to process server_kx message"),
              )
            }
          } else if (message.type === "enc") {
            // Decrypt and dispatch
            if (!this.symmetricKey) {
              throw new Error("Missing symmetric key for encrypted message")
            }
            const decrypted = this.decryptEnvelope(message as TunnelEncrypted)
            if (decrypted.type === "http_response") {
              this.handleTunnelResponse(decrypted as TunnelHTTPResponse)
            } else if (decrypted.type === "ws_event") {
              this.handleWebSocketTunnelEvent(decrypted as TunnelWSServerEvent)
            } else if (decrypted.type === "ws_message") {
              this.handleWebSocketTunnelMessage(decrypted as TunnelWSMessage)
            }
          }
        } catch (error) {
          console.error("Error parsing WebSocket message:", error)
        }
      }
    })

    return this.connectionPromise
  }

  /**
   * Low-level interfaces to the encrypted WebSocket.
   */

  public send(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Allow plaintext only for client_kx during handshake
      if (typeof message === "object" && message?.type === "client_kx") {
        const data = JSON.stringify(message)
        this.ws.send(data)
        return
      }

      if (!this.symmetricKey) {
        throw new Error("Encryption not ready: missing symmetric key")
      }

      const envelope = this.encryptPayload(message)
      this.ws.send(JSON.stringify(envelope))
    } else {
      throw new Error("WebSocket not connected")
    }
  }

  public getOriginPort(): number {
    const u = new URL(this.origin)
    if (u.port) return Number(u.port)
    return u.protocol === "https:" ? 443 : 80
  }

  private encryptPayload(payload: unknown): TunnelEncrypted {
    if (!this.symmetricKey) {
      throw new Error("Missing symmetric key")
    }
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
    const plaintext = sodium.from_string(JSON.stringify(payload))
    const ciphertext = sodium.crypto_secretbox_easy(
      plaintext,
      nonce,
      this.symmetricKey,
    )
    return {
      type: "enc",
      nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
      ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
    }
  }

  private decryptEnvelope(envelope: TunnelEncrypted): any {
    if (!this.symmetricKey) {
      throw new Error("Missing symmetric key")
    }
    const nonce = sodium.from_base64(
      envelope.nonce,
      sodium.base64_variants.ORIGINAL,
    )
    const ciphertext = sodium.from_base64(
      envelope.ciphertext,
      sodium.base64_variants.ORIGINAL,
    )
    const plaintext = sodium.crypto_secretbox_open_easy(
      ciphertext,
      nonce,
      this.symmetricKey,
    )
    const text = sodium.to_string(plaintext)
    return JSON.parse(text)
  }

  private handleTunnelResponse(response: TunnelHTTPResponse): void {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending) return

    this.pendingRequests.delete(response.requestId)

    if (response.error) {
      pending.reject(new Error(response.error))
      return
    }

    const syntheticResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })

    pending.resolve(syntheticResponse)
  }

  private handleWebSocketTunnelEvent(event: TunnelWSServerEvent): void {
    const connection = this.webSocketConnections.get(event.connectionId)
    if (connection) {
      connection.handleTunnelEvent(event)
    }
  }

  private handleWebSocketTunnelMessage(message: TunnelWSMessage): void {
    const connection = this.webSocketConnections.get(message.connectionId)
    if (connection) {
      connection.handleTunnelMessage(message)
    }
  }

  /**
   * Register and unregister WebSocket mocks.
   */

  public registerWebSocketTunnel(connection: TunnelWebSocket): void {
    this.webSocketConnections.set(connection.connectionId, connection)
  }

  public unregisterWebSocketTunnel(connectionId: string): void {
    this.webSocketConnections.delete(connectionId)
  }

  /**
   * Client methods for encrypted `fetch` and encrypted WebSockets.
   */

  get WebSocket() {
    const self = this
    return class extends TunnelWebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(self, url, protocols)
      }
    }
  }

  get fetch() {
    return async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      await this.ensureConnection()

      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      const method = init?.method || "GET"
      const headers: Record<string, string> = {}

      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((value, key) => {
            headers[key] = value
          })
        } else if (Array.isArray(init.headers)) {
          init.headers.forEach(([key, value]) => {
            headers[key] = value
          })
        } else {
          Object.assign(headers, init.headers)
        }
      }

      let body: string | undefined
      if (init?.body) {
        if (typeof init.body === "string") {
          body = init.body
        } else {
          body = JSON.stringify(init.body)
        }
      }

      const requestId = generateRequestId()
      const tunnelRequest: TunnelHTTPRequest = {
        type: "http_request",
        requestId,
        method,
        url,
        headers,
        body,
      }

      return new Promise<Response>((resolve, reject) => {
        this.pendingRequests.set(requestId, { resolve, reject })

        try {
          this.send(tunnelRequest)
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("WebSocket not connected"),
          )
          return
        }

        // Time out fetch requests after 30 seconds.
        const timer = setTimeout(() => {
          if (this.pendingRequests.has(requestId)) {
            this.pendingRequests.delete(requestId)
            reject(new Error("Request timeout"))
          }
        }, 30000)

        if (typeof timer.unref === "function") {
          timer.unref()
        }
      })
    }
  }
}
