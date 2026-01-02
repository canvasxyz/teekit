import {
  useState,
  useEffect,
  useRef,
  FormEvent,
  ChangeEvent,
  useCallback,
} from "react"
import "./App.css"

import { TunnelClient } from "@teekit/tunnel"
import { hex } from "@teekit/qvl"
import type {
  WebSocket as IWebSocket,
  MessageEvent,
  ErrorEvent,
} from "isomorphic-ws"

import { Message, WebSocketMessage, ChatMessage, UptimeData } from "./types.js"
import { getStoredUsername } from "./utils.js"

const REMOTES = [
  { label: "Azure SGX", url: "https://52.191.114.221.sslip.io" },
  { label: "Azure SGX", url: "http://52.191.114.221:3001" },
  { label: "Local", url: "http://localhost:3001" },
  {
    label: "Custom",
    url: `${document.location.protocol}//${document.location.hostname}`,
  },
  { label: "Custom", url: "custom" },
]

const getDefaultRemote = () => {
  return REMOTES[0].url
}

// Validate URL format (must be http/https with valid hostname/IP)
const isValidEndpoint = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false
    }
    // Check if hostname is not empty
    if (!parsed.hostname) {
      return false
    }
    return true
  } catch {
    return false
  }
}

// Check if connecting to a URL would cause mixed content issues
// (i.e., trying to connect to ws:// from an https:// page)
const isInsecureFromHttps = (url: string): boolean => {
  if (window.location.protocol !== "https:") {
    return false // http:// origin can connect to anything
  }
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:"
  } catch {
    return false
  }
}

const buttonStyle = {
  padding: "8px 16px",
  fontSize: "0.85em",
  width: "100%",
  border: "1px solid #ddd",
  borderRadius: 4,
  cursor: "pointer",
  outline: "none",
}

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [newMessage, setNewMessage] = useState<string>("")
  const [username] = useState<string>(getStoredUsername)
  const [connected, setConnected] = useState<boolean>(false)
  const [uptime, setUptime] = useState<string>("")
  const [hiddenMessagesCount, setHiddenMessagesCount] = useState<number>(0)
  const [swCounter, setSwCounter] = useState<number>(0)
  const [attestedMeasurement, setAttestedMeasurement] = useState<string>("")
  const [expectedReportData, setExpectedReportData] = useState<string>("")
  const [attestedReportData, setAttestedReportData] = useState<string>("")
  const [connectionError, setConnectionError] = useState<string>("")
  const [isMobile, setIsMobile] = useState<boolean>(false)
  const [selectedRemote, setSelectedRemote] = useState<string>(getDefaultRemote)
  const [customUrl, setCustomUrl] = useState<string>("http://localhost:3001")
  const [debouncedCustomUrl, setDebouncedCustomUrl] = useState<string>("")
  const [customUrlError, setCustomUrlError] = useState<string>("")
  const [isInitializing, setIsInitializing] = useState<boolean>(true)
  const encRef = useRef<TunnelClient | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initializedRef = useRef<boolean>(false)
  const wsRef = useRef<IWebSocket | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const initialMessagesLoadRef = useRef<boolean>(true)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelayRef = useRef<number>(1000) // Start with 1 second
  const mountedRef = useRef<boolean>(true)

  const [kvKey, setKvKey] = useState<string>("")
  const [kvValue, setKvValue] = useState<string>("")
  const [kvStatus, setKvStatus] = useState<string>("")
  const [kvResult, setKvResult] = useState<string>("")
  const [kvBusy, setKvBusy] = useState<boolean>(false)
  const [kvCommand, setKvCommand] = useState<"init" | "get" | "put">("get")

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    if (isMobile && initialMessagesLoadRef.current) {
      initialMessagesLoadRef.current = false
      return
    }

    scrollToBottom()
    initialMessagesLoadRef.current = false
  }, [messages, isMobile])

  const fetchUptime = useCallback(async () => {
    if (!encRef.current) return
    const activeRemote = getActiveRemote()
    try {
      const response = await encRef.current.fetch(activeRemote + "/uptime")
      const text = await response.text()
      try {
        const data: UptimeData = JSON.parse(text)
        setUptime(data.uptime.formatted)
      } catch (parseError) {
        console.error("Failed to parse uptime JSON:", text, parseError)
      }
    } catch (error) {
      console.error("Failed to fetch uptime:", error)
    }
  }, [selectedRemote, debouncedCustomUrl])


  // Setup or reconnect the chat WebSocket
  const setupChatWebSocket = useCallback(() => {
    if (!encRef.current) return

    // Clear any pending reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    // Close any existing WebSocket that's not already closed
    if (wsRef.current) {
      try {
        if (
          wsRef.current.readyState === WebSocket.CONNECTING ||
          wsRef.current.readyState === WebSocket.OPEN
        ) {
          wsRef.current.close()
        }
      } catch {}
      wsRef.current = null
    }

    const activeRemote = getActiveRemote()
    const wsUrl = activeRemote
      .replace(/^http:\/\//, "ws://")
      .replace(/^https:\/\//, "wss://")
    const ws = new encRef.current.WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      setConnectionError("") // Clear any previous connection errors
      reconnectDelayRef.current = 1000 // Reset backoff on successful connection
      console.log("Connected to chat server")

      // Set up control panel UI with attested measurements, expected measurements, etc.
      if (!encRef.current?.quote)
        throw new Error("unexpected: ws shouldn't open without an SGX quote")

      // Check if it's an SGX quote (has mr_enclave property)
      if ("mr_enclave" in encRef.current.quote.body) {
        setAttestedMeasurement(hex(encRef.current.quote.body.mr_enclave))
        setAttestedReportData(hex(encRef.current.quote.body.report_data))
      } else {
        // TDX quotes don't have mr_enclave, they have mr_td
        console.warn("TDX quotes not fully supported in UI yet")
      }

      // For SGX: report_data[0:32] = SHA256(x25519key), no nonce involved
      if (encRef.current.serverX25519PublicKey) {
        const keyBytes = new Uint8Array(encRef.current.serverX25519PublicKey)
        crypto.subtle.digest("SHA-256", keyBytes).then((hashBuffer) => {
          const expectedHash = new Uint8Array(hashBuffer)
          // SGX report_data is 64 bytes: first 32 = SHA256(key), rest = zeros
          const paddedExpected = new Uint8Array(64)
          paddedExpected.set(expectedHash, 0)
          setExpectedReportData(hex(paddedExpected))
        })
      }

      setTimeout(() => {
        inputRef.current?.focus()
      }, 1)
    }

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        throw new Error("unexpected websocket message")
      }

      const data: WebSocketMessage = JSON.parse(event.data)

      if (data.type === "backlog") {
        setMessages(data.messages || [])
        setHiddenMessagesCount(data.hiddenCount || 0)
      } else if (data.type === "message" && data.message) {
        setMessages((prev) => [...prev, data.message!])
      }
    }

    ws.onclose = (event: { code?: number; reason?: string }) => {
      setConnected(false)
      console.log("Disconnected from chat server", event.code, event.reason)

      // Handle tunnel initialization failures (code 1011)
      if (event.code === 1011) {
        const reason = event.reason || "Initialization failed"
        setConnectionError(`Server error (${event.code}): ${reason}`)
      }

      // Schedule automatic reconnection with exponential backoff
      // Skip if this was a manual disconnect (code 4000) or component unmounted
      if (event.code !== 4000 && mountedRef.current) {
        const delay = reconnectDelayRef.current
        console.log(`Scheduling chat WebSocket reconnect in ${delay}ms`)
        reconnectTimeoutRef.current = setTimeout(async () => {
          if (!mountedRef.current || !encRef.current) return
          try {
            await encRef.current.ensureConnection()
            if (mountedRef.current) {
              setupChatWebSocket()
            }
          } catch (e) {
            console.error("Failed to reconnect:", e)
          }
        }, delay)
        // Exponential backoff: double the delay, cap at 30 seconds
        reconnectDelayRef.current = Math.min(delay * 2, 30000)
      }
    }

    ws.onerror = (error: ErrorEvent) => {
      console.error("WebSocket error:", error)
      setConnected(false)
    }

    return ws
  }, [selectedRemote, debouncedCustomUrl])

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 768px)")
    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches)
    }

    setIsMobile(mediaQuery.matches)

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange)
    } else {
      mediaQuery.addListener(handleChange)
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener("change", handleChange)
      } else {
        mediaQuery.removeListener(handleChange)
      }
    }
  }, [])

  // Initialize or reinitialize TunnelClient when selectedRemote or debouncedCustomUrl changes
  useEffect(() => {
    let cancelled = false

    const initializeTunnel = async () => {
      const activeRemote = getActiveRemote()

      // Don't initialize if custom is selected but no valid URL yet
      if (selectedRemote === "custom" && !debouncedCustomUrl) {
        setIsInitializing(false)
        return
      }

      // Don't initialize if custom URL has validation error
      if (selectedRemote === "custom" && customUrlError) {
        setIsInitializing(false)
        return
      }

      // Check for mixed content issues
      if (isInsecureFromHttps(activeRemote)) {
        setConnectionError(
          "Cannot connect to insecure endpoint (http://) from a secure page (https://). " +
            "This would require an insecure WebSocket (ws://) which browsers block as mixed content.",
        )
        setIsInitializing(false)
        return
      }

      setIsInitializing(true)
      setConnectionError("")

      // Clean up existing tunnel client if any
      if (encRef.current) {
        try {
          encRef.current.close()
        } catch (e) {
          console.error("Error closing previous tunnel:", e)
        }
        encRef.current = null
      }

      // Clear existing state
      setMessages([])
      setHiddenMessagesCount(0)
      setUptime("")
      setSwCounter(0)
      setAttestedMeasurement("")
      setExpectedReportData("")
      setAttestedReportData("")
      setConnected(false)

      try {
        const tunnel = await TunnelClient.initialize(activeRemote, {
          sgx: true,
          customVerifyQuote: async () => true,
        })

        if (cancelled) {
          tunnel.close()
          return
        }

        encRef.current = tunnel
        setIsInitializing(false)

        // Fetch initial data
        if (!initializedRef.current) {
          initializedRef.current = true
        }

        fetchUptime()

        tunnel
          .fetch(activeRemote + "/increment", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
          .then(async (response) => {
            const data = await response.json()
            setSwCounter(data?.counter || 0)
          })
          .catch((error) => {
            console.error("Failed to fetch counter:", error)
          })

        // Setup chat WebSocket
        setupChatWebSocket()
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to initialize tunnel:", error)
          setConnectionError(
            `Failed to connect: ${error instanceof Error ? error.message : "Unknown error"}`,
          )
          setIsInitializing(false)
        }
      }
    }

    initializeTunnel()

    return () => {
      cancelled = true
    }
  }, [
    selectedRemote,
    debouncedCustomUrl,
    setupChatWebSocket,
    fetchUptime,
    customUrlError,
  ])

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      // Clear any pending reconnect timeout
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      // Clear debounce timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      // Close chat WebSocket
      if (wsRef.current) {
        try {
          wsRef.current.close()
        } catch {}
        wsRef.current = null
      }
      // Close tunnel
      if (encRef.current) {
        try {
          encRef.current.close()
        } catch {}
        encRef.current = null
      }
    }
  }, [])

  const sendMessage = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()

    if (
      newMessage.trim() &&
      wsRef.current &&
      wsRef.current.readyState === WebSocket.OPEN
    ) {
      const message: ChatMessage = {
        type: "chat",
        username: username,
        text: newMessage.trim(),
      }
      wsRef.current.send(JSON.stringify(message))
      setNewMessage("")
    }
  }

  const formatTime = (timestamp: string): string => {
    return new Date(timestamp).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
    })
  }

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    setNewMessage(e.target.value)
  }

  const handleKvInit = async () => {
    setKvBusy(true)
    setKvStatus("Initializing database...")
    setKvResult("")
    try {
      const activeRemote = getActiveRemote()
      const response = await encRef.current!.fetch(activeRemote + "/db/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `HTTP ${response.status}`)
      }
      const data = await response.json()
      setKvStatus("Init OK")
      setKvResult(JSON.stringify(data))
    } catch (error) {
      setKvStatus(`Init failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setKvBusy(false)
    }
  }

  const handleKvPut = async () => {
    if (!kvKey.trim() || !kvValue.trim()) {
      setKvStatus("Key and value are required.")
      setKvResult("")
      return
    }
    setKvBusy(true)
    setKvStatus("Writing value...")
    setKvResult("")
    try {
      const activeRemote = getActiveRemote()
      const response = await encRef.current!.fetch(activeRemote + "/db/put", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: kvKey.trim(), value: kvValue }),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `HTTP ${response.status}`)
      }
      const data = await response.json()
      setKvStatus("Put OK")
      setKvResult(JSON.stringify(data))
    } catch (error) {
      setKvStatus(`Put failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setKvBusy(false)
    }
  }

  const handleKvGet = async () => {
    if (!kvKey.trim()) {
      setKvStatus("Key is required.")
      setKvResult("")
      return
    }
    setKvBusy(true)
    setKvStatus("Fetching value...")
    setKvResult("")
    try {
      const activeRemote = getActiveRemote()
      const response = await encRef.current!.fetch(
        activeRemote + `/db/get?key=${encodeURIComponent(kvKey.trim())}`,
      )
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `HTTP ${response.status}`)
      }
      const data = await response.json()
      setKvStatus("Get OK")
      setKvResult(JSON.stringify(data))
    } catch (error) {
      setKvStatus(`Get failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setKvBusy(false)
    }
  }

  const handleKvSend = async () => {
    if (kvCommand === "init") {
      await handleKvInit()
      return
    }
    if (kvCommand === "get") {
      await handleKvGet()
      return
    }
    await handleKvPut()
  }

  const selectKvCommand = (command: "init" | "get" | "put") => {
    setKvCommand(command)
    setKvStatus("")
    setKvResult("")
  }

  const handleCustomUrlChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setCustomUrl(value)
    setCustomUrlError("")

    // Clear existing debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    // Set new debounce timer
    debounceTimerRef.current = setTimeout(() => {
      if (!value.trim()) {
        setCustomUrlError("URL cannot be empty")
        return
      }

      if (!isValidEndpoint(value)) {
        setCustomUrlError("Invalid URL format (must be http:// or https://)")
        return
      }

      if (isInsecureFromHttps(value)) {
        setCustomUrlError(
          "Cannot connect to http:// from https:// (mixed content)",
        )
        return
      }

      // Valid URL - update debounced value to trigger connection
      setDebouncedCustomUrl(value)
    }, 1000)
  }

  // Get the actual URL to connect to
  const getActiveRemote = (): string => {
    if (selectedRemote === "custom") {
      return debouncedCustomUrl || customUrl
    }
    return selectedRemote
  }

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h1>TEE Chat Room</h1>
        <div className="user-info">
          {/* <span className="username">You are: {username}</span> */}
          <div style={{ display: "inline-block", marginTop: 2 }}>
            <select
              id="remote-select"
              value={selectedRemote}
              onChange={(e) => setSelectedRemote(e.target.value)}
              disabled={isInitializing}
              style={{
                display: "inline-block",
                padding: "4px 8px",
                fontSize: "0.85em",
                border: "1px solid #ddd",
                borderRadius: 4,
                backgroundColor: isInitializing ? "#f5f5f5" : "white",
                color: "#333",
                cursor: isInitializing ? "not-allowed" : "pointer",
                maxWidth: "280px",
              }}
            >
              {REMOTES.map((remote) => {
                const insecure =
                  remote.url !== "custom" && isInsecureFromHttps(remote.url)
                return (
                  <option
                    key={remote.url}
                    value={remote.url}
                    disabled={insecure}
                  >
                    {remote.label}{" "}
                    {remote.url === "custom"
                      ? ""
                      : `- ${remote.url}${insecure ? " (insecure)" : ""}`}
                  </option>
                )
              })}
            </select>
            {selectedRemote === "custom" && (
              <>
                <input
                  id="custom-url"
                  type="text"
                  value={customUrl}
                  onChange={handleCustomUrlChange}
                  placeholder="http://example.com:3001"
                  disabled={isInitializing}
                  style={{
                    display: "inline-block",
                    marginLeft: "6px",
                    padding: "4px 8px",
                    fontSize: "0.85em",
                    border: customUrlError
                      ? "1px solid #f87171"
                      : "1px solid #ddd",
                    borderRadius: 4,
                    backgroundColor: isInitializing ? "#f5f5f5" : "white",
                    color: "#333",
                    width: "180px",
                  }}
                />
                {customUrlError && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: "0.85em",
                      color: "#dc2626",
                    }}
                  >
                    {customUrlError}
                  </span>
                )}
              </>
            )}
            <span
              className={`status ${connected ? "connected" : "disconnected"}`}
            >
              &nbsp; {connected ? "🟢" : connectionError ? "Error" : "🔴"}
            </span>
          </div>
        </div>
      </div>

      <div className="chat-columns">
        <div className="chat-body">
          <div className="messages-container">
            {hiddenMessagesCount > 0 && (
              <div className="hidden-messages-display">
                {hiddenMessagesCount} earlier message
                {hiddenMessagesCount !== 1 ? "s" : ""}
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={`message ${
                  message.username === username
                    ? "own-message"
                    : "other-message"
                }`}
              >
                <div className="message-header">
                  <span className="message-username">{message.username}</span>
                  <span className="message-time">
                    {formatTime(message.timestamp)}
                  </span>
                </div>
                <div className="message-text">{message.text}</div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <form onSubmit={sendMessage} className="message-form">
            <input
              ref={inputRef}
              type="text"
              value={newMessage}
              onChange={handleInputChange}
              placeholder="Type your message..."
              disabled={!connected}
              className="message-input"
            />
            <button
              type="submit"
              disabled={!connected || !newMessage.trim()}
              className="send-button"
            >
              Send
            </button>
          </form>
        </div>

        <div className="chat-control">
          {connectionError && (
            <div
              style={{
                marginBottom: 10,
                padding: 10,
                backgroundColor: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: 6,
                color: "#991b1b",
                fontSize: "0.85em",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                ⚠️ Connection Error
              </div>
              <div>{connectionError}</div>
            </div>
          )}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
              marginBottom: 10,
              padding: 10,
              backgroundColor: "#f1f2f3",
              borderRadius: 6,
            }}
          >
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "0.8em", color: "#333" }}>
                Server Uptime
              </div>
              <div
                style={{ fontSize: "1.1em", fontWeight: 600, color: "#000" }}
              >
                {uptime || "—"}
              </div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "0.8em", color: "#333" }}>Counter</div>
              <div
                style={{ fontSize: "1.1em", fontWeight: 600, color: "#000" }}
              >
                {swCounter}
              </div>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 4,
              marginBottom: 10,
              padding: 10,
              backgroundColor: "#f1f2f3",
              borderRadius: 6,
            }}
          >
            <button
              onClick={(e) => {
                e.preventDefault()
                fetchUptime()
              }}
              style={buttonStyle}
            >
              GET /uptime
            </button>

            <button
              onClick={async () => {
                if (!encRef.current) return
                const activeRemote = getActiveRemote()
                try {
                  const response = await encRef.current.fetch(
                    activeRemote + "/increment",
                    {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: "{}",
                    },
                  )
                  const data = await response.json()
                  setSwCounter(data?.counter || 0)
                } catch (error) {
                  console.error("Failed to increment via tunnel:", error)
                }
              }}
              style={buttonStyle}
            >
              POST /increment
            </button>
          </div>

          <div
            style={{
              marginTop: 10,
              fontFamily: "monospace",
              padding: "0 6px",
              fontSize: "0.8em",
              color: "#333",
              maxWidth: 360,
              overflowWrap: "anywhere",
              textAlign: "left",
            }}
          >
            <div style={{ marginBottom: 6 }}>Server: {getActiveRemote()}</div>
            <div style={{ marginBottom: 6 }}>
              Attested MRENCLAVE: {attestedMeasurement}
            </div>
            <div style={{ marginBottom: 6 }}>
              Attested report_data: {attestedReportData}
            </div>

            <hr
              style={{
                margin: "12px 0",
                border: "none",
                borderBottom: "1px solid #ccc",
              }}
            />
            <div style={{ marginBottom: 10 }}>
              Expected report_data:{" "}
              <span
                style={{
                  color:
                    expectedReportData === attestedReportData ? "green" : "red",
                }}
              >
                {expectedReportData || "Could not validate tunnel binding"}
              </span>
            </div>
            <div style={{ borderLeft: "1px solid #ccc", paddingLeft: 12 }}>
              <div style={{ marginBottom: 6 }}>
                Based on sha256(key) padded to 64 bytes:
              </div>
              <div style={{ marginBottom: 6 }}>
                X25519 tunnel key:{" "}
                {encRef.current?.serverX25519PublicKey
                  ? hex(encRef.current.serverX25519PublicKey)
                  : "--"}
              </div>
            </div>
            <br />
          </div>

          <div className="kv-panel">
            <div className="kv-title">KV Store</div>
            <div className="kv-command-row">
              <button
                className={`kv-command-button ${kvCommand === "init" ? "active" : ""}`}
                onClick={() => selectKvCommand("init")}
                disabled={kvBusy}
              >
                Init
              </button>
              <button
                className={`kv-command-button ${kvCommand === "get" ? "active" : ""}`}
                onClick={() => selectKvCommand("get")}
                disabled={kvBusy}
              >
                Get
              </button>
              <button
                className={`kv-command-button ${kvCommand === "put" ? "active" : ""}`}
                onClick={() => selectKvCommand("put")}
                disabled={kvBusy}
              >
                Put
              </button>
            </div>
            {kvCommand !== "init" ? (
              <div className="kv-row">
                <input
                  className="kv-input"
                  type="text"
                  placeholder="Key"
                  value={kvKey}
                  onChange={(e) => setKvKey(e.target.value)}
                  disabled={kvBusy}
                />
              </div>
            ) : null}
            {kvCommand === "put" ? (
              <div className="kv-row">
                <input
                  className="kv-input"
                  type="text"
                  placeholder="Value"
                  value={kvValue}
                  onChange={(e) => setKvValue(e.target.value)}
                  disabled={kvBusy}
                />
              </div>
            ) : null}
            <div className="kv-actions">
              <button
                className="kv-send-button"
                onClick={handleKvSend}
                disabled={kvBusy}
              >
                Send
              </button>
            </div>
            {kvStatus ? <div className="kv-status">{kvStatus}</div> : null}
            {kvResult ? <pre className="kv-result">{kvResult}</pre> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
