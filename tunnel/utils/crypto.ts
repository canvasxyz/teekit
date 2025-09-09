import sodium from "libsodium-wrappers"

export type EncryptedEnvelope = {
  type: "enc"
  nonce: string
  box: string
}

export async function ensureSodiumReady(): Promise<void> {
  await sodium.ready
}

export function encryptPayload(
  key: Uint8Array,
  payload: unknown
): EncryptedEnvelope {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const message =
    typeof payload === "string" ? payload : JSON.stringify(payload)
  const messageBytes = sodium.from_string(message)
  const box = sodium.crypto_secretbox_easy(messageBytes, nonce, key)
  return {
    type: "enc",
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    box: sodium.to_base64(box, sodium.base64_variants.ORIGINAL),
  }
}

export function decryptEnvelope<T = unknown>(
  key: Uint8Array,
  envelope: { nonce: string; box: string }
): T {
  const nonce = sodium.from_base64(
    envelope.nonce,
    sodium.base64_variants.ORIGINAL
  )
  const box = sodium.from_base64(envelope.box, sodium.base64_variants.ORIGINAL)
  const opened = sodium.crypto_secretbox_open_easy(box, nonce, key)
  const message = sodium.to_string(opened)
  return JSON.parse(message) as T
}

