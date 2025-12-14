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

const REMOTE = "https://136.112.93.209.nip.io"
export const baseUrl = document.location.search.includes("remote=1")
  ? REMOTE
  : document.location.hostname === "localhost"
    ? "http://localhost:3001"
    : document.location.hostname.endsWith(".vercel.app")
      ? REMOTE
      : `${document.location.protocol}//${document.location.hostname}`

const UPTIME_REFRESH_MS = 10000

const enc = await TunnelClient.initialize(baseUrl, {
  sevsnp: true,
  customVerifyQuote: async () => true,
})

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
  const [uptimeSpinKey, setUptimeSpinKey] = useState<number>(0)
  const [hiddenMessagesCount, setHiddenMessagesCount] = useState<number>(0)
  const [swCounter, setSwCounter] = useState<number>(0)
  const [attestedMeasurement, setAttestedMeasurement] = useState<string>("")
  const [expectedReportData, setExpectedReportData] = useState<string>("")
  const [attestedReportData, setAttestedReportData] = useState<string>("")
  const [verifierNonce, setVerifierNonce] = useState<string>("")
  const [connectionError, setConnectionError] = useState<string>("")
  const [isMobile, setIsMobile] = useState<boolean>(false)
  const initializedRef = useRef<boolean>(false)
  const wsRef = useRef<IWebSocket | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const initialMessagesLoadRef = useRef<boolean>(true)

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
    try {
      const response = await enc.fetch(baseUrl + "/uptime")
      const text = await response.text()
      try {
        const data: UptimeData = JSON.parse(text)
        setUptime(data.uptime.formatted)
      } catch (parseError) {
        console.error("Failed to parse uptime JSON:", text, parseError)
      }
    } catch (error) {
      console.error("Failed to fetch uptime:", error)
    } finally {
      setUptimeSpinKey((k) => k + 1)
    }
  }, [])

  const disconnectRA = useCallback(() => {
    try {
      if (enc.ws) {
        enc.ws.close(4000, "simulate disconnect")
      }
    } catch (e) {
      console.error("Failed to close RA WebSocket:", e)
    }
  }, [])

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

  useEffect(() => {
    fetchUptime()
    const interval = setInterval(fetchUptime, UPTIME_REFRESH_MS) // Update every 10 seconds

    if (!initializedRef.current) {
      initializedRef.current = true
      enc
        .fetch(baseUrl + "/increment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
        .then(async (response) => {
          const data = await response.json()
          setSwCounter(data?.counter || 0)
        })
    }

    return () => clearInterval(interval)
  }, [fetchUptime])

  useEffect(() => {
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.CONNECTING ||
        wsRef.current.readyState === WebSocket.OPEN)
    ) {
      return
    }

    const wsUrl = baseUrl
      .replace(/^http:\/\//, "ws://")
      .replace(/^https:\/\//, "wss://")
    const ws = new enc.WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      setConnectionError("") // Clear any previous connection errors
      console.log("Connected to chat server")

      // Set up control panel UI with attested measurements, expected measurements, etc.
      if (!enc.sevsnpReport)
        throw new Error("unexpected: ws shouldn't open without a SEV-SNP report")
      setAttestedMeasurement(hex(enc.sevsnpReport.body.measurement))
      setAttestedReportData(hex(enc.sevsnpReport.body.report_data))
      enc
        .getX25519ExpectedReportData()
        .then((expectedReportData: Uint8Array) => {
          setExpectedReportData(hex(expectedReportData ?? new Uint8Array()))

          const verifierData = enc.reportBindingData?.verifierData
          if (verifierData === null || verifierData === undefined) return

          // For SEV-SNP, verifierData is a plain Uint8Array nonce
          if (verifierData instanceof Uint8Array) {
            setVerifierNonce(hex(verifierData))
          } else if ("val" in verifierData) {
            setVerifierNonce(hex(verifierData.val ?? new Uint8Array()))
          }
        })

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
    }

    ws.onerror = (error: ErrorEvent) => {
      console.error("WebSocket error:", error)
      setConnected(false)
    }

    return () => {
      try {
        ws.close()
      } finally {
        if (wsRef.current === ws) wsRef.current = null
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
      minute: "2-digit",
    })
  }

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    setNewMessage(e.target.value)
  }

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h1>TEE Chat Room</h1>
        <div className="user-info">
          <span className="username">You are: {username}</span>
          <span>
            <span
              className={`status ${connected ? "connected" : "disconnected"}`}
            >
              {connected
                ? "🟢 WS Connected"
                : connectionError
                  ? "🔴 Connection Error"
                  : "🔴 WS Disconnected"}
            </span>{" "}
            <a
              href="#"
              onClick={async (e) => {
                e.preventDefault()
                if (connected) {
                  disconnectRA()
                } else {
                  await enc.ensureConnection()
                  setConnected(true)
                }
              }}
              style={{
                color: "#333",
                textDecoration: "underline",
                cursor: "pointer",
                fontSize: "0.85em",
              }}
            >
              {connected ? "Disconnect" : "Connect"}
            </a>
          </span>
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
                ~{uptime || "—"}
                <span
                  key={uptimeSpinKey}
                  className="uptime-spinner"
                  style={{ animationDuration: UPTIME_REFRESH_MS + "ms" }}
                ></span>
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
              GET /uptime via TunnelClient
            </button>

            <button
              onClick={async () => {
                try {
                  const response = await enc.fetch(baseUrl + "/increment", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                  })
                  const data = await response.json()
                  setSwCounter(data?.counter || 0)
                } catch (error) {
                  console.error("Failed to increment via tunnel:", error)
                }
              }}
              style={buttonStyle}
            >
              POST /increment via TunnelClient
            </button>

            <button
              onClick={async () => {
                try {
                  const r = await fetch("/uptime")
                  const j = await r.json()
                  setUptime(j?.uptime?.formatted || "")
                } catch {}
              }}
              style={buttonStyle}
            >
              GET /uptime via ServiceWorker
            </button>

            <button
              onClick={async () => {
                try {
                  const r = await fetch("/increment", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                  })
                  const j = await r.json()
                  setSwCounter(j?.counter || 0)
                } catch {}
              }}
              style={buttonStyle}
            >
              POST /increment via ServiceWorker
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
            <div style={{ marginBottom: 6 }}>Server: {baseUrl}</div>
            <div style={{ marginBottom: 6 }}>
              Attested Measurement (launch digest): {attestedMeasurement}
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
                Based on sha512(nonce, key):
              </div>
              <div style={{ marginBottom: 6 }}>
                Nonce:{" "}
                {verifierNonce || <span style={{ color: "red" }}>None</span>}
              </div>
              <div style={{ marginBottom: 6 }}>
                X25519 tunnel key:{" "}
                {enc?.serverX25519PublicKey
                  ? hex(enc.serverX25519PublicKey)
                  : "--"}
              </div>
            </div>
            <br />
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
