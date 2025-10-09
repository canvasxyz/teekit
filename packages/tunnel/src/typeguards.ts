import type { Hono } from "hono"
import type {
  RAEncryptedClientCloseEvent,
  RAEncryptedClientConnectEvent,
  RAEncryptedHTTPRequest,
  RAEncryptedHTTPResponse,
  RAEncryptedServerEvent,
  RAEncryptedWSMessage,
  ControlChannelEncryptedMessage,
  ControlChannelKXAnnounce,
  ControlChannelKXConfirm,
  TunnelApp,
} from "./types.js"

export function isHonoApp(app: TunnelApp): app is Hono {
  return "fetch" in app && typeof app.fetch === "function"
}

export function isRAEncryptedHTTPRequest(
  message: unknown,
): message is RAEncryptedHTTPRequest {
  return isMessage(message) && message.type === "http_request"
}

export function isRAEncryptedHTTPResponse(
  message: unknown,
): message is RAEncryptedHTTPResponse {
  return isMessage(message) && message.type === "http_response"
}

export function isRAEncryptedClientConnectEvent(
  message: unknown,
): message is RAEncryptedClientConnectEvent {
  return isMessage(message) && message.type === "ws_connect"
}

export function isRAEncryptedClientCloseEvent(
  message: unknown,
): message is RAEncryptedClientCloseEvent {
  return isMessage(message) && message.type === "ws_close"
}

export function isRAEncryptedWSMessage(
  message: unknown,
): message is RAEncryptedWSMessage {
  return isMessage(message) && message.type === "ws_message"
}

export function isRAEncryptedServerEvent(
  message: unknown,
): message is RAEncryptedServerEvent {
  return isMessage(message) && message.type === "ws_event"
}

export function isControlChannelKXAnnounce(
  message: unknown,
): message is ControlChannelKXAnnounce {
  return isMessage(message) && message.type === "server_kx"
}

export function isControlChannelKXConfirm(
  message: unknown,
): message is ControlChannelKXConfirm {
  return isMessage(message) && message.type === "client_kx"
}

export function isControlChannelEncryptedMessage(
  message: unknown,
): message is ControlChannelEncryptedMessage {
  return isMessage(message) && message.type === "enc"
}

export function isMessage(message: unknown): message is { type: string } {
  return typeof message === "object" && message !== null && "type" in message
}
