#!/usr/bin/env node
/**
 * Test script to verify VM deployment using TunnelClient
 *
 * Automatically detects and tests TDX, SEV-SNP, or SGX attestation.
 *
 * Usage:
 *   node scripts/test_tunnel.js <ip-address>
 *   PORT=3002 node scripts/test_tunnel.js 35.1.2.3
 */

import { TunnelClient } from "@teekit/tunnel"

const TIMEOUT_MS = 30000
const PORT = process.env.PORT || 3001

async function main() {
  const args = process.argv.slice(2)

  if (args.length < 1) {
    console.error("Usage: node scripts/test_tunnel.js <ip-address>")
    console.error("")
    console.error("Arguments:")
    console.error("  ip-address         IP address of the deployed VM")
    console.error("")
    console.error("Environment variables:")
    console.error("  PORT               Port to connect to (default: 3001)")
    console.error("")
    console.error("Examples:")
    console.error("  node scripts/test_tunnel.js 35.1.2.3")
    console.error("  PORT=3002 node scripts/test_tunnel.js 35.1.2.3")
    process.exit(1)
  }

  const ipAddress = args[0]
  const origin = `http://${ipAddress}:${PORT}`

  console.log("Testing VM deployment with TunnelClient")
  console.log("========================================")
  console.log(`IP Address: ${ipAddress}`)
  console.log(`Port: ${PORT}`)
  console.log(`Origin: ${origin}`)
  console.log("")
  console.log("Detecting TEE type and establishing connection...")
  console.log("")

  // Create timeout promise
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Connection timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
  })

  // Try connecting with different TEE configurations
  const teeConfigs = [
    {
      name: "TDX",
      config: {
        customVerifyQuote: () => true,
        x25519Binding: () => true
      }
    },
    {
      name: "SEV-SNP",
      config: {
        sevsnp: true,
        customVerifyQuote: () => true,
        x25519Binding: () => true
      }
    },
    {
      name: "SGX",
      config: {
        sgx: true,
        allowDebugEnclaves: true,
        customVerifyQuote: () => true,
        x25519Binding: () => true
      }
    }
  ]

  let tunnelClient = null
  let detectedTEE = null

  for (const { name, config } of teeConfigs) {
    try {
      console.log(`Trying ${name}...`)
      const client = await Promise.race([
        TunnelClient.initialize(origin, config),
        timeoutPromise
      ])

      // Actually establish the connection to verify the quote type is correct
      await Promise.race([
        client.ensureConnection(),
        timeoutPromise
      ])

      tunnelClient = client
      detectedTEE = name
      console.log(`  ✓ Successfully connected using ${name}`)
      break
    } catch (error) {
      console.log(`  ✗ ${error.message}`)
    }
  }

  if (!tunnelClient) {
    console.error("")
    console.error("========================================")
    console.error("✗ Failed to connect with any TEE type!")
    console.error("")
    console.error("Troubleshooting:")
    console.error("  1. Verify the VM is running and accessible")
    console.error("  2. Check that port " + PORT + " is open in firewall rules")
    console.error("  3. Ensure the kettle service is running on the VM")
    console.error("  4. View VM logs with: gcloud compute instances tail-serial-port-output <vm-name>")
    process.exit(1)
  }

  try {

    // Query /uptime endpoint
    console.log("Querying /uptime endpoint...")
    const response = await Promise.race([
      tunnelClient.fetch(`${origin}/uptime`),
      timeoutPromise
    ])

    if (!response.ok) {
      console.error(`✗ HTTP error: ${response.status} ${response.statusText}`)
      tunnelClient.close()
      process.exit(1)
    }

    const data = await response.json()
    console.log("✓ Received uptime response:")
    console.log(JSON.stringify(data, null, 2))

    // Close the tunnel
    tunnelClient.close()

    console.log("")
    console.log("========================================")
    console.log("✓ Test completed successfully!")
    console.log("")
    console.log(`TEE Type: ${detectedTEE}`)
    process.exit(0)

  } catch (error) {
    if (tunnelClient) {
      tunnelClient.close()
    }

    console.error("")
    console.error("========================================")
    console.error("✗ Test failed!")
    console.error("")

    if (error instanceof Error) {
      console.error(`Error: ${error.message}`)
      if (error.stack) {
        console.error("")
        console.error("Stack trace:")
        console.error(error.stack)
      }
    } else {
      console.error(`Error: ${error}`)
    }

    console.error("")
    console.error("Troubleshooting:")
    console.error("  1. Verify the VM is running and accessible")
    console.error("  2. Check that port " + PORT + " is open in firewall rules")
    console.error("  3. Ensure the kettle service is running on the VM")
    console.error("  4. View VM logs with: gcloud compute instances tail-serial-port-output <vm-name>")

    process.exit(1)
  }
}

main()
