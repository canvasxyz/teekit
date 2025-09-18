import test from "ava"
import { Crypto } from "@peculiar/webcrypto"
import * as qvl from "../qvl"
import fs from "node:fs"

const BASE_TIME = Date.parse("2025-09-01")

// Minimal browser-like environment
if (!(globalThis as any).window) (globalThis as any).window = globalThis
if (!(globalThis as any).btoa) {
  ;(globalThis as any).btoa = (str: string) =>
    Buffer.from(str, "binary").toString("base64")
}
if (!(globalThis as any).atob) {
  ;(globalThis as any).atob = (b64: string) =>
    Buffer.from(b64, "base64").toString("binary")
}
// Prefer a WebCrypto-like implementation on globalThis, like in browsers
if (!(globalThis as any).crypto || !(globalThis as any).crypto.subtle) {
  ;(globalThis as any).crypto = new Crypto()
}

test.serial(
  "Browser-simulated: Verify TDX v4 (Tappd) using dynamic import",
  async (t) => {
    const hex = fs.readFileSync("test/sample/tdx-v4-tappd.hex", "utf-8")
    const base64 = Buffer.from(hex.replace(/^0x/, ""), "hex").toString(
      "base64",
    )
    const ok = await qvl.verifyTdxBase64(base64, {
      date: BASE_TIME,
      crls: [],
    })
    t.true(ok)
  },
)

