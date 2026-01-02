import react from "@vitejs/plugin-react"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { defineConfig } from "vite"
import { includeRaServiceWorker } from "@teekit/tunnel/sw"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), nodePolyfills(), includeRaServiceWorker()],
  root: path.resolve(__dirname, '../demo'),
  build: {
    outDir: path.resolve(__dirname, 'dist/static'),
    emptyOutDir: true
  }
})
