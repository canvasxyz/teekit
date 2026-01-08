import type { TunnelServerGlobalContext, GetQuoteFunction, UpgradeWebSocketFunction } from "./types.js"

/**
 * Global context storage for TunnelServer.
 * This allows workerd environments to inject these functions globally
 * so they don't need to be passed explicitly to TunnelServer.initialize().
 */
let globalContext: TunnelServerGlobalContext = {}

/**
 * Set the global TunnelServer context.
 * Call this early in your workerd entry point to inject the required functions.
 *
 * @example
 * ```ts
 * import { setTunnelServerContext } from "@teekit/tunnel"
 * import { upgradeWebSocket } from "hono/cloudflare-workers"
 * import { getQuoteFromService } from "@teekit/kettle/worker"
 *
 * setTunnelServerContext({
 *   upgradeWebSocket,
 *   getQuote: getQuoteFromService,
 * })
 * ```
 */
export function setTunnelServerContext(ctx: TunnelServerGlobalContext): void {
  globalContext = { ...globalContext, ...ctx }
}

/**
 * Get the current global TunnelServer context.
 */
export function getTunnelServerContext(): TunnelServerGlobalContext {
  return globalContext
}

/**
 * Get the global getQuote function if set.
 */
export function getGlobalGetQuote(): GetQuoteFunction | undefined {
  return globalContext.getQuote
}

/**
 * Get the global upgradeWebSocket function if set.
 */
export function getGlobalUpgradeWebSocket(): UpgradeWebSocketFunction | undefined {
  return globalContext.upgradeWebSocket
}

/**
 * Detect if we're running inside workerd (Cloudflare Workers runtime).
 * This can be used to conditionally apply workerd-specific behavior.
 */
export function isWorkerdEnvironment(): boolean {
  try {
    // Check for Cloudflare Workers navigator.userAgent
    if (typeof navigator !== "undefined" && navigator.userAgent) {
      if (navigator.userAgent.includes("Cloudflare-Workers")) {
        return true
      }
    }
  } catch {
    // navigator may not exist in some environments
  }

  try {
    // Check for caches API which is available in Workers but not Node
    // In Node, globalThis.caches is undefined
    if (typeof caches !== "undefined" && caches !== null) {
      return true
    }
  } catch {
    // caches may throw in some environments
  }

  return false
}
