import express from "express"
import cors from "cors"
import { WebSocket } from "ws"

import {
  Message,
  IncomingChatMessage,
  BacklogMessage,
  BroadcastMessage,
} from "./types.js"

/* ********************************************************************************
 * Begin teekit tunnel code.
 * ******************************************************************************** */
import {
  TunnelServer,
  ServerRAMockWebSocket,
  encryptedOnly,
  QuoteData,
} from "@teekit/tunnel"
import fs from "node:fs"
import { exec } from "node:child_process"
import { base64 } from "@scure/base"
import { hex } from "@teekit/qvl"

async function getQuote(x25519PublicKey: Uint8Array): Promise<QuoteData> {
  return await new Promise<QuoteData>(async (resolve, reject) => {
    // If config.json isn't set up, return a sample quote
    if (!fs.existsSync("config.json")) {
      console.log(
        "[teekit-demo] TDX config.json not found, serving sample quote",
      )
      const { tappdV4Base64 } = await import("@teekit/tunnel/samples")
      resolve({
        quote: base64.decode(tappdV4Base64),
      })
      return
    }

    // Otherwise, get a quote from the SEAM (requires root)
    console.log("[teekit-demo] Getting a quote for " + hex(x25519PublicKey))
    const userDataB64 = base64.encode(x25519PublicKey)
    // GCP (v1.10.x): trustauthority-cli evidence --tdx --user-data '<base64>' -c config.json
    // Azure (v1.6.1): trustauthority-cli quote --aztdx --user-data '<base64>'
    const cloudProvider = process.env.CLOUD_PROVIDER || "gcp"
    const cmd = cloudProvider === "azure"
      ? `trustauthority-cli quote --aztdx --user-data '${userDataB64}'`
      : `trustauthority-cli evidence --tdx --user-data '${userDataB64}' -c config.json`
    exec(cmd, (err, stdout) => {
      if (err) {
        return reject(err)
      }

      try {
        const response = JSON.parse(stdout)
        resolve({
          quote: base64.decode(response.tdx.quote),
          verifier_data: {
            iat: base64.decode(response.tdx.verifier_nonce.iat),
            val: base64.decode(response.tdx.verifier_nonce.val),
            signature: base64.decode(response.tdx.verifier_nonce.signature),
          },
          runtime_data: base64.decode(response.tdx.runtime_data),
        })
      } catch (err) {
        reject(err)
      }
    })
  })
}

const app = express()
const { server, wss } = await TunnelServer.initialize(app, getQuote)

/* ********************************************************************************
 * End teekit tunnel code.
 * ******************************************************************************** */

app.use(cors())
app.use(express.json())

let messages: Message[] = []
let totalMessageCount = 0
const MAX_MESSAGES = 30
const startTime = Date.now()
let counter = 0

// API Routes
app.get("/uptime", encryptedOnly(), (_req, res) => {
  const uptimeMs = Date.now() - startTime
  const uptimeSeconds = Math.floor(uptimeMs) / 1000
  const uptimeMinutes = Math.floor(uptimeSeconds / 60)
  const uptimeHours = Math.floor(uptimeMinutes / 60)

  const minutes = (uptimeMinutes % 60).toString()
  const seconds = (uptimeSeconds % 60).toString().slice(0, 4)

  res.json({
    uptime: {
      formatted: `${
        uptimeHours ? uptimeHours + "h" : ""
      } ${minutes}m ${seconds}s`,
    },
  })
})

/* ********************************************************************************
 * The encryptedOnly() middleware blocks direct requests from the Express server.
 * ******************************************************************************** */

app.post("/increment", encryptedOnly(), (_req, res) => {
  counter += 1
  res.json({ counter })
})

wss.on("connection", (ws: WebSocket) => {
  console.log("[teekit-demo] Client connected")

  // Send message backlog to new client
  const hiddenCount = Math.max(0, totalMessageCount - messages.length)
  const backlogMessage: BacklogMessage = {
    type: "backlog",
    messages: messages,
    hiddenCount: hiddenCount,
  }
  ws.send(JSON.stringify(backlogMessage))

  ws.on("message", (data: Buffer) => {
    try {
      const message: IncomingChatMessage = JSON.parse(data.toString())

      if (message.type === "chat") {
        const chatMessage: Message = {
          id: Date.now().toString(),
          username: message.username,
          text: message.text,
          timestamp: new Date().toISOString(),
        }

        // Add to message history
        messages.push(chatMessage)
        totalMessageCount++

        // Keep only last 30 messages
        if (messages.length > MAX_MESSAGES) {
          messages = messages.slice(-MAX_MESSAGES)
        }

        // Broadcast to all connected clients
        const broadcastMessage: BroadcastMessage = {
          type: "message",
          message: chatMessage,
        }

        wss.clients.forEach((client: ServerRAMockWebSocket) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(broadcastMessage))
          }
        })
      }
    } catch (error) {
      console.error("[teekit-demo] Error parsing message:", error)
    }
  })

  ws.on("close", () => {
    console.log("[teekit-demo] Client disconnected")
  })
})

app.use(express.static("dist"))

const PORT = process.env.PORT || 3001

server.listen(PORT, () => {
  console.log(
    `[teekit-demo] WebSocket server running on http://localhost:${PORT}`,
  )
})
