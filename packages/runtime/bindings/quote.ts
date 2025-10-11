/**
 * Custom workerd binding for getQuote()
 * This module provides the getQuote functionality as a workerd binding,
 * allowing access to Node.js APIs (fs, child_process) that aren't available
 * in the workerd runtime.
 */

import fs from "node:fs"
import { exec } from "node:child_process"
import { base64 } from "@scure/base"
import { hex } from "@teekit/qvl"

export interface VerifierData {
  iat: Uint8Array
  val: Uint8Array
  signature: Uint8Array
}

export interface QuoteData {
  quote: Uint8Array
  verifier_data?: VerifierData
  runtime_data?: Uint8Array
}

export class QuoteBinding {
  async getQuote(x25519PublicKey: Uint8Array): Promise<QuoteData> {
    return await new Promise<QuoteData>(async (resolve, reject) => {
      // If config.json isn't set up, return a sample quote
      if (!fs.existsSync("config.json")) {
        console.log(
          "[teekit-runtime] TDX config.json not found, serving sample quote",
        )
        const { tappdV4Base64 } = await import("../shared/samples.js")
        resolve({
          quote: base64.decode(tappdV4Base64),
        })
        return
      }

      // Otherwise, get a quote from the SEAM (requires root)
      console.log(
        "[teekit-runtime] Getting a quote for " + hex(x25519PublicKey),
      )
      const userDataB64 = base64.encode(x25519PublicKey)
      const cmd = `trustauthority-cli evidence --tdx --user-data '${userDataB64}' -c config.json`
      exec(cmd, (err, stdout) => {
        if (err) {
          return reject(err)
        }

        try {
          const response = JSON.parse(stdout)
          resolve({
            quote: base64.decode(response.tdx.quote),
            verifier_data: {
              iat: base64.decode(response.tdx.verifier_nonce.iat),
              val: base64.decode(response.tdx.verifier_nonce.val),
              signature: base64.decode(response.tdx.verifier_nonce.signature),
            },
            runtime_data: base64.decode(response.tdx.runtime_data),
          })
        } catch (err) {
          reject(err)
        }
      })
    })
  }
}

// Export a singleton instance for workerd to use
export default new QuoteBinding()
