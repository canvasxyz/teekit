import fs from "node:fs"
import { exec, execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import os from "node:os"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { base64 } from "@scure/base"
import {
  tappdV4Base64,
  sevSnpGcpX25519Base64,
  sevSnpGcpVcekPem,
  sevSnpGcpAskPem,
  sevSnpGcpArkPem,
  sevSnpGcpX25519Nonce,
} from "@teekit/tunnel/samples"
import { toHex } from "./utils.js"
import type { IntelQuoteData, SevSnpQuoteData } from "@teekit/tunnel"

const CONFIG_PATH = "/etc/kettle/config.json"
const AZURE_NONCE_LENGTH = 32
const SEV_SNP_NONCE_LENGTH = 32
const SEV_SNP_DEVICE_PATH = "/dev/sev-guest"

// VCEK cache directory - persisted across restarts
const VCEK_CACHE_DIR = "/var/lib/kettle/vcek-cache"

// Retry configuration for VCEK fetch
const VCEK_FETCH_MAX_RETRIES = 5
const VCEK_FETCH_INITIAL_DELAY_MS = 1000
const VCEK_FETCH_MAX_DELAY_MS = 30000

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const SGX_SAMPLE_QUOTE_PATH = fileURLToPath(
  new URL("../../qvl/test/sampleQuotes/sgx-occlum.dat", import.meta.url),
)

let sgxSampleQuote: Uint8Array | null = null

function getSgxSampleQuote() {
  if (sgxSampleQuote) return sgxSampleQuote

  try {
    const data = fs.readFileSync(SGX_SAMPLE_QUOTE_PATH)
    sgxSampleQuote = new Uint8Array(data)
    return sgxSampleQuote
  } catch (error) {
    console.warn(
      `[kettle] Unable to load SGX sample quote at ${SGX_SAMPLE_QUOTE_PATH}:`,
      error,
    )
    return null
  }
}

function getBackoffDelay(attempt: number): number {
  const exponentialDelay = VCEK_FETCH_INITIAL_DELAY_MS * Math.pow(2, attempt)
  const cappedDelay = Math.min(exponentialDelay, VCEK_FETCH_MAX_DELAY_MS)
  // Add 10-30% jitter to prevent thundering herd
  const jitter = cappedDelay * (0.1 + Math.random() * 0.2)
  return Math.floor(cappedDelay + jitter)
}

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

/**
 * Detect TEE type by checking for hardware devices.
 * Returns "sev-snp" if /dev/sev-guest exists, otherwise "tdx".
 * Can be overridden by TEE_TYPE environment variable (supports "sgx").
 * Can be overridden by TEE_TYPE environment variable.
 */
export function detectTeeType(): "sev-snp" | "tdx" | "sgx" {
  // Allow explicit override via environment variable
  const envTeeType = process.env.TEE_TYPE?.toLowerCase()
  if (envTeeType) {
    if (
      envTeeType === "sev-snp" ||
      envTeeType === "sevsnp" ||
      envTeeType === "sev_snp"
    ) {
      return "sev-snp"
    }
    if (envTeeType === "tdx") {
      return "tdx"
    }
    if (envTeeType === "sgx") {
      return "sgx"
    }
  }

  // Auto-detect based on device presence
  if (fs.existsSync(SEV_SNP_DEVICE_PATH)) {
    return "sev-snp"
  }

  return "tdx"
}

/**
 * Parse the plain-text output from Azure trustauthority-cli.
 *
 * Format:
 *   Quote: <base64>
 *   runtime_data: <base64>
 *   user_data: <base64>
 */
function parseAzureCLIOutput(stdout: string): {
  quote: string
  runtimeData: string
  userData: string
} {
  const lines = stdout.trim().split("\n")
  let quote = ""
  let runtimeData = ""
  let userData = ""

  for (const line of lines) {
    if (line.startsWith("Quote: ")) {
      quote = line.slice("Quote: ".length).trim()
    } else if (line.startsWith("runtime_data: ")) {
      runtimeData = line.slice("runtime_data: ".length).trim()
    } else if (line.startsWith("user_data: ")) {
      userData = line.slice("user_data: ".length).trim()
    }
  }

  if (!quote) throw new Error("Missing Quote in Azure CLI output")
  if (!runtimeData) throw new Error("Missing runtime_data in Azure CLI output")
  // if (!userData) throw new Error("Missing user_data in Azure CLI output")

  return { quote, runtimeData, userData }
}

export interface VerifierData {
  iat: Uint8Array
  val: Uint8Array
  signature: Uint8Array
}

/**
 * Cached VCEK certificates - keyed by chip_id extracted from attestation report.
 * The VCEK is per-CPU and per-TCB, so it can be safely cached.
 */
interface VcekCache {
  vcek_cert: string
  ask_cert?: string
  ark_cert?: string
}

export class QuoteBinding {
  // In-memory VCEK cache (also persisted to disk)
  private vcekCache: Map<string, VcekCache> = new Map()

  // Mutex for VCEK fetch operations to prevent concurrent fetches
  private vcekFetchPromise: Promise<VcekCache> | null = null
  private vcekFetchKey: string | null = null

  constructor() {
    // Load cached VCEK from disk on startup
    this.loadVcekCache()
  }

  private loadVcekCache(): void {
    try {
      if (!fs.existsSync(VCEK_CACHE_DIR)) {
        return
      }

      const files = fs.readdirSync(VCEK_CACHE_DIR)
      for (const file of files) {
        if (file.endsWith(".json")) {
          const cacheKey = file.replace(".json", "")
          const cachePath = path.join(VCEK_CACHE_DIR, file)
          try {
            const data = JSON.parse(fs.readFileSync(cachePath, "utf-8"))
            this.vcekCache.set(cacheKey, data)
            console.log(`[kettle] Loaded cached VCEK for ${cacheKey}`)
          } catch {
            // Ignore corrupt cache files
          }
        }
      }
    } catch {
      // Ignore cache load errors
    }
  }

  private saveVcekCache(cacheKey: string, cache: VcekCache): void {
    try {
      if (!fs.existsSync(VCEK_CACHE_DIR)) {
        fs.mkdirSync(VCEK_CACHE_DIR, { recursive: true })
      }
      const cachePath = path.join(VCEK_CACHE_DIR, `${cacheKey}.json`)
      fs.writeFileSync(cachePath, JSON.stringify(cache))
      console.log(`[kettle] Saved VCEK to cache: ${cacheKey}`)
    } catch (err) {
      console.error("[kettle] Failed to save VCEK cache:", err)
    }
  }

  private getVcekCacheKey(attestationPath: string): string {
    // Read the attestation report and extract chip_id (bytes 416-479, 64 bytes)
    // and reported_tcb (bytes 384-391, 8 bytes)
    const report = fs.readFileSync(attestationPath)
    const chipId = report.subarray(416, 480)
    const reportedTcb = report.subarray(384, 392)
    return toHex(chipId) + "-" + toHex(reportedTcb)
  }

  /**
   * Fetch VCEK certificate with retry logic and exponential backoff.
   * Uses caching to avoid repeated fetches for the same chip.
   * Handles concurrent requests by deduplicating in-flight fetches.
   */
  private async fetchVcekWithRetry(
    attestationPath: string,
    certsDir: string,
  ): Promise<VcekCache> {
    const cacheKey = this.getVcekCacheKey(attestationPath)

    // Check in-memory cache first
    const cached = this.vcekCache.get(cacheKey)
    if (cached) {
      console.log(`[kettle] Using cached VCEK for chip: ${cacheKey.substring(0, 16)}...`)
      return cached
    }

    // If there's already a fetch in progress for this key, wait for it
    if (this.vcekFetchPromise && this.vcekFetchKey === cacheKey) {
      console.log(`[kettle] Waiting for in-flight VCEK fetch...`)
      return this.vcekFetchPromise
    }

    // Start a new fetch with retry logic
    this.vcekFetchKey = cacheKey
    this.vcekFetchPromise = this.doVcekFetchWithRetry(
      attestationPath,
      certsDir,
      cacheKey,
    )

    try {
      return await this.vcekFetchPromise
    } finally {
      this.vcekFetchPromise = null
      this.vcekFetchKey = null
    }
  }

  /**
   * Internal method that performs the actual VCEK fetch with retries
   */
  private async doVcekFetchWithRetry(
    attestationPath: string,
    certsDir: string,
    cacheKey: string,
  ): Promise<VcekCache> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < VCEK_FETCH_MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = getBackoffDelay(attempt - 1)
          console.log(
            `[kettle] Retrying VCEK fetch (attempt ${attempt + 1}/${VCEK_FETCH_MAX_RETRIES}) after ${delay}ms...`,
          )
          await sleep(delay)
        }

        await execFileAsync("snpguest", [
          "fetch",
          "vcek",
          "pem",
          certsDir,
          attestationPath,
        ])

        // Read VCEK certificate
        const vcekPath = path.join(certsDir, "vcek.pem")
        if (!fs.existsSync(vcekPath)) {
          throw new Error("VCEK certificate not found after fetch")
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

        const cache: VcekCache = { vcek_cert: vcekCert, ask_cert: askCert, ark_cert: arkCert }

        // Cache the result
        this.vcekCache.set(cacheKey, cache)
        this.saveVcekCache(cacheKey, cache)

        if (attempt > 0) {
          console.log(`[kettle] VCEK fetch succeeded on attempt ${attempt + 1}`)
        }

        return cache
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        const errorMsg = lastError.message

        // Check if this is a retryable error (5xx from AMD KDS)
        const isRetryable =
          errorMsg.includes("500") ||
          errorMsg.includes("502") ||
          errorMsg.includes("503") ||
          errorMsg.includes("504") ||
          errorMsg.includes("ETIMEDOUT") ||
          errorMsg.includes("ECONNRESET") ||
          errorMsg.includes("ECONNREFUSED")

        if (!isRetryable) {
          console.error(`[kettle] VCEK fetch failed with non-retryable error: ${errorMsg}`)
          break
        }

        console.warn(
          `[kettle] VCEK fetch attempt ${attempt + 1} failed: ${errorMsg}`,
        )
      }
    }

    throw new QuoteError(
      `Failed to fetch VCEK certificate after ${VCEK_FETCH_MAX_RETRIES} attempts: ${lastError?.message}`,
      "VCEK_FETCH_FAILED",
    )
  }

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

      // Fetch VCEK certificate from AMD KDS (with retry and caching)
      const vcekData = await this.fetchVcekWithRetry(attestationPath, certsDir)

      // Read attestation report
      const quote = new Uint8Array(fs.readFileSync(attestationPath))

      return {
        quote,
        vcek_cert: vcekData.vcek_cert,
        ask_cert: vcekData.ask_cert,
        ark_cert: vcekData.ark_cert,
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
   * Get TDX attestation quote using trustauthority-cli.
   * Binding format: report_data = SHA512(verifier_nonce.val || verifier_nonce.iat || runtime_data)
   */
  private async getTdxQuote(
    x25519PublicKey: Uint8Array,
  ): Promise<IntelQuoteData> {
     // CLOUD_PROVIDER is set by cloud-launcher from /etc/kettle/cloud-launcher.env
     const cloudProvider = process.env.CLOUD_PROVIDER || "gcp"

     if (cloudProvider !== "azure" && !fs.existsSync(CONFIG_PATH)) {
      throw new QuoteError(
        `TDX config.json not found at ${CONFIG_PATH}`,
        "CONFIG_MISSING",
      )
    }

    console.log("[kettle] Getting TDX quote for " + toHex(x25519PublicKey))

    const userDataB64 = base64.encode(x25519PublicKey)

    if (cloudProvider === "azure") {
      // Azure TDX vTPM attestation
      const nonce = randomBytes(AZURE_NONCE_LENGTH)
      const nonceB64 = base64.encode(new Uint8Array(nonce))

      try {
        const { stdout } = await execAsync(
          `trustauthority-cli quote --aztdx --nonce '${nonceB64}' --user-data '${userDataB64}'`
        )

        const azureOutput = parseAzureCLIOutput(stdout)
        return {
          quote: base64.decode(azureOutput.quote),
          verifier_data: {
            // Azure binding uses SHA512(nonce || x25519key) stored in runtime_data["user-data"]
            // The nonce is passed to the CLI and must be returned for client verification
            val: new Uint8Array(nonce),
            iat: new Uint8Array(), // Not used in Azure binding
            signature: new Uint8Array(), // Not used in Azure binding
          },
          runtime_data: base64.decode(azureOutput.runtimeData),
        }
      } catch (err) {
        throw new QuoteError(
          `Failed to parse Azure quote response: ${err instanceof Error ? err.message : String(err)}`,
          "QUOTE_FAILED",
        )
      }

    } else {
      // GCP/standard TDX attestation
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
  }

  async getQuote(
    x25519PublicKey: Uint8Array,
  ): Promise<IntelQuoteData | SevSnpQuoteData> {
    const teeType = detectTeeType()
    const isSevSnp = teeType === "sev-snp"
    const isSgx = teeType === "sgx"

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
      } else if (isSgx) {
        const quote = getSgxSampleQuote()
        if (!quote) {
          throw new QuoteError(
            "SGX sample quote not found; cannot run SGX tests",
            "QUOTE_FAILED",
          )
        }
        return { quote }
      } else {
        return { quote: base64.decode(tappdV4Base64) }
      }
    }

    if (isSevSnp) {
      console.log("[kettle] Using SEV-SNP attestation (detected /dev/sev-guest)")
      await this.ensureSnpGuestCliAvailable()
      return this.getSevSnpQuote(x25519PublicKey)
    }

    if (isSgx) {
      throw new QuoteError(
        "SGX attestation is not supported in this build; use kettle-sgx for production",
        "QUOTE_FAILED",
      )
    }

    console.log("[kettle] Using TDX attestation")
    await this.ensureTrustauthorityCliAvailable()
    return this.getTdxQuote(x25519PublicKey)
  }
}
