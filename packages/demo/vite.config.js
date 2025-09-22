import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { nodePolyfills } from "vite-plugin-node-polyfills"

export default defineConfig({
  plugins: [react(), nodePolyfills()],
  define: {
    "process.env": JSON.stringify({}),
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        "tunnel-sw": "src/sw/tunnel-sw.ts",
      },
    },
  },
})
