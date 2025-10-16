export function parseBody(body: string, contentType?: string) {
  if (!contentType) return body

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(body)
    const result: Record<string, string> = {}
    params.forEach((value, key) => {
      result[key] = value
    })
    return result
  }

  return body
}

export function sanitizeHeaders(
  headers: any, // TODO
): Record<string, string | string[]> {
  const sanitized: Record<string, string | string[]> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      sanitized[key] = value
    } else if (Array.isArray(value)) {
      // Preserve multi-value headers (e.g., multiple Set-Cookie)
      sanitized[key] = value.map((v) => String(v))
    } else if (value !== undefined && value !== null) {
      sanitized[key] = String(value)
    }
  }

  return sanitized
}

export function getStatusText(statusCode: number): string {
  const statusTexts: Record<number, string> = {
    200: "OK",
    201: "Created",
    204: "No Content",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    500: "Internal Server Error",
    501: "Not Implemented",
    502: "Bad Gateway",
    503: "Service Unavailable",
  }

  return statusTexts[statusCode] || "Unknown"
}
