export type Message = {
  id: string
  username: string
  text: string
  timestamp: string
}

export type WebSocketMessage = {
  type: "backlog" | "message"
  messages?: Message[]
  message?: Message
  hiddenCount?: number
}

export type ChatMessage = {
  type: "chat"
  username: string
  text: string
}

export type UptimeData = {
  uptime: {
    milliseconds: number
    seconds: number
    minutes: number
    hours: number
    formatted: string
  }
}
