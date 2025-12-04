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

// Load the Azure CLI sample quote
// Generated with: trustauthority-cli quote --aztdx --nonce 'dGVzdG5vbmNl' --user-data 'A6gQcDB6++rAaw3074ZXY5GLXiqfoDDiACWkMV2rSyo='
const azureQuoteB64 = fs
  .readFileSync(
    path.join(__dirname, "../../qvl/test/sampleQuotes/tdx-v4-azure-cli"),
    "utf-8",
  )
  .trim()
const azureQuote = base64.decode(azureQuoteB64)

// The nonce and user_data used to generate the sample quote
const sampleNonce = base64.decode("dGVzdG5vbmNl") // "testnonce"
const sampleUserData = base64.decode("A6gQcDB6++rAaw3074ZXY5GLXiqfoDDiACWkMV2rSyo=")

// The expected runtime_data.user-data value (SHA512(nonce || user_data))
const expectedRuntimeUserDataHex =
  "4B453B5F70E5E2080AD97AFC62B0546BA3EFED53966A5DA9BBB42BCC8DECB5BE6B77F1F6F042C7FBFFA2CEA1042D89AA96CA51D204AD00ABA2D04FA5A9702BE9"

// Build a mock runtime_data JSON that matches what trustauthority-cli would return
function buildMockRuntimeData(userDataHex: string): Uint8Array {
  const runtimeDataObj = {
    "user-data": userDataHex,
  }
  return new TextEncoder().encode(JSON.stringify(runtimeDataObj))
}

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

test.serial(
  "Azure TDX: end-to-end tunnel with aztdx binding mode",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    // Server returns quote with Azure-style runtime_data
    const getQuote = async (x25519PublicKey: Uint8Array): Promise<QuoteData> => {
      // Compute the user-data hash that would be in runtime_data
      // For this test, we use the sample nonce and the actual x25519 public key
      const userDataHash = await getAzureExpectedReportData(
        sampleNonce,
        x25519PublicKey,
      )
      const userDataHex = hex(userDataHash).toUpperCase()

      return {
        quote: azureQuote,
        verifier_data: {
          val: sampleNonce, // nonce
          iat: new Uint8Array(), // Not used in Azure binding
        },
        runtime_data: buildMockRuntimeData(userDataHex),
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    // Client uses aztdx mode to verify the Azure binding
    const quoteBody = parseTdxQuote(azureQuote).body
    const tunnelClient = await TunnelClient.initialize(origin, {
      measurements: {
        mrtd: hex(quoteBody.mr_td),
      },
      aztdx: true, // Enable Azure TDX binding mode
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
  "Azure TDX: binding fails when runtime_data user-data doesn't match",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    // Server returns quote with WRONG user-data hash (doesn't match x25519 key)
    const getQuote = async (_x25519PublicKey: Uint8Array): Promise<QuoteData> => {
      // Use a fake hash that won't match
      const fakeUserDataHex = "DEADBEEF".repeat(16) // 64 bytes of fake data

      return {
        quote: azureQuote,
        verifier_data: {
          val: sampleNonce,
          iat: new Uint8Array(),
        },
        runtime_data: buildMockRuntimeData(fakeUserDataHex),
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
      // Connection should fail due to binding mismatch
      // Use ensureConnection directly to catch the handshake error
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
    const getQuote = async (x25519PublicKey: Uint8Array): Promise<QuoteData> => {
      const userDataHash = await getAzureExpectedReportData(
        sampleNonce,
        x25519PublicKey,
      )
      const userDataHex = hex(userDataHash).toUpperCase()

      return {
        quote: azureQuote,
        // No verifier_data with nonce!
        runtime_data: buildMockRuntimeData(userDataHex),
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
  "Azure TDX: binding fails when runtime_data is malformed JSON",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    // Server returns quote with malformed runtime_data
    const getQuote = async (_x25519PublicKey: Uint8Array): Promise<QuoteData> => {
      return {
        quote: azureQuote,
        verifier_data: {
          val: sampleNonce,
          iat: new Uint8Array(),
        },
        runtime_data: new TextEncoder().encode("not valid json"),
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
          message: /failed to parse runtime_data as JSON/,
        },
      )
    } finally {
      await stopAzureTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "Azure TDX: binding fails when runtime_data missing user-data field",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    // Server returns quote with runtime_data missing user-data field
    const getQuote = async (_x25519PublicKey: Uint8Array): Promise<QuoteData> => {
      return {
        quote: azureQuote,
        verifier_data: {
          val: sampleNonce,
          iat: new Uint8Array(),
        },
        runtime_data: new TextEncoder().encode(
          JSON.stringify({ "other-field": "value" }),
        ),
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
          message: /runtime_data missing user-data field/,
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
