import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.js"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register Service Worker for tunneling same-origin fetch requests
if ("serviceWorker" in navigator) {
  const target =
    document.location.hostname === "localhost"
      ? "http://localhost:3001"
      : "https://ra-https.up.railway.app"

  // During Vite dev, entries are served from /src/...; in build they're emitted at root
  const dev = import.meta && (import.meta as any).env && (import.meta as any).env.DEV
  const swPath = dev ? "/src/sw/tunnel-sw.ts" : "/tunnel-sw.js"
  const swUrl = `${swPath}?target=${encodeURIComponent(target)}`

  navigator.serviceWorker
    .register(swUrl, { type: "module", scope: "/" })
    .catch(() => {})
}
