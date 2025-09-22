import type { Request, Response, NextFunction } from "express"

/**
 * Unique symbol set on requests that arrive via the encrypted tunnel.
 * This cannot be spoofed by external HTTP clients.
 */
export const RA_HTTPS_ENCRYPTED: unique symbol = Symbol.for(
  "ra-https:encrypted",
)

/**
 * Mark an Express `Request` as arriving via the encrypted tunnel.
 */
export function markEncryptedRequest(req: unknown): void {
  try {
    ;(req as any)[RA_HTTPS_ENCRYPTED] = true
  } catch {}
}

/**
 * Check whether a request arrived via the encrypted tunnel.
 */
export function isEncryptedRequest(req: unknown): boolean {
  try {
    return Boolean((req as any)?.[RA_HTTPS_ENCRYPTED] === true)
  } catch {
    return false
  }
}

export type EncryptedOnlyOptions = {
  /** HTTP status code to return when access is denied (default 403). */
  statusCode?: number
  /** Message body to return when access is denied. */
  errorMessage?: string
}

/**
 * Express middleware that restricts access to requests delivered via the
 * encrypted tunnel only. Direct HTTP requests will be rejected.
 */
export function encryptedOnly(options?: EncryptedOnlyOptions) {
  const status = options?.statusCode ?? 403
  const message = options?.errorMessage ?? "Encrypted channel required"
  return function (_req: Request, res: Response, next: NextFunction) {
    if (isEncryptedRequest(_req)) return next()
    res.status(status).send(message)
  }
}

