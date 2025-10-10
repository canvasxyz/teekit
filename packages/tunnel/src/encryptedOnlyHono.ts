import type { MiddlewareHandler } from "hono"
import type { StatusCode } from "hono/utils/http-status"

import { ENCRYPTED_REQUEST } from "./encryptedOnly.js"

/**
 * Hono middleware to require that a request was delivered over the
 * encrypted tunnel. Direct HTTP access will be rejected.
 */
export function encryptedOnlyHono(options?: {
  errorStatus?: number
  errorMessage?: string
}): MiddlewareHandler {
  const errorStatus = options?.errorStatus ?? 403
  const errorMessage = options?.errorMessage ?? "Encrypted channel required"

  return async (c, next) => {
    try {
      if (c.req.raw && (c.req.raw as any)[ENCRYPTED_REQUEST] === true) {
        return await next()
      }
    } catch (err) {
      console.warn("teekit: could not mark Hono request as encrypted")
    }

    c.status(errorStatus as StatusCode)
    return c.text(errorMessage)
  }
}
