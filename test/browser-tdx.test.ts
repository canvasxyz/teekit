import test from "ava"
import { JSDOM } from "jsdom"
import fs from "node:fs"
import * as qvl from "../qvl"

test.serial("Simulated browser: verify TDX v4 (Tappd) using QVL", async (t) => {
  // Create a minimal DOM with location set to localhost so code paths match
  const dom = new JSDOM(`<html><body></body></html>`, {
    url: "http://localhost/",
    pretendToBeVisual: true,
  })

  // Attach browser-like globals
  // @ts-ignore
  global.window = dom.window as unknown as Window & typeof globalThis
  // @ts-ignore
  global.document = dom.window.document
  // Do NOT override global.crypto; Node provides WebCrypto used by QVL
  // atob/btoa for base64 in samples
  // @ts-ignore
  if (!global.atob) global.atob = dom.window.atob.bind(dom.window)
  // @ts-ignore
  if (!global.btoa) global.btoa = dom.window.btoa.bind(dom.window)

  // Build the same Tappd sample as the app does, but from the hex fixture
  const tappdHex = fs.readFileSync("test/sample/tdx-v4-tappd.hex", "utf-8").replace(/^0x/, "")
  const tappdV4Base64 = Buffer.from(tappdHex, "hex").toString("base64")
  const ok = await qvl.verifyTdxBase64(tappdV4Base64, {
    date: Date.parse("2025-09-01"),
    crls: [],
  })

  t.true(ok)
})

