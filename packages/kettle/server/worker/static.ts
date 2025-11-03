// Static file serving middleware, based on workerd sample:
// https://github.com/cloudflare/workerd/tree/main/samples/static-files-from-disk

import { Context } from "hono"

const MIME_TYPES: Record<string, string> = {
  txt: "text/plain;charset=utf-8",
  html: "text/html;charset=utf-8",
  htm: "text/html;charset=utf-8",
  css: "text/css;charset=utf-8",
  js: "text/javascript;charset=utf-8",
  mjs: "text/javascript;charset=utf-8",
  json: "application/json;charset=utf-8",
  md: "text/markdown;charset=utf-8",
  svg: "image/svg+xml;charset=utf-8",
  xml: "text/xml;charset=utf-8",
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
  eot: "application/vnd.ms-fontobject",
}

function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || ""
  return MIME_TYPES[ext] || "application/octet-stream"
}

export const serveStatic = () => {
  return async (c: Context) => {
    if (!c.env.STATIC_FILES) {
      return c.notFound()
    }

    const url = new URL(c.req.url)
    let path = url.pathname

    // Default to index.html for directory requests
    if (path.endsWith("/")) {
      path = path + "index.html"
    }

    try {
      // Fetch path directly
      const response = await c.env.STATIC_FILES.fetch(
        new Request(`http://dummy${path}`, {
          method: c.req.method,
        }),
      )

      if (!response.ok) {
        // Fetch path with additional .html extension (if it's not already present)
        if (response.status === 404 && !path.endsWith(".html")) {
          const htmlPath = path + ".html"
          const htmlResponse = await c.env.STATIC_FILES.fetch(
            new Request(`http://dummy${htmlPath}`, {
              method: c.req.method,
            }),
          )
          if (htmlResponse.ok) {
            const filename = htmlPath.split("/").pop() || "index.html"
            const contentType = getMimeType(filename)
            return c.body(htmlResponse.body, {
              headers: {
                "Content-Type": contentType,
              },
            })
          }
        }

        return c.notFound()
      }

      const filename = path.split("/").pop() || "index.html"
      const contentType = getMimeType(filename)

      return c.body(response.body, {
        headers: {
          "Content-Type": contentType,
        },
      })
    } catch (err) {
      console.error("[kettle] Error serving static file:", err)
      return c.json({ error: "Internal Server Error" }, 500)
    }
  }
}
