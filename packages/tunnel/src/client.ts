import sodium from "libsodium-wrappers"
import {
  hex,
  parseSgxQuote,
  parseTdxQuote,
  SgxQuote,
  TdxQuote,
  verifySgx,
  verifyTdx,
} from "ra-https-qvl"
import { base64 as scureBase64 } from "@scure/base"
import { encode, decode } from "cbor-x"
import createDebug from "debug"

import {
  RAEncryptedHTTPRequest,
  RAEncryptedHTTPResponse,
  RAEncryptedServerEvent,
  RAEncryptedWSMessage,
  ControlChannelKXConfirm,
  ControlChannelEncryptedMessage,
  RAEncryptedMessage,
} from "./types.js"
import {
  isControlChannelEncryptedMessage,
  isControlChannelKXAnnounce,
  isControlChannelKXConfirm,
  isRAEncryptedHTTPResponse,
  isRAEncryptedServerEvent,
  isRAEncryptedWSMessage,
} from "./typeguards.js"
import { generateRequestId } from "./utils/client.js"
import { ClientRAMockWebSocket } from "./ClientRAWebSocket.js"

export type TunnelClientConfig = {
  mrtd?: string
  report_data?: string
  match?: (quote: TdxQuote | SgxQuote) => boolean
  sgx?: boolean // default to TDX
}

const debug = createDebug("ra-https:TunnelClient")

/**
 * Client for opening an encrypted remote-attested channel.
 *
 * const enc = await TunnelClient.initialize(baseUrl, {
 *   mtrd: 'any',
 *   report_data: '0000....',
 *   match: (quote) => {
 *     return true // custom validation logic goes here
 *   }
 * })
 *
 * enc.fetch("https://...")
 *
 * const ws = new enc.WebSocket(wsUrl)
 * ws.onMessage = (event: MessageEvent) => { ... }
 * ws.onOpen = () => { ... }
 * ws.onClose = () => { ... }
 */
export class TunnelClient {
  public id: string
  public ws: WebSocket | null = null

  public serverX25519PublicKey?: Uint8Array
  public symmetricKey?: Uint8Array // 32 byte key for XSalsa20-Poly1305

  private pendingRequests = new Map<
    string,
    { resolve: (response: Response) => void; reject: (error: Error) => void }
  >()
  private webSocketConnections = new Map<string, ClientRAMockWebSocket>()
  private reconnectDelay = 1000
  private connectionPromise: Promise<void> | null = null
  private config: TunnelClientConfig

  private constructor(
    public readonly origin: string,
    config: TunnelClientConfig,
  ) {
    this.id = Math.random().toString().slice(2)
    this.config = config
  }

  static async initialize(
    origin: string,
    config: TunnelClientConfig,
  ): Promise<TunnelClient> {
    await sodium.ready
    return new TunnelClient(origin, config)
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
      this.ws.binaryType = "arraybuffer"

      this.ws.onopen = () => {
        // Wait for server_kx to complete handshake before resolving
      }

      this.ws.onclose = () => {
        this.connectionPromise = null
        // Propagate disconnect to all tunneled WebSockets
        try {
          for (const [
            connectionId,
            connection,
          ] of this.webSocketConnections.entries()) {
            connection.handleTunnelEvent({
              type: "ws_event",
              connectionId,
              eventType: "close",
              code: 1006,
              reason: "tunnel closed",
            } as RAEncryptedServerEvent)
          }
          this.webSocketConnections.clear()
        } catch (e) {
          console.error(
            "Failed to propagate tunnel close to WS connections:",
            e,
          )
        }

        // Fail any pending fetch requests
        try {
          for (const [, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error("Tunnel disconnected"))
          }
          this.pendingRequests.clear()
        } catch {}

        // Drop symmetric key; a new handshake will set it on reconnect
        this.symmetricKey = undefined
        setTimeout(() => {
          this.ensureConnection()
        }, this.reconnectDelay)
      }

      this.ws.onerror = (error) => {
        this.connectionPromise = null
        console.error(error)

        // Inform all tunneled WebSockets about the error
        try {
          for (const [
            connectionId,
            connection,
          ] of this.webSocketConnections.entries()) {
            connection.handleTunnelEvent({
              type: "ws_event",
              connectionId,
              eventType: "error",
              error: (error as any)?.message || "Tunnel error",
            } as RAEncryptedServerEvent)
          }
        } catch {}

        // If not open, attempt reconnect soon; close handler will also handle it
        try {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            setTimeout(() => {
              this.ensureConnection()
            }, this.reconnectDelay)
          }
        } catch {}

        reject(new Error("WebSocket connection failed"))
      }

      this.ws.onmessage = async (event) => {
        // Normalize incoming bytes in WebSocket messages
        let message
        try {
          let bytes: Uint8Array
          if (typeof event.data === "string") {
            // Handle data encoded as string
            bytes = new TextEncoder().encode(event.data)
          } else if (event.data instanceof ArrayBuffer) {
            // Handle all ArrayBuffers as Uint8Array
            bytes = new Uint8Array(event.data)
          } else if (typeof event.data?.arrayBuffer === "function") {
            // Handle Blob-like payloads from browser WebSockets
            const buf = await event.data.arrayBuffer()
            bytes = new Uint8Array(buf)
          } else {
            bytes = new Uint8Array(event.data)
          }
          message = decode(bytes)
        } catch (error) {
          console.error("Error parsing WebSocket message:", error)
        }

        if (isControlChannelKXAnnounce(message)) {
          let valid, validQuote, mrtd, report_data

          // Parse and validate quote provided by the control channel
          if (!message.quote || message.quote.length === 0) {
            throw new Error("Error opening channel: empty quote")
          }
          const quote = scureBase64.decode(message.quote)
          if (this.config.sgx) {
            valid = await verifySgx(quote)
            validQuote = parseSgxQuote(quote)
            mrtd = validQuote.body.mr_enclave
            report_data = validQuote.body.report_data
          } else {
            valid = await verifyTdx(quote)
            validQuote = parseTdxQuote(quote)
            mrtd = validQuote.body.mr_td
            report_data = validQuote.body.report_data
          }

          if (!valid) {
            throw new Error("Error opening channel: invalid quote")
          }
          if (
            this.config.mrtd !== undefined &&
            hex(mrtd) !== this.config.mrtd
          ) {
            throw new Error("Error opening channel: invalid mrtd")
          }
          if (
            this.config.report_data !== undefined &&
            hex(report_data) !== this.config.report_data
          ) {
            throw new Error("Error opening channel: invalid report_data")
          }
          if (
            this.config.match !== undefined &&
            this.config.match(validQuote) !== true
          ) {
            throw new Error("Error opening channel: custom validation failed")
          }

          // Generate and send a symmetric encryption key
          try {
            const serverPub = sodium.from_base64(
              message.x25519PublicKey,
              sodium.base64_variants.ORIGINAL,
            )

            const symmetricKey = sodium.crypto_secretbox_keygen()
            const sealed = sodium.crypto_box_seal(symmetricKey, serverPub)

            this.serverX25519PublicKey = serverPub
            this.symmetricKey = symmetricKey

            const reply: ControlChannelKXConfirm = {
              type: "client_kx",
              sealedSymmetricKey: sodium.to_base64(
                sealed,
                sodium.base64_variants.ORIGINAL,
              ),
            }
            this.send(reply)

            this.connectionPromise = null
            debug("Opened encrypted channel to", this.origin)
            resolve()
          } catch (e) {
            this.connectionPromise = null
            reject(
              e instanceof Error
                ? e
                : new Error("Failed to process server_kx message"),
            )
          }
        } else if (isControlChannelEncryptedMessage(message)) {
          // Decrypt and dispatch
          if (!this.symmetricKey) {
            throw new Error("Missing symmetric key for encrypted message")
          }
          const decrypted = this.#decryptEnvelope(message)

          if (isRAEncryptedHTTPResponse(decrypted)) {
            this.#handleTunnelResponse(decrypted)
          } else if (isRAEncryptedServerEvent(decrypted)) {
            this.#handleWebSocketTunnelEvent(decrypted)
          } else if (isRAEncryptedWSMessage(decrypted)) {
            this.#handleWebSocketTunnelMessage(decrypted)
          }
        }
      }
    })

    return this.connectionPromise
  }

  /**
   * Direct interface to the encrypted WebSocket.
   */
  public send(message: RAEncryptedMessage | ControlChannelKXConfirm): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send unencrypted client_kx messages during handshake
      if (isControlChannelKXConfirm(message)) {
        const data = encode(message)
        this.ws.send(data)
        return
      }

      // Require encryption for all other messages
      if (!this.symmetricKey) {
        throw new Error("Encryption not ready: missing symmetric key")
      }

      const envelope = this.#encryptPayload(message)
      this.ws.send(encode(envelope))
    } else {
      throw new Error("WebSocket not connected")
    }
  }

  #encryptPayload(payload: RAEncryptedMessage): ControlChannelEncryptedMessage {
    if (!this.symmetricKey) {
      throw new Error("Missing symmetric key")
    }
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
    const plaintext = encode(payload)
    const ciphertext = sodium.crypto_secretbox_easy(
      plaintext,
      nonce,
      this.symmetricKey,
    )
    return {
      type: "enc",
      nonce: nonce,
      ciphertext: ciphertext,
    }
  }

  #decryptEnvelope(envelope: ControlChannelEncryptedMessage): unknown {
    if (!this.symmetricKey) {
      throw new Error("Missing symmetric key")
    }
    const nonce = envelope.nonce
    const ciphertext = envelope.ciphertext
    const plaintext = sodium.crypto_secretbox_open_easy(
      ciphertext,
      nonce,
      this.symmetricKey,
    )
    return decode(plaintext)
  }

  #handleTunnelResponse(response: RAEncryptedHTTPResponse): void {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending) return

    this.pendingRequests.delete(response.requestId)

    if (response.error) {
      pending.reject(new Error(response.error))
      return
    }

    const syntheticResponse = new Response(
      response.status === 204 ? null : response.body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    )

    pending.resolve(syntheticResponse)
  }

  #handleWebSocketTunnelEvent(event: RAEncryptedServerEvent): void {
    const connection = this.webSocketConnections.get(event.connectionId)
    if (connection) {
      connection.handleTunnelEvent(event)
    }
  }

  #handleWebSocketTunnelMessage(message: RAEncryptedWSMessage): void {
    const connection = this.webSocketConnections.get(message.connectionId)
    if (connection) {
      connection.handleTunnelMessage(message)
    }
  }

  /**
   * Register and unregister WebSocket mocks.
   */

  public registerWebSocketTunnel(connection: ClientRAMockWebSocket): void {
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
    return class extends ClientRAMockWebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(self, url, protocols)
      }
    } as any // TODO
  }

  get fetch() {
    return async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      await this.ensureConnection()

      // Normalize Request input to capture url, method, headers, and body
      let url: string
      let method: string
      const headers: Record<string, string> = {}
      let requestBody: BodyInit | null | undefined

      if (typeof input === "string") {
        url = input
        method = init?.method || "GET"
        requestBody = init?.body ?? null
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
      } else if (input instanceof URL) {
        url = input.toString()
        method = init?.method || "GET"
        requestBody = init?.body ?? null
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
      } else {
        // input is a Request object
        url = input.url
        method = input.method || "GET"
        input.headers.forEach((value, key) => {
          headers[key] = value
        })
        // If init provided, it can override Request fields
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
        if (init?.method) method = init.method
        requestBody = init?.body ?? (input as any).body ?? null
      }

      // Normalize body to string by reading ReadableStream or Buffer-like
      let body: string | undefined
      if (requestBody !== undefined && requestBody !== null) {
        if (typeof requestBody === "string") {
          body = requestBody
        } else if (
          typeof (requestBody as any).arrayBuffer === "function"
        ) {
          // Blob, FormData (stringify), or ReadableStream with arrayBuffer
          const ab = await (requestBody as any).arrayBuffer()
          body = new TextDecoder().decode(new Uint8Array(ab))
        } else if (requestBody instanceof Uint8Array) {
          body = new TextDecoder().decode(requestBody)
        } else if (requestBody instanceof ArrayBuffer) {
          body = new TextDecoder().decode(new Uint8Array(requestBody))
        } else if (
          typeof (globalThis as any).ReadableStream !== "undefined" &&
          requestBody instanceof (globalThis as any).ReadableStream
        ) {
          // Read ReadableStream to string
          const reader = (requestBody as any).getReader()
          const chunks: Uint8Array[] = []
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) chunks.push(value)
          }
          const totalLen = chunks.reduce((acc, c) => acc + c.length, 0)
          const merged = new Uint8Array(totalLen)
          let offset = 0
          for (const c of chunks) {
            merged.set(c, offset)
            offset += c.length
          }
          body = new TextDecoder().decode(merged)
        } else {
          // Fallback: JSON stringify unknown bodies
          body = JSON.stringify(requestBody as any)
        }
      }

      const requestId = generateRequestId()
      const tunnelRequest: RAEncryptedHTTPRequest = {
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
