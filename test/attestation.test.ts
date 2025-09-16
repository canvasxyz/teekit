import test from "ava"
import fs from "node:fs"

import {
  parseTdxQuote,
  parseTdxQuoteBase64,
  hex,
  reverseHexBytes,
  verifyTdxV4Signature,
  extractPemCertificates,
  verifyProvisioningCertificationChain,
  isPinnedRootCertificate,
  verifyQeReportSignature,
  // verifyQeReportBinding,
} from "../qvl"
import jwt from "jsonwebtoken"
import { X509Certificate } from "node:crypto"

test.serial("Parse a V4 TDX quote from Tappd, hex format", async (t) => {
  const quoteHex = fs.readFileSync("test/sample/tdx-v4-tappd.hex", "utf-8")
  const quote = Buffer.from(quoteHex.replace(/^0x/, ""), "hex")

  const { header, body, signature } = parseTdxQuote(quote)
  const expectedMRTD =
    "c68518a0ebb42136c12b2275164f8c72f25fa9a34392228687ed6e9caeb9c0f1dbd895e9cf475121c029dc47e70e91fd"
  const expectedReportData =
    "7668c6b4eafb62301c72714ecc7d90ce9a0e04b52dc117720df2047b0a59f1dbd937243eef1410a3cdc524aad66d4554b4f18b54da2fc0608dac40d6dea5f1d4"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.true(verifyTdxV4Signature(quote))
})

test.serial("Parse a V4 TDX quote from Edgeless, bin format", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-edgeless.bin")

  const { header, body, signature } = parseTdxQuote(quote)
  const expectedMRTD =
    "b65ea009e424e6f761fdd3d7c8962439453b37ecdf62da04f7bc5d327686bb8bafc8a5d24a9c31cee60e4aba87c2f71b"
  const expectedReportData =
    "48656c6c6f2066726f6d20456467656c6573732053797374656d7321000000000000000000000000000000000000000000000000000000000000000000000000"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.true(verifyTdxV4Signature(quote))
})

test.serial("Parse a V4 TDX quote from Azure vTPM, bin format, extract certs", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-azure-vtpm.bin")

  const { header, body, signature } = parseTdxQuote(quote)

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.true(verifyTdxV4Signature(quote))
  t.truthy(signature.cert_data)
  const pems = extractPemCertificates(signature.cert_data!)
  t.is(pems.length, 3)
})

test.serial("Parse a V4 TDX quote from Phala, bin format", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-phala.bin")

  const { header, body, signature } = parseTdxQuote(quote)
  const expectedMRTD =
    "91eb2b44d141d4ece09f0c75c2c53d247a3c68edd7fafe8a3520c942a604a407de03ae6dc5f87f27428b2538873118b7"
  const expectedReportData =
    "9a9d48e7f6799642d3d1b34e1e5e1742d4bb02dd6ddd551862c1211d35c304f9eca3efdbb481601c163cf52493d6e44aed55d51ec39b7e518fadb92c2b523f20"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.true(verifyTdxV4Signature(quote))
})

test.serial("Parse a V4 TDX quote from Phala, hex format", async (t) => {
  const quoteHex = fs.readFileSync("test/sample/tdx-v4-phala.hex", "utf-8")
  const quote = Buffer.from(quoteHex.replace(/^0x/, ""), "hex")

  const { header, body, signature } = parseTdxQuote(quote)
  const expectedMRTD =
    "7ba9e262ce6979087e34632603f354dd8f8a870f5947d116af8114db6c9d0d74c48bec4280e5b4f4a37025a10905bb29"
  const expectedReportData =
    "7148f47ef58b475fce69b386e2d6b4c964a9533cc328ea8e544db66612a5174698d006951cefa8fd4450e884300638e567e22f9a012ef5754aa6a9d9564fcd8a"

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.true(verifyTdxV4Signature(quote))
})

test.serial("Parse a V4 TDX quote from MoeMahhouk", async (t) => {
  const quote = fs.readFileSync("test/sample/tdx-v4-moemahhouk.bin")

  const { header, body, signature } = parseTdxQuote(quote)
  // See: https://github.com/MoeMahhouk/tdx-quote-parser
  const expectedMRTD = reverseHexBytes(
    "18bcec2014a3ff000c46191e960ca4fe949f9adb2d8da557dbacee87f6ef7e2411fd5f09dc2b834506959bf69626ddf2",
  )
  const expectedReportData = reverseHexBytes(
    "007945c010980ecf9e0c0daf6dc971bffce0eaab6d4e4b592d4c08bac29c234068adb241fa02c2ef9e443daecd91d450739c601321fe51738a6c978234758e27",
  )

  t.is(header.version, 4)
  t.is(header.tee_type, 129)
  t.is(hex(body.mr_td), expectedMRTD)
  t.is(hex(body.report_data), expectedReportData)
  t.deepEqual(body.mr_config_id, Buffer.alloc(48))
  t.deepEqual(body.mr_owner, Buffer.alloc(48))
  t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
  t.true(verifyTdxV4Signature(quote))

  t.deepEqual(
    reverseHexBytes(hex(body.mr_seam)),
    "30843fa6f79b6ad4c9460935ceac736f9ec16f60e47b5268a92767f30973a95a5ba02cee3c778a96c60e21109ad89097",
  )
  t.deepEqual(
    reverseHexBytes(hex(body.mr_seam_signer)),
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  )
  t.deepEqual(
    reverseHexBytes(hex(body.mr_config_id)),
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  )
  t.deepEqual(
    reverseHexBytes(hex(body.mr_owner)),
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  )
  t.deepEqual(
    reverseHexBytes(hex(body.mr_owner_config)),
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  )
  t.deepEqual(
    reverseHexBytes(hex(body.rtmr0)),
    "b29e90f91d6a29cfdaaa52adfd65f6c9f1dfacf2dfec14d0b7df44a72dac21a9f76986c4115ebefecb8dd50845209809",
  )
  t.deepEqual(
    reverseHexBytes(hex(body.rtmr1)),
    "930fc60b55e679f8348681094101c75399dc4776b19a32f6b0277f4872d8db978102cfb37c1f43eb6a71f12402103d38",
  )
  t.deepEqual(
    reverseHexBytes(hex(body.rtmr2)),
    "6a90479d9e688add2225c755b71c1acfa3cfa69fb4c2d2fb11ace12e0af1cf90440f577ec7b0dbbf7892d4f42fc4cfee",
  )
  t.deepEqual(
    reverseHexBytes(hex(body.rtmr3)),
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  )
})

test.serial(
  "Verify a V4 TDX quote from Google Cloud, including the full cert chain",
  async (t) => {
    const data = JSON.parse(
      fs.readFileSync("test/sample/tdx-v4-gcp.json", "utf-8"),
    )
    const quote: string = data.tdx.quote
    const { header, body, signature } = parseTdxQuoteBase64(quote)

    const expectedMRTD =
      "409c0cd3e63d9ea54d817cf851983a220131262664ac8cd02cc6a2e19fd291d2fdd0cc035d7789b982a43a92a4424c99"
    const expectedReportData =
      "806dfeec9d10c22a60b12751216d75fb358d83088ea72dd07eb49c84de24b8a49d483085c4350e545689955bdd10e1d8b55ef7c6d288a17032acece698e35db8"

    t.is(header.version, 4)
    t.is(header.tee_type, 129)
    t.is(hex(body.mr_td), expectedMRTD)
    t.is(hex(body.report_data), expectedReportData)
    t.deepEqual(body.mr_config_id, Buffer.alloc(48))
    t.deepEqual(body.mr_owner, Buffer.alloc(48))
    t.deepEqual(body.mr_owner_config, Buffer.alloc(48))
    t.true(verifyTdxV4Signature(quote))

    t.truthy(signature.cert_data)
    t.true(extractPemCertificates(signature.cert_data).length == 2)
    const { status, root, chain } = verifyProvisioningCertificationChain(
      signature.cert_data,
      { verifyAtTimeMs: Date.parse("2025-09-01T00:01:00Z") },
    )
    t.is(status, "valid")
    t.true(root && isPinnedRootCertificate(root, "test/certs"))
    // t.true(verifyQeReportBinding(quote))
    // t.true(verifyQeReportSignature(quote))

    // This should be the PCK leaf JWT (signed by Intel TA). Verify using the
    // signing cert provided in the JWT header (x5c), not the PCK chain.
    const token = fs.readFileSync("test/sample/tdx-v4-gcp-token.hex", "utf-8")
    const decodedUnverified = jwt.decode(token, { complete: true })

    if (decodedUnverified === null) {
      t.fail()
      return
    }

    console.log("Decoded (unverified) header:", decodedUnverified.header)
    console.log("Decoded (unverified) payload:", decodedUnverified.payload)

    // Expect RSA alg and presence of kid; we'll use local certs file
    const { alg, kid } = decodedUnverified.header as {
      alg?: string
      kid?: string
    }
    t.truthy(alg)
    t.true(alg === "PS384" || alg === "RS256")
    t.truthy(kid)

    // Load signing certs from local JSON instead of JWKS
    const certsJson = JSON.parse(
      fs.readFileSync("test/sample/tdx-v4-gcp-token-certs.json", "utf-8"),
    ) as { keys: Array<Record<string, unknown>> }
    const keys = certsJson.keys || []
    let matched = keys.find(
      (k: any) => k.kid === kid && (k.alg === alg || typeof k.alg !== "string"),
    ) as any
    if (!matched) matched = keys.find((k: any) => k.kid === kid) as any
    if (!matched) matched = keys.find((k: any) => k.alg === alg) as any
    if (!matched) matched = keys[0]
    t.truthy(matched)
    const x5c0: string | undefined = matched?.x5c?.[0]
    t.truthy(x5c0)
    const pem =
      "-----BEGIN CERTIFICATE-----\n" +
      x5c0!
        .replace(/\n/g, "")
        .match(/.{1,64}/g)!
        .join("\n") +
      "\n-----END CERTIFICATE-----\n"

    // Choose a verification time while the token is valid
    const payload = decodedUnverified.payload as Record<string, unknown>
    const exp = typeof payload.exp === "number" ? payload.exp : undefined
    const nbf = typeof payload.nbf === "number" ? payload.nbf : undefined
    const iat = typeof payload.iat === "number" ? payload.iat : undefined
    let clockTimestamp = Math.floor(Date.now() / 1000)
    if (exp) {
      const start = (nbf ?? iat ?? exp - 3600) + 60
      clockTimestamp = Math.min(exp - 60, start)
    }

    // Validate the token cert chain (x5c) issuer/subject and validity window
    const x5cArr: string[] = Array.isArray(matched?.x5c)
      ? (matched.x5c as string[])
      : []
    t.true(x5cArr.length >= 2)
    const tokenChainCerts: X509Certificate[] = x5cArr.map(
      (b64) =>
        new X509Certificate(
          "-----BEGIN CERTIFICATE-----\n" +
            b64
              .replace(/\n/g, "")
              .match(/.{1,64}/g)!
              .join("\n") +
            "\n-----END CERTIFICATE-----\n",
        ),
    )
    for (let i = 0; i < tokenChainCerts.length - 1; i++) {
      const child = tokenChainCerts[i]
      const parent = tokenChainCerts[i + 1]
      t.is(child.issuer, parent.subject)
    }
    const nowMs = clockTimestamp * 1000
    for (const c of tokenChainCerts) {
      const notBefore = new Date(c.validFrom).getTime()
      const notAfter = new Date(c.validTo).getTime()
      t.true(notBefore <= nowMs && nowMs <= notAfter)
    }

    const verifiedPayload = jwt.verify(token, pem, {
      algorithms: ["PS384", "RS256"],
      issuer: "https://portal.trustauthority.intel.com",
      clockTimestamp,
    })
    t.truthy(verifiedPayload)

    // // Verifier returns expired if any certificate is expired
    // const { status: status2 } = verifyProvisioningCertificationChain(
    //   signature.cert_data,
    //   { verifyAtTimeMs: Date.parse("2050-09-01T00:01:00Z") },
    // )
    // t.is(status2, "expired")

    // // Verifier returns expired if any certificate is not yet valid
    // const { status: status3 } = verifyProvisioningCertificationChain(
    //   signature.cert_data,
    //   { verifyAtTimeMs: Date.parse("2000-09-01T00:01:00Z") },
    // )
    // t.is(status3, "expired")
  },
)

// test.skip("Parse a V5 TDX 1.0 attestation", async (t) => {
//   // TODO
// })

// test.skip("Parse a V5 TDX 1.5 attestation", async (t) => {
//   // TODO
// })

// test.skip("Parse an SGX attestation", async (t) => {
//   // TODO
// })
