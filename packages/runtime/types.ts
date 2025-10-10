export type Message = {
  id: string
  username: string
  text: string
  timestamp: string
}

export type IncomingChatMessage = {
  type: "chat"
  username: string
  text: string
}

export type BacklogMessage = {
  type: "backlog"
  messages: Message[]
  hiddenCount: number
}

export type BroadcastMessage = {
  type: "message"
  message: Message
}
