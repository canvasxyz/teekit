import fs from "node:fs"
import { exec, execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import os from "node:os"
import { promisify } from "node:util"

import { base64 } from "@scure/base"
import {
  tappdV4Base64,
  sevSnpGcpX25519Base64,
  sevSnpGcpVcekPem,
  sevSnpGcpAskPem,
  sevSnpGcpArkPem,
  sevSnpGcpX25519Nonce,
} from "@teekit/tunnel/samples"
import { parseAzureCLIOutput, toHex } from "./utils.js"
import type { IntelQuoteData, SevSnpQuoteData } from "@teekit/tunnel"

const CONFIG_PATH = "/etc/kettle/config.json"
const AZURE_NONCE_LENGTH = 32
const SEV_SNP_NONCE_LENGTH = 32

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

export class QuoteError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "CONFIG_MISSING"
      | "QUOTE_FAILED"
      | "INTEL_CLI_MISSING"
      | "SNPGUEST_MISSING"
      | "VCEK_FETCH_FAILED",
  ) {
    super(message)
    this.name = "QuoteError"
  }
}

export class QuoteBinding {
  /**
   * Get SEV-SNP attestation report and certificates using snpguest.
   * SEV-SNP binding uses SHA512(nonce || x25519PublicKey) as the report_data.
   */
  private async getSevSnpQuote(
    x25519PublicKey: Uint8Array,
  ): Promise<SevSnpQuoteData> {
    const nonce = randomBytes(SEV_SNP_NONCE_LENGTH)

    // Compute report_data = SHA512(nonce || x25519PublicKey)
    // This binds the attestation to the server's ephemeral key
    const hash = createHash("sha512")
    hash.update(nonce)
    hash.update(x25519PublicKey)
    const reportData = hash.digest()

    console.log(
      `[kettle] Getting SEV-SNP quote for x25519 key: ${toHex(x25519PublicKey)}`,
    )

    // Create temporary directory for snpguest files
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kettle-sevsnp-"))
    const reportDataPath = path.join(tmpDir, "report-data.bin")
    const attestationPath = path.join(tmpDir, "attestation.bin")
    const certsDir = path.join(tmpDir, "certs")

    try {
      // Write report_data to file (64 bytes for SEV-SNP)
      fs.writeFileSync(reportDataPath, reportData)
      fs.mkdirSync(certsDir)

      // Get attestation report using snpguest
      // snpguest report <output_file> <report_data_file>
      try {
        await execFileAsync("snpguest", [
          "report",
          attestationPath,
          reportDataPath,
        ])
      } catch (err) {
        throw new QuoteError(
          `Failed to get SEV-SNP attestation report: ${err instanceof Error ? err.message : String(err)}`,
          "QUOTE_FAILED",
        )
      }

      // Fetch VCEK certificate from AMD KDS
      // snpguest fetch vcek <encoding> <certs_dir> <attestation_report>
      try {
        await execFileAsync("snpguest", [
          "fetch",
          "vcek",
          "pem",
          certsDir,
          attestationPath,
        ])
      } catch (err) {
        throw new QuoteError(
          `Failed to fetch VCEK certificate: ${err instanceof Error ? err.message : String(err)}`,
          "VCEK_FETCH_FAILED",
        )
      }

      // Read attestation report
      const quote = new Uint8Array(fs.readFileSync(attestationPath))

      // Read VCEK certificate
      const vcekPath = path.join(certsDir, "vcek.pem")
      if (!fs.existsSync(vcekPath)) {
        throw new QuoteError(
          "VCEK certificate not found after fetch",
          "VCEK_FETCH_FAILED",
        )
      }
      const vcekCert = fs.readFileSync(vcekPath, "utf-8")

      // Try to read ASK and ARK certificates if available
      let askCert: string | undefined
      let arkCert: string | undefined

      const askPath = path.join(certsDir, "ask.pem")
      const arkPath = path.join(certsDir, "ark.pem")

      if (fs.existsSync(askPath)) {
        askCert = fs.readFileSync(askPath, "utf-8")
      }
      if (fs.existsSync(arkPath)) {
        arkCert = fs.readFileSync(arkPath, "utf-8")
      }

      // If ASK/ARK not found, try to fetch the certificate chain
      // snpguest fetch ca <encoding> <certs_dir>

      // Currently disabled because quote validation has default (Milan) certificates

      // if (!askCert || !arkCert) {
      //   try {
      //     await execFileAsync("snpguest", ["fetch", "ca", "pem", certsDir])
      //     if (fs.existsSync(askPath)) {
      //       askCert = fs.readFileSync(askPath, "utf-8")
      //     }
      //     if (fs.existsSync(arkPath)) {
      //       arkCert = fs.readFileSync(arkPath, "utf-8")
      //     }
      //   } catch {
      //     // CA fetch is optional - the client can use embedded AMD root certs
      //     console.log(
      //       "[kettle] Could not fetch AMD CA certificates, client will use embedded roots",
      //     )
      //   }
      // }

      return {
        quote,
        vcek_cert: vcekCert,
        ask_cert: askCert,
        ark_cert: arkCert,
        nonce: new Uint8Array(nonce),
      }
    } catch (err) {
      if (err instanceof QuoteError) {
        throw err
      }
      throw new QuoteError(
        `Failed to get SEV-SNP attestation: ${err instanceof Error ? err.message : String(err)}`,
        "QUOTE_FAILED",
      )
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch (err) {
        // Ignore cleanup errors
        console.error("[kettle] Cleanup error:", err)
      }
    }
  }

  private async ensureTrustauthorityCliAvailable(): Promise<void> {
    try {
      await execFileAsync("which", ["trustauthority-cli"])
    } catch {
      throw new QuoteError("trustauthority-cli not found", "INTEL_CLI_MISSING")
    }
  }

  private async ensureSnpGuestCliAvailable(): Promise<void> {
    try {
      await execFileAsync("which", ["snpguest"])
    } catch {
      throw new QuoteError(
        "snpguest not found. Install snpguest for SEV-SNP attestation.",
        "SNPGUEST_MISSING",
      )
    }
  }

  /**
   * Get Azure TDX attestation quote using trustauthority-cli. Binding format:
   * - report_data[0:32] = SHA256(runtime_data JSON)
   * - runtime_data["user-data"] = base64(x25519PublicKey)
   * - runtime_data["nonce"] = base64(nonce)
   */
  private async getAzureTdxQuote(
    x25519PublicKey: Uint8Array,
  ): Promise<IntelQuoteData> {
    console.log(
      "[kettle] Getting Azure TDX quote for " + toHex(x25519PublicKey),
    )

    const userDataB64 = base64.encode(x25519PublicKey)
    const nonce = randomBytes(AZURE_NONCE_LENGTH)
    const nonceB64 = base64.encode(new Uint8Array(nonce))

    try {
      const { stdout } = await execAsync(
        `trustauthority-cli quote --aztdx --nonce '${nonceB64}' --user-data '${userDataB64}'`,
      )

      const azureOutput = parseAzureCLIOutput(stdout)
      return {
        quote: base64.decode(azureOutput.quote),
        verifier_data: {
          // The nonce is returned so the client can verify it matches what's in runtime_data
          val: new Uint8Array(nonce),
          iat: new Uint8Array(), // Not used in Azure binding
          signature: new Uint8Array(), // Not used in Azure binding
        },
        runtime_data: base64.decode(azureOutput.runtimeData),
      }
    } catch (err) {
      throw new QuoteError(
        `Failed to get Azure TDX quote: ${err instanceof Error ? err.message : String(err)}`,
        "QUOTE_FAILED",
      )
    }
  }

  /**
   * Get GCP TDX attestation quote using trustauthority-cli.
   * Binding format: report_data = SHA512(verifier_nonce.val || verifier_nonce.iat || runtime_data)
   */
  private async getGcpTdxQuote(
    x25519PublicKey: Uint8Array,
  ): Promise<IntelQuoteData> {
    if (!fs.existsSync(CONFIG_PATH)) {
      throw new QuoteError(
        `TDX config.json not found at ${CONFIG_PATH}`,
        "CONFIG_MISSING",
      )
    }

    console.log("[kettle] Getting TDX quote for " + toHex(x25519PublicKey))

    const userDataB64 = base64.encode(x25519PublicKey)

    try {
      const { stdout } = await execAsync(
        `trustauthority-cli evidence --tdx --user-data '${userDataB64}' -c ${CONFIG_PATH}`,
      )

      const response = JSON.parse(stdout)
      return {
        quote: base64.decode(response.tdx.quote),
        verifier_data: {
          iat: base64.decode(response.tdx.verifier_nonce.iat),
          val: base64.decode(response.tdx.verifier_nonce.val),
          signature: base64.decode(response.tdx.verifier_nonce.signature),
        },
        runtime_data: base64.decode(response.tdx.runtime_data),
      }
    } catch (err) {
      throw new QuoteError(
        `Failed to get TDX quote: ${err instanceof Error ? err.message : String(err)}`,
        "QUOTE_FAILED",
      )
    }
  }

  async getQuote(
    x25519PublicKey: Uint8Array,
  ): Promise<IntelQuoteData | SevSnpQuoteData> {
    const teeType = (process.env.TEE_TYPE || "tdx").toLowerCase()
    const isSevSnp =
      teeType === "sev-snp" || teeType === "sevsnp" || teeType === "sev_snp"

    // When testing, bypass hardware/CLI, and serve a bundled sample quote
    if (
      typeof process !== "undefined" &&
      (process.env.KETTLE_TESTING === "1" || process.env.NODE_ENV === "test")
    ) {
      if (isSevSnp) {
        const nonceBytes = new Uint8Array(
          sevSnpGcpX25519Nonce
            .match(/.{1,2}/g)!
            .map((byte) => parseInt(byte, 16)),
        )
        return {
          quote: base64.decode(sevSnpGcpX25519Base64),
          vcek_cert: sevSnpGcpVcekPem,
          ask_cert: sevSnpGcpAskPem,
          ark_cert: sevSnpGcpArkPem,
          nonce: nonceBytes,
        }
      } else {
        return { quote: base64.decode(tappdV4Base64) }
      }
    }

    if (isSevSnp) {
      console.log("[kettle] Using SEV-SNP attestation")
      await this.ensureSnpGuestCliAvailable()
      return this.getSevSnpQuote(x25519PublicKey)
    } else if (process.env.CLOUD_PROVIDER === "azure") {
      console.log("[kettle] Using Azure TDX attestation")
      await this.ensureTrustauthorityCliAvailable()
      return this.getAzureTdxQuote(x25519PublicKey)
    } else {
      console.log("[kettle] Using TDX attestation")
      await this.ensureTrustauthorityCliAvailable()
      return this.getGcpTdxQuote(x25519PublicKey)
    }
  }
}
