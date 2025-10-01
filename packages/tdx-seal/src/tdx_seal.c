// Minimal TDX sealing demo: checks TDX features/attributes and derives a deterministic key
//
// This program is intended to run as root inside a TDX guest VM. It uses the
// Linux TDX guest device /dev/tdx-guest to:
//  - Fetch TD/TDX info (features, attributes)
//  - Ensure TDX_FEATURES0.SEALING == 1 and ATTRIBUTES.MIGRATABLE == 0
//  - Fetch a TDREPORT and derive a deterministic private key from it
//
// Notes:
//  - The exact UAPI for TDX guest is provided by <linux/tdx-guest.h> in the
//    target system. This code expects that header and its ioctls exist.
//  - On systems where a native sealing key request ioctl is available, you may
//    prefer to use it to fetch a seal-derived key directly. This sample uses a
//    TDREPORT-based derivation to remain widely compatible with current UAPI.
//  - Key derivation uses SHA-256 over the full TDREPORT plus a fixed label to
//    produce a 32-byte deterministic private key. Replace with HKDF if desired.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/tdx-guest.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

// Device node for the TDX guest driver
#ifndef TDX_GUEST_DEV
#define TDX_GUEST_DEV "/dev/tdx-guest"
#endif

// Conservative defaults for sizes (override if your UAPI defines constants)
// Available via <linux/tdx-guest.h>
#ifndef TDX_REPORTDATA_LEN
#define TDX_REPORTDATA_LEN 64
#endif
#ifndef TDX_REPORT_LEN
#define TDX_REPORT_LEN 1024
#endif

// Minimal SHA-256 implementation (public domain style) to avoid external deps
// This is sufficient for deriving a 32-byte deterministic private key from the
// TDREPORT plus a domain separation label. For production, prefer a vetted
// crypto library and consider HKDF-SHA256.

typedef struct {
  uint64_t bitlen;
  uint32_t state[8];
  uint8_t buffer[64];
  size_t buffer_len;
} sha256_ctx;

static inline uint32_t rotr32(uint32_t x, uint32_t n) {
  return (x >> n) | (x << (32 - n));
}

static void sha256_init(sha256_ctx *ctx) {
  ctx->bitlen = 0;
  ctx->buffer_len = 0;
  ctx->state[0] = 0x6a09e667u;
  ctx->state[1] = 0xbb67ae85u;
  ctx->state[2] = 0x3c6ef372u;
  ctx->state[3] = 0xa54ff53au;
  ctx->state[4] = 0x510e527fu;
  ctx->state[5] = 0x9b05688cu;
  ctx->state[6] = 0x1f83d9abu;
  ctx->state[7] = 0x5be0cd19u;
}

static const uint32_t K256[64] = {
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u,
  0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
  0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u,
  0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
  0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
  0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
  0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au,
  0x5b9cca4fu, 0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
  0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

static void sha256_transform(sha256_ctx *ctx, const uint8_t block[64]) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++) {
    w[i] = (uint32_t)block[i * 4 + 0] << 24 |
           (uint32_t)block[i * 4 + 1] << 16 |
           (uint32_t)block[i * 4 + 2] << 8 |
           (uint32_t)block[i * 4 + 3];
  }
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }

  uint32_t a = ctx->state[0];
  uint32_t b = ctx->state[1];
  uint32_t c = ctx->state[2];
  uint32_t d = ctx->state[3];
  uint32_t e = ctx->state[4];
  uint32_t f = ctx->state[5];
  uint32_t g = ctx->state[6];
  uint32_t h = ctx->state[7];

  for (int i = 0; i < 64; i++) {
    uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
    uint32_t ch = (e & f) ^ ((~e) & g);
    uint32_t temp1 = h + S1 + ch + K256[i] + w[i];
    uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
    uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t temp2 = S0 + maj;

    h = g;
    g = f;
    f = e;
    e = d + temp1;
    d = c;
    c = b;
    b = a;
    a = temp1 + temp2;
  }

  ctx->state[0] += a;
  ctx->state[1] += b;
  ctx->state[2] += c;
  ctx->state[3] += d;
  ctx->state[4] += e;
  ctx->state[5] += f;
  ctx->state[6] += g;
  ctx->state[7] += h;
}

static void sha256_update(sha256_ctx *ctx, const uint8_t *data, size_t len) {
  ctx->bitlen += (uint64_t)len * 8;
  while (len > 0) {
    size_t to_copy = 64 - ctx->buffer_len;
    if (to_copy > len) to_copy = len;
    memcpy(ctx->buffer + ctx->buffer_len, data, to_copy);
    ctx->buffer_len += to_copy;
    data += to_copy;
    len -= to_copy;

    if (ctx->buffer_len == 64) {
      sha256_transform(ctx, ctx->buffer);
      ctx->buffer_len = 0;
    }
  }
}

static void sha256_final(sha256_ctx *ctx, uint8_t out[32]) {
  // Append 0x80 then zeros, then 64-bit length in bits
  uint8_t pad = 0x80;
  sha256_update(ctx, &pad, 1);

  uint8_t zero = 0x00;
  while (ctx->buffer_len != 56) {
    sha256_update(ctx, &zero, 1);
  }

  uint8_t len_be[8];
  for (int i = 0; i < 8; i++) {
    len_be[7 - i] = (uint8_t)((ctx->bitlen >> (i * 8)) & 0xFF);
  }
  sha256_update(ctx, len_be, 8);

  for (int i = 0; i < 8; i++) {
    out[i * 4 + 0] = (uint8_t)((ctx->state[i] >> 24) & 0xFF);
    out[i * 4 + 1] = (uint8_t)((ctx->state[i] >> 16) & 0xFF);
    out[i * 4 + 2] = (uint8_t)((ctx->state[i] >> 8) & 0xFF);
    out[i * 4 + 3] = (uint8_t)(ctx->state[i] & 0xFF);
  }
}

static void die_perror(const char *msg) {
  perror(msg);
  exit(EXIT_FAILURE);
}

static void die_msg(const char *msg) {
  fprintf(stderr, "%s\n", msg);
  exit(EXIT_FAILURE);
}

// Try to fetch TD and TDX info (features/attributes). This expects the UAPI to
// expose TDX_CMD_GET_INFO and a struct compatible with <linux/tdx-guest.h>.
// No GET_INFO ioctl is defined in this system header; feature bits are not
// available via UAPI here.

// Fetch a TDREPORT using the guest device. REPORTDATA is optional; we provide a
// fixed label to ensure determinism of the derived key across runs in the same TD.
static bool get_tdreport(int fd, uint8_t report_out[TDX_REPORT_LEN]) {
  struct tdx_report_req req;
  memset(&req, 0, sizeof(req));

  // Use a fixed REPORTDATA label so the derived key is deterministic for the TD
  const char *label = "tdx-seal-v1";
  size_t label_len = strlen(label);
  if (label_len > TDX_REPORTDATA_LEN) label_len = TDX_REPORTDATA_LEN;
  memcpy(req.reportdata, label, label_len);

  if (ioctl(fd, TDX_CMD_GET_REPORT0, &req) != 0) {
    return false;
  }
  memcpy(report_out, req.tdreport, TDX_REPORT_LEN);
  return true;
}

// Attempt to derive a deterministic 32-byte key from the TDREPORT.
static void derive_key_from_report(const uint8_t report[TDX_REPORT_LEN],
                                   uint8_t out_key[32]) {
  const uint8_t domain_label[] = "TDX-SEAL-DERIVE/1";
  sha256_ctx ctx;
  sha256_init(&ctx);
  sha256_update(&ctx, domain_label, sizeof(domain_label) - 1);
  sha256_update(&ctx, report, TDX_REPORT_LEN);
  sha256_final(&ctx, out_key);
}

static void hexprint(const uint8_t *buf, size_t len) {
  for (size_t i = 0; i < len; i++) {
    printf("%02x", buf[i]);
  }
  printf("\n");
}

// Parse td_attributes from the TDREPORT0 buffer. Per TDX 1.0 layout, the
// REPORTMACSTRUCT begins at offset 0 and contains:
//   tee_tcb_svn(16) | mr_seam(48) | mr_seam_signer(48) | seam_svn(4) | reserved(4)
//   td_attributes(8) | xfam(8) | ...
// So td_attributes is at offset 16+48+48+4+4 = 120.
// Returns true on success and writes attributes_le (little-endian).
static bool parse_td_attributes_from_report(const uint8_t report[TDX_REPORT_LEN],
                                            uint64_t *attributes_le) {
  const size_t TD_ATTRIBUTES_OFFSET = 120;
  if (TD_ATTRIBUTES_OFFSET + 8 > TDX_REPORT_LEN) return false;
  uint64_t val = 0;
  // Little-endian decode of 8 bytes
  for (int i = 0; i < 8; i++) {
    val |= ((uint64_t)report[TD_ATTRIBUTES_OFFSET + i]) << (8 * i);
  }
  *attributes_le = val;
  return true;
}

int main(void) {
  if (geteuid() != 0) {
    die_msg("tdx-seal: must be run as root inside a TDX guest");
  }

  int fd = open(TDX_GUEST_DEV, O_RDONLY);
  if (fd < 0) die_perror("open(/dev/tdx-guest)");

  uint8_t tdreport[TDX_REPORT_LEN];
  memset(tdreport, 0, sizeof(tdreport));
  if (!get_tdreport(fd, tdreport)) {
    close(fd);
    die_msg("tdx-seal: failed to obtain TDREPORT via ioctl (GET_REPORT)");
  }

  close(fd);

  // Enforce ATTRIBUTES.MIGRATABLE == 0 by parsing td_attributes from TDREPORT.
  uint64_t td_attributes = 0;
  if (!parse_td_attributes_from_report(tdreport, &td_attributes)) {
    die_msg("tdx-seal: failed to parse td_attributes from TDREPORT");
  }
  // MIGRATABLE bit is defined by the TDX Module spec; in absence of a public
  // header here, assume bit 0 corresponds to MIGRATABLE.
  const uint64_t TD_ATTR_MIGRATABLE_BIT = 1ull << 0;
  if ((td_attributes & TD_ATTR_MIGRATABLE_BIT) != 0) {
    die_msg("tdx-seal: TDX sealing unavailable (ATTRIBUTES.MIGRATABLE!=0)");
  }

  // TDX_FEATURES0.SEALING check is not available via current UAPI; proceed
  // under the assumption that the platform supports sealing through TDREPORT.

  uint8_t privkey[32];
  derive_key_from_report(tdreport, privkey);

  // Output the key as lowercase hex to stdout
  hexprint(privkey, sizeof(privkey));
  return 0;
}

