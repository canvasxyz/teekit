import test from "ava"
import express from "express"
import type { AddressInfo } from "node:net"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { TunnelClient, TunnelServer, QuoteData } from "@teekit/tunnel"
import { base64 } from "@scure/base"
import { hex, parseTdxQuote, getAzureExpectedReportData } from "@teekit/qvl"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Parse the trustauthority-cli output file format:
 * Quote: <base64>
 * runtime_data: <base64>
 * user_data: <base64>
 */
function parseTrustAuthorityCLIOutput(filePath: string): {
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
    quote: base64.decode(quoteB64),
    runtimeData: base64.decode(runtimeDataB64),
    userData: base64.decode(userDataB64),
    // The nonce used was 'dGVzdG5vbmNl' which is base64("testnonce")
    nonce: base64.decode("dGVzdG5vbmNl"),
  }
}

// Load the Azure CLI sample quote with full runtime_data (HCL report format)
// Generated with: trustauthority-cli quote --aztdx --nonce 'dGVzdG5vbmNl' --user-data 'A6gQcDB6++rAaw3074ZXY5GLXiqfoDDiACWkMV2rSyo='
const azureSample = parseTrustAuthorityCLIOutput(
  path.join(__dirname, "../../qvl/test/sampleQuotes/tdx-v4-aztdx"),
)
const azureQuote = azureSample.quote
const azureRuntimeData = azureSample.runtimeData

// The nonce and user_data used to generate the sample quote
const sampleNonce = azureSample.nonce // "testnonce"
const sampleUserData = azureSample.userData

// The expected runtime_data.user-data value (SHA512(nonce || user_data))
const expectedRuntimeUserDataHex =
  "4B453B5F70E5E2080AD97AFC62B0546BA3EFED53966A5DA9BBB42BCC8DECB5BE6B77F1F6F042C7FBFFA2CEA1042D89AA96CA51D204AD00ABA2D04FA5A9702BE9"

async function stopAzureTunnel(
  tunnelServer: TunnelServer,
  tunnelClient: TunnelClient,
) {
  tunnelClient.close()
  await new Promise<void>((resolve) => {
    tunnelServer.wss.close(() => resolve())
  })
  if (tunnelServer.server) {
    await new Promise<void>((resolve) => {
      tunnelServer.server!.close(() => resolve())
    })
  }
}

/**
 * Azure TDX vTPM Attestation Test
 *
 * These tests verify the Azure TDX binding mode, which establishes trust through:
 *
 * 1. Intel Root CA → PCK Cert → QE → TDX Quote (verified by verifyTdx)
 * 2. report_data[0:32] = SHA256(runtime_data JSON)
 * 3. report_data[32:64] = zeros (Azure convention)
 * 4. runtime_data.keys contains HCLAkPub (vTPM attestation key)
 * 5. runtime_data["user-data"] = SHA512(nonce || x25519key)
 *
 * The TDX quote signature covers Header || Body, where Body contains BOTH:
 * - Measurements (mr_td, rtmr0-3) - identifies what code is running
 * - report_data (64 bytes) - contains SHA256(runtime_data)
 *
 * Since measurements and report_data are in the same signed message, a malicious
 * party cannot take a valid quote with measurements X and attach runtime_data
 * from a different machine - changing report_data would invalidate the signature.
 */
test.serial(
  "Azure TDX: end-to-end tunnel with aztdx binding mode",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    // Server returns quote with the real Azure runtime_data from the sample
    // The sample quote's report_data[0:32] = SHA256(azureRuntimeData)
    // The sample's user-data = SHA512(sampleNonce || sampleUserData)
    //
    // For a real deployment, the server would generate a fresh quote with
    // the X25519 key bound. For testing, we use the sample quote and pass
    // the sample userData as the "x25519 key" to verify the binding logic works.
    const getQuote = async (_x25519PublicKey: Uint8Array): Promise<QuoteData> => {
      return {
        quote: azureQuote,
        verifier_data: {
          val: sampleNonce, // nonce used to generate the sample quote
          iat: new Uint8Array(), // Not used in Azure binding
        },
        // Use the real runtime_data - its hash matches report_data[0:32]
        runtime_data: azureRuntimeData,
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    // Client uses aztdx mode with custom x25519Binding to handle the sample data
    // In the sample, user-data = SHA512(sampleNonce || sampleUserData), not x25519 key
    const quoteBody = parseTdxQuote(azureQuote).body
    const tunnelClient = await TunnelClient.initialize(origin, {
      measurements: {
        mrtd: hex(quoteBody.mr_td),
      },
      aztdx: true,
      // Override x25519 binding check since sample uses sampleUserData, not x25519 key
      x25519Binding: async (client) => {
        // Verify full chain of trust manually:
        // 1. quote structure (zeros in report_data[32:64])
        // 2. SHA256(runtime_data) == report_data[0:32]
        // 3. runtime_data["user-data"] == SHA512(nonce || sampleUserData)
        const runtimeData = client.reportBindingData?.runtimeData
        const nonce = client.reportBindingData?.verifierData?.val
        if (!runtimeData || !nonce) return false

        // Verify runtime_data hash binding
        const hash = await crypto.subtle.digest("SHA-256", runtimeData.slice())
        const hashBytes = new Uint8Array(hash)
        const reportFirst32 = quoteBody.report_data.slice(0, 32)
        for (let i = 0; i < 32; i++) {
          if (hashBytes[i] !== reportFirst32[i]) return false
        }

        // Verify user-data binding (with sample userData instead of x25519 key)
        const runtimeDataStr = new TextDecoder().decode(runtimeData)
        const runtimeDataObj = JSON.parse(runtimeDataStr)
        const userDataHex = runtimeDataObj["user-data"]

        const expectedHash = await getAzureExpectedReportData(nonce, sampleUserData)
        const expectedHex = hex(expectedHash).toUpperCase()

        return userDataHex.toUpperCase() === expectedHex
      },
    })

    try {
      // Make a request through the tunnel
      const response = await tunnelClient.fetch(`${origin}/hello`)
      t.is(response.status, 200)
      t.is(await response.text(), "world")
    } finally {
      await stopAzureTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "Azure TDX: binding fails when x25519 key doesn't match user-data",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    // Server returns quote with real runtime_data
    // The runtime_data hash is valid, but user-data was bound to sampleUserData
    // When aztdx mode tries to verify SHA512(nonce || x25519key) == user-data,
    // it will fail because x25519key != sampleUserData
    const getQuote = async (_x25519PublicKey: Uint8Array): Promise<QuoteData> => {
      return {
        quote: azureQuote,
        verifier_data: {
          val: sampleNonce,
          iat: new Uint8Array(),
        },
        // Use real runtime_data - hash matches, but user-data is for sampleUserData
        runtime_data: azureRuntimeData,
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    const quoteBody = parseTdxQuote(azureQuote).body
    const tunnelClient = await TunnelClient.initialize(origin, {
      measurements: {
        mrtd: hex(quoteBody.mr_td),
      },
      aztdx: true,
      // Don't override x25519Binding - let it fail naturally
    })

    try {
      // Connection should fail because user-data was bound to sampleUserData,
      // not the x25519 key that the client generates
      await t.throwsAsync(
        async () => {
          await tunnelClient.ensureConnection()
        },
        {
          message: /Azure binding failed/,
        },
      )
    } finally {
      await stopAzureTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "Azure TDX: binding fails when runtime_data is missing",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    // Server returns quote WITHOUT runtime_data
    const getQuote = async (_x25519PublicKey: Uint8Array): Promise<QuoteData> => {
      return {
        quote: azureQuote,
        verifier_data: {
          val: sampleNonce,
          iat: new Uint8Array(),
        },
        // No runtime_data!
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    const quoteBody = parseTdxQuote(azureQuote).body
    const tunnelClient = await TunnelClient.initialize(origin, {
      measurements: {
        mrtd: hex(quoteBody.mr_td),
      },
      aztdx: true,
    })

    try {
      await t.throwsAsync(
        async () => {
          await tunnelClient.fetch(`${origin}/hello`)
        },
        {
          message: /missing runtime_data/,
        },
      )
    } finally {
      await stopAzureTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "Azure TDX: binding fails when nonce is missing",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    // Server returns quote WITHOUT nonce in verifier_data
    const getQuote = async (_x25519PublicKey: Uint8Array): Promise<QuoteData> => {
      return {
        quote: azureQuote,
        // No verifier_data with nonce!
        runtime_data: azureRuntimeData,
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    const quoteBody = parseTdxQuote(azureQuote).body
    const tunnelClient = await TunnelClient.initialize(origin, {
      measurements: {
        mrtd: hex(quoteBody.mr_td),
      },
      aztdx: true,
    })

    try {
      await t.throwsAsync(
        async () => {
          await tunnelClient.fetch(`${origin}/hello`)
        },
        {
          message: /missing verifier_nonce\.val/,
        },
      )
    } finally {
      await stopAzureTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "Azure TDX: binding fails when runtime_data is malformed",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    // Server returns quote with malformed runtime_data (not valid HCL report)
    const getQuote = async (_x25519PublicKey: Uint8Array): Promise<QuoteData> => {
      return {
        quote: azureQuote,
        verifier_data: {
          val: sampleNonce,
          iat: new Uint8Array(),
        },
        runtime_data: new TextEncoder().encode("not valid data"),
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    const quoteBody = parseTdxQuote(azureQuote).body
    const tunnelClient = await TunnelClient.initialize(origin, {
      measurements: {
        mrtd: hex(quoteBody.mr_td),
      },
      aztdx: true,
    })

    try {
      await t.throwsAsync(
        async () => {
          await tunnelClient.fetch(`${origin}/hello`)
        },
        {
          // Hash of malformed runtime_data won't match quote's report_data
          message: /Azure chain of trust failed/,
        },
      )
    } finally {
      await stopAzureTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "Azure TDX: verify sample quote binding with known nonce and user_data",
  async (t) => {
    // This test verifies that the Azure binding computation is correct
    // using the known sample values from the CLI-generated quote
    const expectedHash = await getAzureExpectedReportData(
      sampleNonce,
      sampleUserData,
    )
    const expectedHex = hex(expectedHash).toUpperCase()

    t.is(
      expectedHex,
      expectedRuntimeUserDataHex,
      "SHA512(nonce || user_data) should match expected runtime_data.user-data",
    )
  },
)

