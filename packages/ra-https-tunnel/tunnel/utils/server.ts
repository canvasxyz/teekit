export function parseBody(body: string, contentType?: string): any {
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

export function sanitizeHeaders(headers: any): Record<string, string> {
  const sanitized: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      sanitized[key] = value
    } else if (Array.isArray(value)) {
      sanitized[key] = value.join(", ")
    } else {
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

export function isTextData(data: Buffer): boolean {
  // Simple heuristic to detect if data is likely text
  // Check for null bytes and high-bit characters
  for (let i = 0; i < Math.min(data.length, 1024); i++) {
    const byte = data[i]
    if (byte === 0 || (byte > 127 && byte < 160)) {
      return false
    }
  }
  return true
}
