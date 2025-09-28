import sodium from "libsodium-wrappers"
import {
  hex,
  parseSgxQuote,
  parseTdxQuote,
  SgxQuote,
  TdxQuote,
  verifySgx,
  verifyTdx,
  getX25519ExpectedReportData as qvlGetX25519ExpectedReportData,
  isX25519Bound as qvlIsX25519Bound,
} from "ra-https-qvl"
import { base64 as scureBase64 } from "@scure/base"
import { concatUint8Arrays, areUint8ArraysEqual } from "uint8array-extras"
import { encode as encodeCbor, decode as decodeCbor } from "cbor-x"
import createDebug from "debug"

import {
  RAEncryptedHTTPRequest,
  RAEncryptedHTTPResponse,
  RAEncryptedServerEvent,
  RAEncryptedWSMessage,
  ControlChannelKXConfirm,
  ControlChannelEncryptedMessage,
  RAEncryptedMessage,
  VerifierData,
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
  customVerifyQuote?: (quote: TdxQuote | SgxQuote) => boolean | Promise<boolean>
  customVerifyX25519Binding?: (
    client: TunnelClient,
  ) => boolean | Promise<boolean>
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

  public quote: SgxQuote | TdxQuote | null = null
  public serverX25519PublicKey?: Uint8Array
  public symmetricKey?: Uint8Array // 32 byte key for XSalsa20-Poly1305

  // Additional bytes used to bind X25519PublicKey to report_data
  public reportBindingData?: {
    runtimeData: Uint8Array | null
    verifierData: VerifierData | null
  }

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
          message = decodeCbor(bytes)
        } catch (error) {
          console.error("Error parsing WebSocket message:", error)
        }

        if (isControlChannelKXAnnounce(message)) {
          let valid, validQuote, mrtd, report_data

          // Decode and store quote provided by the control channel
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

          // Decode and store report binding data from server
          try {
            const runtimeData = message.runtime_data
              ? scureBase64.decode(message.runtime_data)
              : null
            const verifierData = message.verifier_data
              ? decodeCbor(scureBase64.decode(message.verifier_data))
              : null
            if (runtimeData || verifierData) {
              this.reportBindingData = { runtimeData, verifierData }
            }
          } catch {
            console.error("ra-https: Malformed report binding data")
          }

          // Decode and store X25519 key from server
          const serverPub = sodium.from_base64(
            message.x25519PublicKey,
            sodium.base64_variants.ORIGINAL,
          )
          const symmetricKey = sodium.crypto_secretbox_keygen()
          const sealed = sodium.crypto_box_seal(symmetricKey, serverPub)
          this.serverX25519PublicKey = serverPub
          this.symmetricKey = symmetricKey

          // Validate quote binding, using default and custom validators
          if (
            this.config.customVerifyQuote !== undefined &&
            (await this.config.customVerifyQuote(validQuote)) !== true
          ) {
            throw new Error(
              "Error opening channel: custom quote body validation failed",
            )
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

          // Validate report_data to X25519 key binding, using default and custom validators
          if (this.config.customVerifyX25519Binding === undefined) {
            const val = this.reportBindingData?.verifierData?.val
            const iat = this.reportBindingData?.verifierData?.iat
            if (val === undefined) {
              throw new Error("missing nonce, could not validate report_data")
            } else if (iat === undefined) {
              throw new Error("missing iat, could not validate report_data")
            }
            if (!(await this.isX25519Bound(validQuote))) {
              throw new Error(
                "Error opening channel: report_data did not equal sha512(nonce || iat || x25519key)",
              )
            }
          } else {
            if ((await this.config.customVerifyX25519Binding(this)) !== true) {
              throw new Error(
                "Error opening channel: custom report_data validation failed",
              )
            }
          }

          // If we get here, quote and report_data validation passed
          this.quote = validQuote

          // Open a channel by generating and sending a symmetric encryption key
          try {
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
        const data = encodeCbor(message)
        this.ws.send(data)
        return
      }

      // Require encryption for all other messages
      if (!this.symmetricKey) {
        throw new Error("Encryption not ready: missing symmetric key")
      }

      const envelope = this.#encryptPayload(message)
      this.ws.send(encodeCbor(envelope))
    } else {
      throw new Error("WebSocket not connected")
    }
  }

  #encryptPayload(payload: RAEncryptedMessage): ControlChannelEncryptedMessage {
    if (!this.symmetricKey) {
      throw new Error("Missing symmetric key")
    }
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
    const plaintext = encodeCbor(payload)
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
    return decodeCbor(plaintext)
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
      resource: RequestInfo | URL,
      options?: RequestInit,
    ): Promise<Response> => {
      await this.ensureConnection()

      // Handle string, URL(), or Request objects, as the target resource
      let url: string
      let method: string
      let requestBody: BodyInit | null | undefined
      const headers: Record<string, string> = {}
      if (typeof resource === "string") {
        url = resource
        method = options?.method || "GET"
        requestBody = options?.body ?? null
        if (options?.headers) {
          if (options.headers instanceof Headers) {
            options.headers.forEach((value, key) => {
              headers[key] = value
            })
          } else if (Array.isArray(options.headers)) {
            options.headers.forEach(([key, value]) => {
              headers[key] = value
            })
          } else {
            Object.assign(headers, options.headers)
          }
        }
      } else if (resource instanceof URL) {
        url = resource.toString()
        method = options?.method || "GET"
        requestBody = options?.body ?? null
        if (options?.headers) {
          if (options.headers instanceof Headers) {
            options.headers.forEach((value, key) => {
              headers[key] = value
            })
          } else if (Array.isArray(options.headers)) {
            options.headers.forEach(([key, value]) => {
              headers[key] = value
            })
          } else {
            Object.assign(headers, options.headers)
          }
        }
      } else {
        // input is a Request object
        url = resource.url
        method = resource.method || "GET"
        resource.headers.forEach((value, key) => {
          headers[key] = value
        })
        // If init provided, it can override Request fields
        if (options?.headers) {
          if (options.headers instanceof Headers) {
            options.headers.forEach((value, key) => {
              headers[key] = value
            })
          } else if (Array.isArray(options.headers)) {
            options.headers.forEach(([key, value]) => {
              headers[key] = value
            })
          } else {
            Object.assign(headers, options.headers)
          }
        }
        if (options?.method) method = options.method
        requestBody = options?.body ?? (resource as any).body ?? null
      }

      // Handle string, ArrayBuffer, ArrayBuffer-like, and ReadableStream request bodies
      let body: string | undefined
      if (typeof requestBody === "string") {
        body = requestBody
      } else if (requestBody instanceof Uint8Array) {
        body = new TextDecoder().decode(requestBody)
      } else if (requestBody instanceof ArrayBuffer) {
        body = new TextDecoder().decode(new Uint8Array(requestBody))
      } else if (
        requestBody !== null &&
        requestBody !== undefined &&
        "arrayBuffer" in requestBody &&
        typeof requestBody.arrayBuffer === "function"
      ) {
        // Blob, FormData (stringify), or ReadableStream with arrayBuffer
        const ab = await requestBody.arrayBuffer()
        body = new TextDecoder().decode(new Uint8Array(ab))
      } else if (
        typeof globalThis.ReadableStream !== "undefined" &&
        requestBody instanceof globalThis.ReadableStream
      ) {
        // ReadableStream
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
      } else if (requestBody !== undefined && requestBody !== null) {
        throw new Error(
          "request body must be a string, ArrayBuffer, or ReadableStream",
        )
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

  /**
   * Get the `report_data` expected based on the current X25519 key,
   * and the verifier nonce/iat obtained during the last remote attestation request.
   */
  async getX25519ExpectedReportData(): Promise<Uint8Array> {
    const nonce = this.reportBindingData?.verifierData?.val
    const issuedAt = this.reportBindingData?.verifierData?.iat
    if (!nonce) throw new Error("missing verifier_nonce.val")
    if (!issuedAt) throw new Error("missing verifier_nonce.iat")
    if (!this.serverX25519PublicKey) throw new Error("missing x25519 key")
    return await qvlGetX25519ExpectedReportData(
      nonce,
      issuedAt,
      this.serverX25519PublicKey,
    )
  }

  /**
   * Check whether a TDX quote attests to this tunnel's connected server's X25519 key.
   * This should be used in conjunction with MRTD verification and TCB/CRL checks
   * to verify that we have a secure connection.
   */
  async isX25519Bound(quote: TdxQuote | SgxQuote): Promise<boolean> {
    const nonce = this.reportBindingData?.verifierData?.val
    const issuedAt = this.reportBindingData?.verifierData?.iat
    if (!nonce) throw new Error("missing verifier_nonce.val")
    if (!issuedAt) throw new Error("missing verifier_nonce.iat")
    if (!this.serverX25519PublicKey) throw new Error("missing x25519 key")
    return await qvlIsX25519Bound(
      quote,
      nonce,
      issuedAt,
      this.serverX25519PublicKey,
    )
  }
}
