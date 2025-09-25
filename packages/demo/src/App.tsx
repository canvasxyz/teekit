import {
  useState,
  useEffect,
  useRef,
  FormEvent,
  ChangeEvent,
  useCallback,
} from "react"
import "./App.css"

import { TunnelClient } from "ra-https-tunnel"
import { verifyTdxBase64, verifySgxBase64 } from "ra-https-qvl"

import { Message, WebSocketMessage, ChatMessage, UptimeData } from "./types.js"
import { getStoredUsername } from "./utils.js"
import {
  tappdV4Base64,
  trusteeV5Base64,
  occlumSgxBase64,
} from "../shared/samples.js"

const baseUrl =
  document.location.hostname === "localhost"
    ? "http://localhost:3001"
    : "https://ra-https.up.railway.app"

const enc = await TunnelClient.initialize(baseUrl, {
  match: (quote) => {
    console.log(quote)
    return true
  },
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
  const [hiddenMessagesCount, setHiddenMessagesCount] = useState<number>(0)
  const [verifyResult, setVerifyResult] = useState<string>("")
  const [swCounter, setSwCounter] = useState<number>(0)
  const initializedRef = useRef<boolean>(false)
  const wsRef = useRef<WebSocket | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(scrollToBottom, [messages])

  const fetchUptime = useCallback(async () => {
    try {
      const response = await enc.fetch(baseUrl + "/uptime")
      const data: UptimeData = await response.json()
      setUptime(data.uptime.formatted)
    } catch (error) {
      console.error("Failed to fetch uptime:", error)
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
    fetchUptime()
    const interval = setInterval(fetchUptime, 10000) // Update every 10 seconds

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

  const openChatSocket = useCallback(() => {
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
      console.log("Connected to chat server")
      setTimeout(() => {
        inputRef.current?.focus()
      }, 1)
    }

    ws.onmessage = (event: MessageEvent) => {
      const data: WebSocketMessage = JSON.parse(event.data)

      if (data.type === "backlog") {
        setMessages(data.messages || [])
        setHiddenMessagesCount(data.hiddenCount || 0)
      } else if (data.type === "message" && data.message) {
        setMessages((prev) => [...prev, data.message!])
      }
    }

    ws.onclose = () => {
      setConnected(false)
      console.log("Disconnected from chat server")
    }

    ws.onerror = (error: Event) => {
      console.error("WebSocket error:", error)
      setConnected(false)
    }
  }, [])

  useEffect(() => {
    openChatSocket()
    return () => {
      const ws = wsRef.current
      if (!ws) return
      try {
        ws.close()
      } finally {
        if (wsRef.current === ws) wsRef.current = null
      }
    }
  }, [openChatSocket])

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

  const verifyTdxInBrowser = useCallback(async () => {
    setVerifyResult("Verifying TDX quote...")
    try {
      const ok = await verifyTdxBase64(tappdV4Base64, {
        date: Date.parse("2025-09-01"),
        crls: [],
      })

      const ok2 = await verifyTdxBase64(trusteeV5Base64, {
        date: Date.parse("2025-09-01"),
        crls: [],
      })

      const ok3 = await verifySgxBase64(occlumSgxBase64, {
        date: Date.parse("2025-09-01"),
        crls: [],
      })

      if (ok && ok2 && ok3) {
        setVerifyResult("✅ TDX v4, v5, SGX verification succeeded")
        return
      }
      setVerifyResult("❌ Verification returned false")
    } catch (err) {
      setVerifyResult(
        `Failed to import/parse QVL: ${(err as Error)?.message || err}`,
      )
      throw err
    }
  }, [])

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h1>Chat Room</h1>
        <div className="user-info">
          <span className="username">You are: {username}</span>
          <span>
            <span
              className={`status ${connected ? "connected" : "disconnected"}`}
            >
              {connected ? "🟢 WS Connected" : "🔴 WS Disconnected"}
            </span>{" "}
            <a
              href="#"
              onClick={async (e) => {
                e.preventDefault()
                if (connected) {
                  disconnectRA()
                } else {
                  await enc.ensureConnection()
                  openChatSocket()
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

      <div
        style={{
          padding: 12,
          borderBottom: "1px solid #ddd",
        }}
      >
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
            <div style={{ fontSize: "0.8em", color: "#333" }}>Uptime</div>
            <div style={{ fontSize: "1.1em", fontWeight: 600, color: "#000" }}>
              {uptime || "—"}
            </div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "0.8em", color: "#333" }}>Counter</div>
            <div style={{ fontSize: "1.1em", fontWeight: 600, color: "#000" }}>
              {swCounter}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <button
            onClick={(e) => {
              e.preventDefault()
              fetchUptime()
            }}
            style={buttonStyle}
          >
            GET /uptime via tunnel API
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
            POST /increment via tunnel API
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

          <button
            onClick={(e) => {
              e.preventDefault()
              verifyTdxInBrowser()
            }}
            style={buttonStyle}
          >
            Verify TDX/SGX quotes in browser
          </button>
        </div>

        {verifyResult && (
          <div style={{ marginTop: 12, fontSize: "0.85em", color: "#333" }}>
            {verifyResult}
          </div>
        )}
      </div>

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
            className={`message ${message.username === username ? "own-message" : "other-message"}`}
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
          autoFocus
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
  )
}

export default App
