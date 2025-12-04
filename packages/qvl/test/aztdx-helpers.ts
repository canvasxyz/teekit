import fs from "node:fs"
import { base64 as scureBase64 } from "@scure/base"

/**
 * Parse the trustauthority-cli output file format:
 * Quote: <base64>
 * runtime_data: <base64>
 * user_data: <base64>
 */
export function parseTrustAuthorityCLIOutput(filePath: string): {
  quote: Uint8Array
  runtimeData: Uint8Array
  userData: Uint8Array
  nonce: Uint8Array
} {
  const content = fs.readFileSync(filePath, "utf-8")
  const lines = content.trim().split("\n")

  let quoteB64 = ""
  let runtimeDataB64 = ""
  let userDataB64 = ""

  for (const line of lines) {
    if (line.startsWith("Quote: ")) {
      quoteB64 = line.slice("Quote: ".length).trim()
    } else if (line.startsWith("runtime_data: ")) {
      runtimeDataB64 = line.slice("runtime_data: ".length).trim()
    } else if (line.startsWith("user_data: ")) {
      userDataB64 = line.slice("user_data: ".length).trim()
    }
  }

  if (!quoteB64) throw new Error("Missing Quote in CLI output")
  if (!runtimeDataB64) throw new Error("Missing runtime_data in CLI output")
  if (!userDataB64) throw new Error("Missing user_data in CLI output")

  return {
    quote: scureBase64.decode(quoteB64),
    runtimeData: scureBase64.decode(runtimeDataB64),
    userData: scureBase64.decode(userDataB64),
    // The nonce used was 'dGVzdG5vbmNl' which is base64("testnonce")
    nonce: scureBase64.decode("dGVzdG5vbmNl"),
  }
}

/**
 * Parse the runtime_data JSON to extract the user-data field.
 */
export function parseRuntimeDataJson(runtimeData: Uint8Array): {
  userData: string
  keys: Array<{ kid: string; kty: string; n?: string; e?: string }>
} {
  const json = JSON.parse(new TextDecoder().decode(runtimeData))
  return {
    userData: json["user-data"],
    keys: json.keys,
  }
}
