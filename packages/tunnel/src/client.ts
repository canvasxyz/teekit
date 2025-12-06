import {
  parseSgxQuote,
  parseTdxQuote,
  SgxQuote,
  TdxQuote,
  verifySgx,
  verifyTdx,
  getExpectedReportDataFromUserdata,
  isUserdataBound,
  verifyTdxMeasurements,
  type MeasurementConfig,
  // SEV-SNP imports
  parseSevSnpReport,
  verifySevSnp,
  type SevSnpReport,
  type SevSnpMeasurementConfig,
  type SevSnpVerifyConfig,
} from "@teekit/qvl"
import { encode as encodeCbor, decode as decodeCbor } from "cbor-x"
import createDebug from "debug"

import sodium from "./crypto.js"
import {
  RAEncryptedHTTPRequest,
  RAEncryptedHTTPResponse,
  RAEncryptedServerEvent,
  RAEncryptedWSMessage,
  ControlChannelKXClientReady,
  ControlChannelKXConfirm,
  ControlChannelEncryptedMessage,
  RAEncryptedMessage,
  VerifierNonce,
} from "./types.js"
import {
  isControlChannelEncryptedMessage,
  isControlChannelKXAnnounce,
  isControlChannelKXConfirm,
  isRAEncryptedHTTPResponse,
  isRAEncryptedServerEvent,
  isRAEncryptedWSMessage,
} from "./typeguards.js"
import { generateRequestId, Awaitable } from "./utils/client.js"
import { ClientRAMockWebSocket } from "./ClientRAWebSocket.js"
import { WebSocket as IsomorphicWebSocket } from "isomorphic-ws"

// Reuse encoder/decoder instances to reduce allocations
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** Base config options shared across all attestation types */
type TunnelClientConfigBase = {
  /**
   * Override default X25519 binding verifier.
   * - TDX: report_data = SHA512(nonce || iat || x25519key)
   * - SEV-SNP: report_data = SHA512(nonce || x25519key)
   */
  x25519Binding?: (client: TunnelClient) => Awaitable<boolean>
}

/** TDX attestation config (default) */
type TdxClientConfig = TunnelClientConfigBase & {
  sevsnp?: false
  sgx?: false
  measurements?: MeasurementConfig
  customVerifyQuote?: (quote: TdxQuote | SgxQuote) => Awaitable<boolean>
}

/** SGX attestation config (requires customVerifyQuote) */
type SgxClientConfig = TunnelClientConfigBase & {
  sgx: true
  sevsnp?: false
  measurements?: MeasurementConfig
  customVerifyQuote: (quote: TdxQuote | SgxQuote) => Awaitable<boolean>
}

/** SEV-SNP attestation config */
type SevSnpClientConfig = TunnelClientConfigBase & {
  sevsnp: true
  sgx?: false
  measurements?: SevSnpMeasurementConfig
  customVerifyQuote?: (report: SevSnpReport) => Awaitable<boolean>
  /** Additional SEV-SNP verification options: policy flags, etc. */
  sevsnpVerifyConfig?: Omit<
    SevSnpVerifyConfig,
    "vcekCert" | "askCert" | "arkCert" | "verifyMeasurements"
  >
}

export type TunnelClientConfig =
  | TdxClientConfig
  | SgxClientConfig
  | SevSnpClientConfig

const debug = createDebug("teekit:TunnelClient")

/**
 * Client for opening an encrypted remote-attested channel.
 *
 * const enc = await TunnelClient.initialize(baseUrl, {
 *   measurements: {
 *     mrtd: 'c68518...',
 *     reportData: '0000....',
 *   },
 *   customVerifyQuote: (quote) => {
 *     return true // additional custom validation logic goes here
 *   },
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
  public sevsnpReport: SevSnpReport | null = null
  public serverX25519PublicKey?: Uint8Array
  public symmetricKey?: Uint8Array // 32 byte key for XSalsa20-Poly1305

  // Additional bytes used to bind X25519PublicKey to report_data
  public reportBindingData?: {
    runtimeData: Uint8Array | null
    verifierData: VerifierNonce | Uint8Array | null // VerifierNonce for Intel, Uint8Array nonce for SEV-SNP
    // SEV-SNP certificates
    vcekCert: string | null
    askCert: string | null
    arkCert: string | null
  }

  private pendingRequests = new Map<
    string,
    { resolve: (response: Response) => void; reject: (error: Error) => void }
  >()
  private webSocketConnections = new Map<string, ClientRAMockWebSocket>()
  private reconnectDelay = 1000
  private connectionPromise: Promise<void> | null = null
  private config: TunnelClientConfig
  private closed = false

  WebSocket: new (
    url: string,
    protocols?: string | string[],
  ) => IsomorphicWebSocket

  private constructor(
    public readonly origin: string,
    config: TunnelClientConfig,
  ) {
    if (origin.endsWith("/")) {
      console.warn(
        `[teekit] TunnelClient initialized with trailing slash: "${origin}". ` +
          `Consider "${origin.slice(0, -1)}" instead.`,
      )
    }
    this.id = Math.random().toString().slice(2)
    this.config = config

    const self = this
    this.WebSocket = class extends ClientRAMockWebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(self, url, protocols)
      }
    } as any
  }

  static async initialize(
    origin: string,
    config: TunnelClientConfig,
  ): Promise<TunnelClient> {
    return new TunnelClient(origin, config)
  }

  /**
   * Helper for establishing connections. Waits for a connection on `this.ws`,
   * creating a new WebSocket to replace this.ws if necessary.
   */
  public async ensureConnection(): Promise<void> {
    if (this.closed) {
      return
    }

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

      // Send a hello message since non-Node environments may not call onOpen
      this.ws.onopen = () => {
        const hello: ControlChannelKXClientReady = { type: "client_kx_ready" }
        this.ws!.send(encodeCbor(hello))
      }

      this.ws.onclose = (event: { code?: number; reason?: string }) => {
        this.connectionPromise = null

        // Preserve the close code and reason from the server
        const closeCode = event?.code ?? 1006
        const closeReason = event?.reason ?? "tunnel closed"

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
              code: closeCode,
              reason: closeReason,
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

        const timer = setTimeout(() => {
          if (this.closed) return
          this.ensureConnection()
        }, this.reconnectDelay)

        if (typeof timer.unref === "function") {
          timer.unref()
        }
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
            if (this.closed) return

            const timer = setTimeout(() => {
              this.ensureConnection()
            }, this.reconnectDelay)

            if (typeof timer.unref === "function") {
              timer.unref()
            }
          }
        } catch {}

        reject(new Error("WebSocket connection failed"))
      }

      this.ws.onmessage = async (event) => {
        // Normalize incoming bytes in WebSocket messages
        let message
        try {
          let bytes: Uint8Array
          const data = event.data
          if (typeof data === "string") {
            bytes = textEncoder.encode(data)
          } else if (data instanceof Uint8Array) {
            bytes = data
          } else if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data)
          } else if (ArrayBuffer.isView(data)) {
            const view = data as ArrayBufferView
            bytes = new Uint8Array(
              view.buffer as ArrayBuffer,
              view.byteOffset,
              view.byteLength,
            )
          } else if (typeof data?.arrayBuffer === "function") {
            const buf = await data.arrayBuffer()
            bytes = new Uint8Array(buf)
          } else {
            bytes = new Uint8Array(data)
          }
          message = decodeCbor(bytes)
        } catch (error) {
          console.error("Error parsing WebSocket message:", error)
          return
        }

        if (isControlChannelKXAnnounce(message)) {
          try {
            let validQuote: SgxQuote | TdxQuote | null = null
            let validSevSnpReport: SevSnpReport | null = null

            // Decode and store quote provided by the control channel
            if (!message.quote || message.quote.length === 0) {
              throw new Error("Error opening channel: empty quote")
            }
            const quote = message.quote as Uint8Array

            // Decode and store report binding data from server
            try {
              const runtimeData = message.runtime_data
                ? (message.runtime_data as Uint8Array)
                : null
              // verifier_data can be either VerifierNonce (Intel) or Uint8Array (SEV-SNP nonce)
              const verifierData = message.verifier_data
                ? (message.verifier_data as VerifierNonce | Uint8Array)
                : null
              // Extract SEV-SNP certificates from nested sev_snp_data field
              const sevSnpData = message.sev_snp_data as
                | {
                    vcek_cert: string
                    ask_cert?: string | null
                    ark_cert?: string | null
                  }
                | null
                | undefined
              const vcekCert = sevSnpData?.vcek_cert ?? null
              const askCert = sevSnpData?.ask_cert ?? null
              const arkCert = sevSnpData?.ark_cert ?? null
              this.reportBindingData = {
                runtimeData,
                verifierData,
                vcekCert,
                askCert,
                arkCert,
              }
            } catch {
              console.error("teekit: Malformed report binding data")
            }

            // Verify quote based on attestation type
            if (this.config.sevsnp) {
              // SEV-SNP attestation
              const vcekCert = this.reportBindingData?.vcekCert
              if (!vcekCert) {
                throw new Error(
                  "Error opening channel: SEV-SNP mode requires vcek_cert",
                )
              }

              // Build verification config
              const sevConfig: SevSnpVerifyConfig = {
                vcekCert,
                askCert: this.reportBindingData?.askCert ?? undefined,
                arkCert: this.reportBindingData?.arkCert ?? undefined,
                ...this.config.sevsnpVerifyConfig,
              }

              // Add measurement verification if configured
              if (this.config.measurements) {
                sevConfig.verifyMeasurements = this.config
                  .measurements as SevSnpMeasurementConfig
              }

              // Verify signature and chain
              await verifySevSnp(quote, sevConfig)
              validSevSnpReport = parseSevSnpReport(quote)

              // Custom verification callback
              if (
                this.config.customVerifyQuote !== undefined &&
                (await this.config.customVerifyQuote(validSevSnpReport)) !==
                  true
              ) {
                throw new Error(
                  "Error opening channel: custom quote validation failed",
                )
              }
            } else if (this.config.sgx) {
              await verifySgx(quote)
              validQuote = parseSgxQuote(quote)
            } else {
              // TDX (default)
              await verifyTdx(quote)
              validQuote = parseTdxQuote(quote)
            }

            // Decode and store X25519 key from server
            const serverPub = message.x25519PublicKey as Uint8Array
            const symmetricKey = new Uint8Array(32)
            crypto.getRandomValues(symmetricKey)
            const sealed = sodium.crypto_box_seal(symmetricKey, serverPub)
            this.serverX25519PublicKey = serverPub
            this.symmetricKey = symmetricKey

            // Must have at least measurements or customVerifyQuote (for non-SEV-SNP)
            if (!this.config.sevsnp) {
              if (!this.config.measurements && !this.config.customVerifyQuote) {
                throw new Error(
                  "Error opening channel: no validation strategy provided",
                )
              }

              // Validate quote binding, using default and custom validators
              if (
                this.config.customVerifyQuote !== undefined &&
                (await this.config.customVerifyQuote(validQuote!)) !== true
              ) {
                throw new Error(
                  "Error opening channel: custom quote body validation failed",
                )
              }

              // Verify measurements config (TDX only)
              if (!this.config.sgx && this.config.measurements !== undefined) {
                if (
                  !(await verifyTdxMeasurements(
                    validQuote as TdxQuote,
                    this.config.measurements as MeasurementConfig,
                  ))
                ) {
                  throw new Error(
                    "Error opening channel: measurement verification failed",
                  )
                }
              }
              if (this.config.sgx && !this.config.customVerifyQuote) {
                throw new Error(
                  "Error opening channel: SGX channel must use customVerifyQuote",
                )
              }
            }

            // Validate report_data to X25519 key binding
            if (this.config.x25519Binding === undefined) {
              if (this.config.sevsnp) {
                // SEV-SNP: verify SHA512(nonce || x25519key) matches report_data
                if (!(await this.isSevSnpX25519Bound(validSevSnpReport!))) {
                  throw new Error(
                    "Error opening channel: SEV-SNP binding failed - report_data did not match sha512(nonce || x25519key)",
                  )
                }
              } else {
                // Standard TDX: report_data = SHA512(nonce || iat || x25519key)
                const verifierData = this.reportBindingData?.verifierData
                if (!verifierData) {
                  throw new Error(
                    "missing verifier_data, could not validate report_data",
                  )
                }
                // For Intel TDX, verifierData should be VerifierNonce with val and iat
                if (verifierData instanceof Uint8Array) {
                  throw new Error(
                    "expected VerifierNonce for Intel TDX, got plain nonce",
                  )
                }
                const val = verifierData.val
                const iat = verifierData.iat
                if (val === undefined) {
                  throw new Error(
                    "missing nonce, could not validate report_data",
                  )
                } else if (iat === undefined) {
                  throw new Error("missing iat, could not validate report_data")
                }
                if (!(await this.isX25519Bound(validQuote!))) {
                  throw new Error(
                    "Error opening channel: report_data did not equal sha512(nonce || iat || x25519key)",
                  )
                }
              }
            } else {
              if ((await this.config.x25519Binding(this)) !== true) {
                throw new Error(
                  "Error opening channel: custom report_data validation failed",
                )
              }
            }

            // If we get here, quote and report_data validation passed
            this.quote = validQuote
            this.sevsnpReport = validSevSnpReport

            // Open a channel by generating and sending a symmetric encryption key
            try {
              const reply: ControlChannelKXConfirm = {
                type: "client_kx",
                sealedSymmetricKey: sealed,
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
    const nonce = new Uint8Array(24)
    crypto.getRandomValues(nonce)
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

    // Reconstruct Headers, preserving multi-value arrays
    const headers = new Headers()
    for (const [k, v] of Object.entries(response.headers)) {
      if (Array.isArray(v)) {
        for (const vv of v) headers.append(k, vv)
      } else {
        headers.set(k, v)
      }
    }

    const syntheticResponse = new Response(
      response.status === 204
        ? null
        : response.body instanceof Uint8Array
          ? (response.body as BodyInit)
          : response.body,
      {
        status: response.status,
        statusText: response.statusText,
        headers,
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
        requestBody = options?.body ?? resource.body ?? null
      }

      // Handle string, ArrayBuffer, ArrayBuffer-like, and ReadableStream request bodies
      let body: string | undefined
      if (typeof requestBody === "string") {
        body = requestBody
      } else if (requestBody instanceof Uint8Array) {
        body = textDecoder.decode(requestBody)
      } else if (requestBody instanceof ArrayBuffer) {
        body = textDecoder.decode(new Uint8Array(requestBody))
      } else if (
        requestBody !== null &&
        requestBody !== undefined &&
        "arrayBuffer" in requestBody &&
        typeof requestBody.arrayBuffer === "function"
      ) {
        // Blob, FormData (stringify), or ReadableStream with arrayBuffer
        const ab = await requestBody.arrayBuffer()
        body = textDecoder.decode(new Uint8Array(ab))
      } else if (
        typeof globalThis.ReadableStream !== "undefined" &&
        requestBody instanceof globalThis.ReadableStream
      ) {
        // ReadableStream
        const reader = requestBody.getReader()
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
        body = textDecoder.decode(merged)
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
    const verifierData = this.reportBindingData?.verifierData
    const x25519key = this.serverX25519PublicKey

    // Standard TDX binding is SHA512(nonce || iat || x25519key)
    if (!verifierData) throw new Error("missing verifier_data")
    if (verifierData instanceof Uint8Array) {
      throw new Error("expected VerifierNonce for Intel TDX, got plain nonce")
    }

    const nonce = verifierData.val
    const issuedAt = verifierData.iat

    if (!nonce) throw new Error("missing verifier_nonce.val")
    if (!issuedAt || issuedAt.length === 0)
      throw new Error("missing verifier_nonce.iat")
    if (!x25519key) throw new Error("missing x25519 key")

    return await getExpectedReportDataFromUserdata(nonce, issuedAt, x25519key)
  }

  /**
   * Check whether a TDX quote attests to this tunnel's connected server's X25519 key.
   * This should be used in conjunction with MRTD verification and TCB/CRL checks
   * to verify that we have a secure connection.
   */
  async isX25519Bound(quote: TdxQuote | SgxQuote): Promise<boolean> {
    const verifierData = this.reportBindingData?.verifierData
    const x25519key = this.serverX25519PublicKey

    if (!verifierData) throw new Error("missing verifier_data")
    if (verifierData instanceof Uint8Array) {
      throw new Error("expected VerifierNonce for Intel TDX, got plain nonce")
    }

    const nonce = verifierData.val
    const issuedAt = verifierData.iat

    if (!nonce) throw new Error("missing verifier_nonce.val")
    if (!issuedAt) throw new Error("missing verifier_nonce.iat")
    if (!x25519key) throw new Error("missing x25519 key")

    return await isUserdataBound(quote, nonce, issuedAt, x25519key)
  }

  /**
   * Check whether a SEV-SNP report attests to this tunnel's server's X25519 key.
   * This verifies `report_data = SHA512(nonce || x25519_public_key)`, but does not cover:
   *
   * - Certificate chain (ARK → ASK → VCEK) - verified by verifySevSnp()
   * - Report signature - verified by verifySevSnp()
   * - Measurements - verified by `measurements` config
   * - Policy flags - verified by `sevsnpVerifyConfig` additional configs
   */
  async isSevSnpX25519Bound(report: SevSnpReport): Promise<boolean> {
    const verifierData = this.reportBindingData?.verifierData
    const x25519key = this.serverX25519PublicKey

    if (!verifierData) throw new Error("missing nonce for SEV-SNP binding")
    if (!x25519key) throw new Error("missing x25519 key")

    // For SEV-SNP, verifierData should be a plain Uint8Array nonce
    const nonce =
      verifierData instanceof Uint8Array ? verifierData : verifierData.val
    if (!nonce) throw new Error("missing nonce for SEV-SNP binding")

    // Compute expected report_data: SHA512(nonce || x25519key)
    // TODO: This could be factored into a helper like `isUserdataBound`
    const combined = new Uint8Array(nonce.length + x25519key.length)
    combined.set(nonce, 0)
    combined.set(x25519key, nonce.length)

    const expectedHash = await crypto.subtle.digest("SHA-512", combined)
    const expectedBytes = new Uint8Array(expectedHash)

    // Compare with report's report_data
    const reportData = report.body.report_data
    if (expectedBytes.length !== reportData.length) {
      return false
    }
    for (let i = 0; i < expectedBytes.length; i++) {
      if (expectedBytes[i] !== reportData[i]) {
        return false
      }
    }

    return true
  }

  /**
   * Close the control channel and all tunneled WebSockets, and disable reconnection.
   */
  public close(code?: number, reason?: string): void {
    if (this.closed) return
    this.closed = true

    // Reject any pending HTTP requests
    try {
      for (const [, pending] of this.pendingRequests.entries()) {
        pending.reject(new Error("Tunnel closed"))
      }
      this.pendingRequests.clear()
    } catch {}

    // Notify and clear any tunneled WebSocket connections
    try {
      for (const [
        connectionId,
        connection,
      ] of this.webSocketConnections.entries()) {
        connection.handleTunnelEvent({
          type: "ws_event",
          connectionId,
          eventType: "close",
          code: code || 1000,
          reason: reason || "client closed",
        } as RAEncryptedServerEvent)
      }
      this.webSocketConnections.clear()
    } catch {}

    // Close control channel
    try {
      if (
        this.ws?.readyState === WebSocket.OPEN ||
        this.ws?.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(code || 1000, reason || "client closed")
      }
    } finally {
      this.ws = null
      this.connectionPromise = null
      this.symmetricKey = undefined
    }
  }
}
