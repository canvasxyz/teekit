import type { Request, RequestHandler } from "express"

// Symbol used to mark requests that arrived via the encrypted tunnel
export const ENCRYPTED_REQUEST = Symbol.for("ra-https:encrypted_request")

export function isEncryptedRequest(req: Request | any): boolean {
  try {
    return Boolean(req && req[ENCRYPTED_REQUEST] === true)
  } catch {
    return false
  }
}

export function markRequestAsEncrypted(req: any): void {
  try {
    req[ENCRYPTED_REQUEST] = true
  } catch {}
}

/**
 * Express middleware to require that a request was delivered over the
 * encrypted tunnel. Direct HTTP access will be rejected.
 */
export function encryptedOnly(options?: {
  status?: number
  message?: string
}): RequestHandler {
  const status = options?.status ?? 403
  const message = options?.message ?? "Encrypted channel required"
  return (req, res, next) => {
    if (isEncryptedRequest(req)) {
      return next()
    }
    try {
      res.status(status).type("text/plain").send(message)
    } catch {
      // In case headers are already sent or similar, end the response
      try {
        res.end()
      } catch {}
    }
  }
}

