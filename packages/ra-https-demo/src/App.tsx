import {
  useState,
  useEffect,
  useRef,
  FormEvent,
  ChangeEvent,
  useCallback,
} from "react"
import "./App.css"

import { Message, WebSocketMessage, ChatMessage, UptimeData } from "./types.js"
import { getStoredUsername } from "./utils.js"
import { RA } from "../tunnel/client.js"
import { tappdV4Base64, trusteeV5Base64, occlumSgxBase64 } from "./samples/samples.js"

const baseUrl =
  document.location.hostname === "localhost"
    ? "http://localhost:3001"
    : "https://ra-https.up.railway.app"
const ra = await RA.initialize(baseUrl)

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [newMessage, setNewMessage] = useState<string>("")
  const [username] = useState<string>(getStoredUsername)
  const [connected, setConnected] = useState<boolean>(false)
  const [uptime, setUptime] = useState<string>("")
  const [hiddenMessagesCount, setHiddenMessagesCount] = useState<number>(0)
  const [verifyResult, setVerifyResult] = useState<string>("")
  const wsRef = useRef<WebSocket | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(scrollToBottom, [messages])

  const fetchUptime = useCallback(async () => {
    try {
      const response = await ra.fetch(baseUrl + "/uptime")
      const data: UptimeData = await response.json()
      setUptime(data.uptime.formatted)
    } catch (error) {
      console.error("Failed to fetch uptime:", error)
    }
  }, [])

  const disconnectRA = useCallback(() => {
    try {
      if (ra.ws) {
        ra.ws.close(4000, "simulate disconnect")
      }
    } catch (e) {
      console.error("Failed to close RA WebSocket:", e)
    }
  }, [])

  useEffect(() => {
    fetchUptime()
    const interval = setInterval(fetchUptime, 10000) // Update every 10 seconds

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
    const ws = new ra.WebSocket(wsUrl)
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

  const verifyTdxInBrowser = useCallback(async () => {
    setVerifyResult("Verifying TDX quote...")
    try {
      const qvl = await import(/* @vite-ignore */ "../qvl/index.js")

      const ok = await qvl.verifyTdxBase64(tappdV4Base64, {
        date: Date.parse("2025-09-01"),
        crls: [],
      })

      const ok2 = await qvl.verifyTdxBase64(trusteeV5Base64, {
        date: Date.parse("2025-09-01"),
        crls: [],
      })

      const ok3 = await qvl.verifySgxBase64(occlumSgxBase64, {
        date: Date.parse("2025-09-01"),
        crls: [],
      })

      if (ok && ok2 && ok3) {
        setVerifyResult("✅ TDX v4, v5, SGX verification succeeded")
        return
      }
      setVerifyResult("❌ Verification returned false")
    } catch (err) {
      setVerifyResult(`Failed to import/parse QVL: ${(err as Error)?.message || err}`)
      throw err
    }
  }, [])

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h1>Chat Room</h1>
        <div className="user-info">
          <span className="username">You are: {username}</span>
          <span
            className={`status ${connected ? "connected" : "disconnected"}`}
          >
            {connected ? "🟢 Connected" : "🔴 Disconnected"}
          </span>{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              disconnectRA()
            }}
            style={{
              color: "#333",
              textDecoration: "underline",
              cursor: "pointer",
              fontSize: "0.85em",
            }}
          >
            Disconnect
          </a>
        </div>
      </div>

      <div className="messages-container">
        {uptime && (
          <div className="uptime-display">
            Server uptime: {uptime}{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                fetchUptime()
              }}
              style={{
                color: "inherit",
                textDecoration: "underline",
                cursor: "pointer",
              }}
            >
              Refresh
            </a>
            <div style={{ margin: "10px 0" }}>
              <button
                onClick={(e) => {
                  e.preventDefault()
                  verifyTdxInBrowser()
                }}
                style={{
                  padding: "4px 8px",
                  fontSize: "0.85em",
                }}
              >
                Verify TDX v4 (Tappd)
              </button>
            </div>
            {verifyResult && (
              <div className="verification-display">{verifyResult}</div>
            )}
          </div>
        )}
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
