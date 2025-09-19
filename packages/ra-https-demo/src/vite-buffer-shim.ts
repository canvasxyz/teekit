// Ensures Buffer and process are available during Vite's dev optimize step
import { Buffer } from "buffer"
import process from "process"

// Provide exports so esbuild inject can bind these identifiers
export { Buffer } from "buffer"
export { default as process } from "process"

// Attach Buffer to globalThis if not present
if (typeof (globalThis as any).Buffer === "undefined") {
  ;(globalThis as any).Buffer = Buffer
}

// Attach process to globalThis if not present
if (typeof (globalThis as any).process === "undefined") {
  ;(globalThis as any).process = process as any
}
