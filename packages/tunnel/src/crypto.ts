import { xsalsa20poly1305, hsalsa as hsalsaCore } from "@noble/ciphers/salsa.js"
import { blake2b } from "@noble/hashes/blake2b"
import { x25519 } from "@noble/curves/ed25519.js"

function assertLength(name: string, arr: Uint8Array, expected: number) {
  if (arr.length !== expected) {
    throw new Error(`${name} must be ${expected} bytes`)
  }
}

function u8ToU32LE(bytes: Uint8Array): Uint32Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Uint32Array(bytes.byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = dv.getUint32(i * 4, true)
  return out
}

function u32ToU8LE(words: Uint32Array): Uint8Array {
  const out = new Uint8Array(words.length * 4)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i], true)
  return out
}

// Salsa20 constant: https://cr.yp.to/snuffle/xsalsa-20110204.pdf
const SIGMA = new Uint32Array([
  0x61707865, // "expa"
  0x3320646e, // "nd 3"
  0x79622d32, // "2-by"
  0x6b206574, // "te k"
])

function hsalsa20(key32: Uint8Array, nonce16: Uint8Array): Uint8Array {
  assertLength("hsalsa key", key32, 32)
  assertLength("hsalsa nonce", nonce16, 16)
  const k = u8ToU32LE(key32)
  const i = u8ToU32LE(nonce16)
  const out = new Uint32Array(8)
  hsalsaCore(SIGMA, k, i, out)
  return u32ToU8LE(out)
}

// @noble/ciphers-based facade for crypto_box_ and crypto_secretbox_
export const sodium = {
  ready: Promise.resolve(),

  crypto_secretbox_easy(
    plaintext: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array {
    assertLength("nonce", nonce, 24)
    assertLength("key", key, 32)
    const aead = xsalsa20poly1305(key, nonce)
    return aead.encrypt(plaintext)
  },

  crypto_secretbox_open_easy(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array {
    assertLength("nonce", nonce, 24)
    assertLength("key", key, 32)
    const aead = xsalsa20poly1305(key, nonce)
    const pt = aead.decrypt(ciphertext)
    if (!pt) throw new Error("decryption failed")
    return pt
  },

  crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
    const kp = x25519.keygen()
    const privateKey = kp.secretKey
    const publicKey = kp.publicKey
    return { publicKey, privateKey }
  },

  // Equivalent sealed box: sealed = epk || box
  // nonce = blake2b(epk || recipientPk, 24)
  // key = blake2b(sharedSecret, 32)
  crypto_box_seal(
    message: Uint8Array,
    recipientPublicKey: Uint8Array,
  ): Uint8Array {
    assertLength("recipientPublicKey", recipientPublicKey, 32)
    const eph = x25519.keygen()
    const ephSk = eph.secretKey
    const ephPk = eph.publicKey
    const shared = x25519.getSharedSecret(ephSk, recipientPublicKey)
    // Precompute box key (beforenm): HSalsa20(shared, zeros(16))
    const preKey = hsalsa20(shared.subarray(0, 32), new Uint8Array(16))
    // Nonce per libsodium sealed box: BLAKE2b(ephemeral_pk || recipient_pk, 24)
    const nonceInput = new Uint8Array(64)
    nonceInput.set(ephPk, 0)
    nonceInput.set(recipientPublicKey, 32)
    const nonce = blake2b(nonceInput, { dkLen: 24 })
    const aead = xsalsa20poly1305(preKey, nonce)
    const ct = aead.encrypt(message)
    const sealed = new Uint8Array(32 + ct.length)
    sealed.set(ephPk, 0)
    sealed.set(ct, 32)
    return sealed
  },

  crypto_box_seal_open(
    sealed: Uint8Array,
    recipientPublicKey: Uint8Array,
    recipientPrivateKey: Uint8Array,
  ): Uint8Array {
    assertLength("recipientPublicKey", recipientPublicKey, 32)
    assertLength("recipientPrivateKey", recipientPrivateKey, 32)
    if (sealed.length < 32 + 16) {
      throw new Error("sealed box too short")
    }
    const ephPk = sealed.subarray(0, 32)
    const ct = sealed.subarray(32)
    const shared = x25519.getSharedSecret(recipientPrivateKey, ephPk)
    const preKey = hsalsa20(shared.subarray(0, 32), new Uint8Array(16))
    const nonceInput = new Uint8Array(64)
    nonceInput.set(ephPk, 0)
    nonceInput.set(recipientPublicKey, 32)
    const nonce = blake2b(nonceInput, { dkLen: 24 })
    const aead = xsalsa20poly1305(preKey, nonce)
    const pt = aead.decrypt(ct)
    if (!pt) throw new Error("decryption failed")
    return pt
  },
}

export default sodium
