import test from "ava"
import { WorkerResult } from "../server/server.js"
import { startKettle, stopKettle } from "./helpers.js"

let shared: WorkerResult | null = null

test.before(async () => {
  shared = await startKettle()
})

test.after.always(async () => {
  if (shared) {
    const kettle = shared
    shared = null
    await stopKettle(kettle)
  }
})

test.serial("static files: GET / returns index.html", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const response = await fetch(`http://localhost:${kettle.workerPort}/`)
  t.is(response.status, 200)
  t.is(response.headers.get("content-type"), "text/html;charset=utf-8")
  const html = await response.text()
  t.true(html.includes("<!doctype html>") || html.includes("<!DOCTYPE html>"))
  t.true(html.length > 0)
})

test.serial("static files: GET /index.html returns index.html", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const response = await fetch(
    `http://localhost:${kettle.workerPort}/index.html`,
  )
  t.is(response.status, 200)
  t.is(response.headers.get("content-type"), "text/html;charset=utf-8")
  const html = await response.text()
  t.true(html.includes("<!doctype html>") || html.includes("<!DOCTYPE html>"))
})

test.serial("static files: GET /vite.svg returns SVG", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  const response = await fetch(
    `http://localhost:${kettle.workerPort}/vite.svg`,
  )
  t.is(response.status, 200)
  t.is(response.headers.get("content-type"), "image/svg+xml;charset=utf-8")
  const svg = await response.text()
  t.true(svg.includes("<svg"))
})

test.serial(
  "static files: GET /assets/* returns JavaScript file",
  async (t) => {
    if (!shared) t.fail("shared worker not initialized")
    const kettle = shared!

    // First get index.html to find the asset path
    const indexResponse = await fetch(`http://localhost:${kettle.workerPort}/`)
    const html = await indexResponse.text()

    // Extract the JS asset path from index.html
    const jsMatch = html.match(/\/assets\/index-[^"]+\.js/)
    if (!jsMatch) {
      t.fail("Could not find JS asset in index.html")
      return
    }

    const jsPath = jsMatch[0]
    const response = await fetch(`http://localhost:${kettle.workerPort}${jsPath}`)
    t.is(response.status, 200)
    t.is(response.headers.get("content-type"), "text/javascript;charset=utf-8")
    const js = await response.text()
    t.true(js.length > 0)
  },
)

test.serial(
  "static files: GET /assets/* returns CSS file",
  async (t) => {
    if (!shared) t.fail("shared worker not initialized")
    const kettle = shared!

    // First get index.html to find the asset path
    const indexResponse = await fetch(`http://localhost:${kettle.workerPort}/`)
    const html = await indexResponse.text()

    // Extract the CSS asset path from index.html
    const cssMatch = html.match(/\/assets\/index-[^"]+\.css/)
    if (!cssMatch) {
      t.fail("Could not find CSS asset in index.html")
      return
    }

    const cssPath = cssMatch[0]
    const response = await fetch(
      `http://localhost:${kettle.workerPort}${cssPath}`,
    )
    t.is(response.status, 200)
    t.is(response.headers.get("content-type"), "text/css;charset=utf-8")
    const css = await response.text()
    t.true(css.length > 0)
  },
)

test.serial(
  "static files: SPA routing - unknown paths return index.html",
  async (t) => {
    if (!shared) t.fail("shared worker not initialized")
    const kettle = shared!

    // Test that non-existent paths return index.html for SPA routing
    const response = await fetch(
      `http://localhost:${kettle.workerPort}/some/random/path`,
    )
    t.is(response.status, 200)
    t.is(response.headers.get("content-type"), "text/html;charset=utf-8")
    const html = await response.text()
    t.true(html.includes("<!doctype html>") || html.includes("<!DOCTYPE html>"))
  },
)

test.serial("static files: API routes still work", async (t) => {
  if (!shared) t.fail("shared worker not initialized")
  const kettle = shared!

  // Ensure API routes are not overridden by static file middleware
  const response = await fetch(`http://localhost:${kettle.workerPort}/uptime`)
  t.is(response.status, 200)
  const data = await response.json()
  t.truthy(data.uptime)
  t.truthy(data.uptime.formatted)
})

test.serial(
  "static files: POST requests to API routes work",
  async (t) => {
    if (!shared) t.fail("shared worker not initialized")
    const kettle = shared!

    const response = await fetch(
      `http://localhost:${kettle.workerPort}/increment`,
      { method: "POST" },
    )
    t.is(response.status, 200)
    const data = await response.json()
    t.true(typeof data.counter === "number")
  },
)
