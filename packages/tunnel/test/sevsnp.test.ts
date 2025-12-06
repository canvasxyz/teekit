import test from "ava"
import express from "express"
import type { AddressInfo } from "node:net"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { TunnelClient, TunnelServer, SevSnpQuoteData } from "@teekit/tunnel"
import { hex, parseSevSnpReport } from "@teekit/qvl"
import { parseSevSnpCertChain, stopSevSnpTunnel } from "./helpers/helpers.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = path.join(__dirname, "../../qvl/test/sampleQuotes")

// Load SEV-SNP sample quote and certificates (without X25519 binding)
const SAMPLE_PATH = path.join(BASE, "sev-gcp-reportdata.bin")
const VCEK_CERT_PATH = path.join(BASE, "sev-gcp-vcek.pem")
const CERT_CHAIN_PATH = path.join(BASE, "sev-gcp-cert-chain.pem")
const sampleReport = new Uint8Array(fs.readFileSync(SAMPLE_PATH))
const vcekPem = fs.readFileSync(VCEK_CERT_PATH, "utf-8")
const certChainPem = fs.readFileSync(CERT_CHAIN_PATH, "utf-8")
const { askPem, arkPem } = parseSevSnpCertChain(certChainPem)

// Load SEV-SNP sample quote and certificates (with X25519 binding)
const X25519_BOUND_PATH = path.join(BASE, "sev-gcp-x25519-bound.bin")
const X25519_VCEK_CERT_PATH = path.join(BASE, "sev-gcp-x25519-vcek.pem")
const X25519_CERT_CHAIN_PATH = path.join(BASE, "sev-gcp-x25519-cert-chain.pem")
const BOUND_NONCE =
  "df82306ff38a9da023854af947d02a878cfab1b40a793823ff41dc51213b96aa"
const BOUND_X25519_KEY =
  "03a8107030fabeac06b0df4ef865763918b5e2a9fa030e20025a4315dab4b2a6"
const x25519BoundReport = new Uint8Array(fs.readFileSync(X25519_BOUND_PATH))
const x25519VcekPem = fs.readFileSync(X25519_VCEK_CERT_PATH, "utf-8")
const x25519CertChainPem = fs.readFileSync(X25519_CERT_CHAIN_PATH, "utf-8")

// Expected measurement from the sample
const EXPECTED_MEASUREMENT =
  "b747d55452e0b9e9079770a49e397c5e6d9573581e246da7baac4f28b5cdc5b1b6d19251b8ee600fd16a3708f58406f3"

test.serial(
  "SEV-SNP: client verifies quote signature and chain with empty x25519Binding",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    // Use a nonce that we can verify was passed correctly
    const testNonce = new Uint8Array(32)
    crypto.getRandomValues(testNonce)

    const getQuote = async (
      _x25519PublicKey: Uint8Array,
    ): Promise<SevSnpQuoteData> => {
      return {
        quote: sampleReport,
        vcek_cert: vcekPem,
        ask_cert: askPem,
        ark_cert: arkPem,
        nonce: testNonce,
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    const tunnelClient = await TunnelClient.initialize(origin, {
      sevsnp: true,
      measurements: {
        measurement: EXPECTED_MEASUREMENT,
      },
      // Custom x25519Binding that skips the hash check for sample data
      // In production, the default binding should be used with properly
      // generated quotes that include SHA512(nonce || x25519key)
      x25519Binding: async (client) => {
        // Verify we received the certificates
        t.truthy(client.reportBindingData?.vcekCert)
        t.truthy(client.reportBindingData?.askCert)
        t.truthy(client.reportBindingData?.arkCert)
        // Verify nonce was passed (for SEV-SNP, verifierData is a plain Uint8Array)
        const verifierData = client.reportBindingData?.verifierData
        t.truthy(verifierData)
        t.true(verifierData instanceof Uint8Array)
        // Accept binding (bypassing report_data check for sample data)
        return true
      },
    })

    try {
      // Make a request through the tunnel
      const response = await tunnelClient.fetch(`${origin}/hello`)
      t.is(response.status, 200)
      t.is(await response.text(), "world")

      // Verify the SEV-SNP report was stored
      t.truthy(tunnelClient.sevsnpReport)
      t.is(
        hex(tunnelClient.sevsnpReport!.body.measurement),
        EXPECTED_MEASUREMENT,
      )
    } finally {
      await stopSevSnpTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "SEV-SNP: binding fails when measurement doesn't match",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    const getQuote = async (
      _x25519PublicKey: Uint8Array,
    ): Promise<SevSnpQuoteData> => {
      return {
        quote: sampleReport,
        vcek_cert: vcekPem,
        ask_cert: askPem,
        ark_cert: arkPem,
        nonce: new Uint8Array(32),
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    // Wrong measurement
    const wrongMeasurement =
      "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

    const tunnelClient = await TunnelClient.initialize(origin, {
      sevsnp: true,
      measurements: {
        measurement: wrongMeasurement,
      },
    })

    try {
      await t.throwsAsync(
        async () => {
          await tunnelClient.fetch(`${origin}/hello`)
        },
        {
          message: /measurement verification failed/i,
        },
      )
    } finally {
      await stopSevSnpTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "SEV-SNP: binding fails when VCEK certificate is missing",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    // Return TDX-style quote data without VCEK cert
    const getQuote = async (_x25519PublicKey: Uint8Array) => {
      return {
        quote: sampleReport,
        // No vcek_cert!
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    const tunnelClient = await TunnelClient.initialize(origin, {
      sevsnp: true,
      measurements: {
        measurement: EXPECTED_MEASUREMENT,
      },
    })

    try {
      await t.throwsAsync(
        async () => {
          await tunnelClient.fetch(`${origin}/hello`)
        },
        {
          message: /SEV-SNP mode requires vcek_cert/i,
        },
      )
    } finally {
      await stopSevSnpTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial("SEV-SNP: custom verification callback is called", async (t) => {
  const app = express()
  app.get("/hello", (_req, res) => res.status(200).send("world"))

  const getQuote = async (
    _x25519PublicKey: Uint8Array,
  ): Promise<SevSnpQuoteData> => {
    return {
      quote: sampleReport,
      vcek_cert: vcekPem,
      ask_cert: askPem,
      ark_cert: arkPem,
      nonce: new Uint8Array(32),
    }
  }

  const tunnelServer = await TunnelServer.initialize(app, getQuote)
  await new Promise<void>((resolve) => {
    tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
  })
  const address = tunnelServer.server!.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`

  let customVerifyCalled = false

  const tunnelClient = await TunnelClient.initialize(origin, {
    sevsnp: true,
    customVerifyQuote: (quote) => {
      customVerifyCalled = true
      // Verify report has expected fields (cast to SevSnpReport for SEV-SNP mode)
      const report = quote as import("@teekit/qvl").SevSnpReport
      t.truthy(report.body)
      t.truthy(report.body.measurement)
      t.is(report.body.version, 5)
      return true
    },
    x25519Binding: async () => true, // Bypass binding check for sample data
  })

  try {
    const response = await tunnelClient.fetch(`${origin}/hello`)
    t.is(response.status, 200)
    t.true(customVerifyCalled, "Custom verification callback should be called")
  } finally {
    await stopSevSnpTunnel(tunnelServer, tunnelClient)
  }
})

test.serial(
  "SEV-SNP: custom verification callback can reject quote",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    const getQuote = async (
      _x25519PublicKey: Uint8Array,
    ): Promise<SevSnpQuoteData> => {
      return {
        quote: sampleReport,
        vcek_cert: vcekPem,
        ask_cert: askPem,
        ark_cert: arkPem,
        nonce: new Uint8Array(32),
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    const tunnelClient = await TunnelClient.initialize(origin, {
      sevsnp: true,
      customVerifyQuote: () => {
        // Reject the quote
        return false
      },
    })

    try {
      await t.throwsAsync(
        async () => {
          await tunnelClient.fetch(`${origin}/hello`)
        },
        {
          message: /custom quote validation failed/i,
        },
      )
    } finally {
      await stopSevSnpTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "SEV-SNP: TunnelClient can be initialized with allowDebug, allowing reports with debug bit",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    const getQuote = async (
      _x25519PublicKey: Uint8Array,
    ): Promise<SevSnpQuoteData> => {
      return {
        quote: sampleReport,
        vcek_cert: vcekPem,
        ask_cert: askPem,
        ark_cert: arkPem,
        nonce: new Uint8Array(32),
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    // The sample report has debug disabled, so this should still pass
    const tunnelClient = await TunnelClient.initialize(origin, {
      sevsnp: true,
      measurements: {
        measurement: EXPECTED_MEASUREMENT,
      },
      sevsnpVerifyConfig: {
        allowDebug: true, // Allow debug even if enabled (sample has debug=false)
        maxVmpl: 3, // Allow any VMPL level
      },
      x25519Binding: async () => true, // Bypass binding check for sample data
    })

    try {
      const response = await tunnelClient.fetch(`${origin}/hello`)
      t.is(response.status, 200)
      t.is(await response.text(), "world")
    } finally {
      await stopSevSnpTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "SEV-SNP: end-to-end tunnel with full x25519 binding",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    const { askPem: x25519AskPem, arkPem: x25519ArkPem } =
      parseSevSnpCertChain(x25519CertChainPem)

    // The sample was generated with BOUND_NONCE and BOUND_X25519_KEY
    // The server will return this pre-computed quote, and we need to
    // override the x25519 binding to use the known key instead of the
    // dynamically generated one
    const boundNonceBytes = new Uint8Array(
      BOUND_NONCE.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    )
    const boundX25519KeyBytes = new Uint8Array(
      BOUND_X25519_KEY.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    )

    const getQuote = async (
      _x25519PublicKey: Uint8Array,
    ): Promise<SevSnpQuoteData> => {
      // Return the pre-computed quote with binding to BOUND_X25519_KEY
      return {
        quote: x25519BoundReport,
        vcek_cert: x25519VcekPem,
        ask_cert: x25519AskPem,
        ark_cert: x25519ArkPem,
        nonce: boundNonceBytes,
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    // Get the expected measurement from the X25519-bound report
    const parsedReport = parseSevSnpReport(x25519BoundReport)
    const expectedMeasurement = hex(parsedReport.body.measurement)

    const tunnelClient = await TunnelClient.initialize(origin, {
      sevsnp: true,
      measurements: {
        measurement: expectedMeasurement,
      },
      // Custom binding that uses the known X25519 key from the sample
      // instead of the dynamically generated one
      x25519Binding: async (client) => {
        const verifierData = client.reportBindingData?.verifierData
        if (!verifierData) {
          throw new Error("missing nonce for SEV-SNP binding")
        }
        // For SEV-SNP, verifierData is a plain Uint8Array nonce
        const nonce =
          verifierData instanceof Uint8Array ? verifierData : verifierData.val
        if (!nonce) {
          throw new Error("missing nonce for SEV-SNP binding")
        }

        // Compute expected report_data: SHA512(nonce || known_x25519key)
        const combined = new Uint8Array(
          nonce.length + boundX25519KeyBytes.length,
        )
        combined.set(nonce, 0)
        combined.set(boundX25519KeyBytes, nonce.length)

        const expectedHash = await crypto.subtle.digest("SHA-512", combined)
        const expectedBytes = new Uint8Array(expectedHash)

        // Parse the report to get report_data (sevsnpReport isn't stored until after binding check)
        const parsedForBinding = parseSevSnpReport(x25519BoundReport)
        const reportData = parsedForBinding.body.report_data
        if (expectedBytes.length !== reportData.length) {
          return false
        }

        for (let i = 0; i < expectedBytes.length; i++) {
          if (expectedBytes[i] !== reportData[i]) {
            return false
          }
        }

        return true
      },
    })

    try {
      // Make a request through the tunnel
      const response = await tunnelClient.fetch(`${origin}/hello`)
      t.is(response.status, 200)
      t.is(await response.text(), "world")

      // Verify the SEV-SNP report was stored
      t.truthy(tunnelClient.sevsnpReport)
      t.is(
        hex(tunnelClient.sevsnpReport!.body.measurement),
        expectedMeasurement,
      )

      // Verify report_data matches the expected binding
      const expectedReportData =
        "3a6753fd4b194de53824d7fd5b45e251cc19a32a71dd5ba3e131fe19f2adbe86d658c147479571226e0f294eb7e44abb6c1673f39a5378ac25cd5d6268b91f1a"
      t.is(
        hex(tunnelClient.sevsnpReport!.body.report_data),
        expectedReportData,
        "report_data should match SHA512(nonce || x25519key)",
      )
    } finally {
      await stopSevSnpTunnel(tunnelServer, tunnelClient)
    }
  },
)

test.serial(
  "SEV-SNP: binding fails when x25519 key doesn't match report_data",
  async (t) => {
    const app = express()
    app.get("/hello", (_req, res) => res.status(200).send("world"))

    const { askPem: x25519AskPem, arkPem: x25519ArkPem } =
      parseSevSnpCertChain(x25519CertChainPem)

    // Use a different nonce than what the quote was generated with
    const wrongNonce = new Uint8Array(32)
    crypto.getRandomValues(wrongNonce)

    const getQuote = async (
      _x25519PublicKey: Uint8Array,
    ): Promise<SevSnpQuoteData> => {
      return {
        quote: x25519BoundReport,
        vcek_cert: x25519VcekPem,
        ask_cert: x25519AskPem,
        ark_cert: x25519ArkPem,
        nonce: wrongNonce, // Wrong nonce!
      }
    }

    const tunnelServer = await TunnelServer.initialize(app, getQuote)
    await new Promise<void>((resolve) => {
      tunnelServer.server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = tunnelServer.server!.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`

    const parsedReport = parseSevSnpReport(x25519BoundReport)
    const expectedMeasurement = hex(parsedReport.body.measurement)

    const tunnelClient = await TunnelClient.initialize(origin, {
      sevsnp: true,
      measurements: {
        measurement: expectedMeasurement,
      },
      // Don't override x25519Binding - let the default binding check fail
      // because the nonce doesn't match
    })

    try {
      await t.throwsAsync(
        async () => {
          await tunnelClient.fetch(`${origin}/hello`)
        },
        {
          message: /SEV-SNP binding failed/i,
        },
      )
    } finally {
      await stopSevSnpTunnel(tunnelServer, tunnelClient)
    }
  },
)
