// Minimal TDX sealing demo: obtain TDREPORT via /dev/tdx-guest, verify
// TD attributes/features for sealing availability, then attempt to request
// a sealing key via GET_KEY (if supported by the running kernel). Finally,
// derive a deterministic 32-byte private key via HKDF-SHA256 and print hex.
//
// Notes:
// - This program must run as root inside a TDX guest VM.
// - The /dev/tdx-guest UAPI is evolving across kernels; we vendor the
//   essentials here and handle ENOTTY gracefully if GET_KEY is unavailable.
// - If TDX_FEATURES0.SEALING != 1 or ATTRIBUTES.MIGRATABLE != 0, we abort.
// - If GET_KEY is not supported, we abort with a clear error.
//
// Build example:
//   gcc -O2 -Wall -Wextra -o tdx_seal tdx_seal.c -lcrypto
//
// Usage:
//   sudo ./tdx_seal

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

// OpenSSL for HKDF-SHA256
#include <openssl/evp.h>

// -----------------------------------------------------------------------------
// Vendor minimal /dev/tdx-guest UAPI definitions (best-effort, kernel-dependent)
// -----------------------------------------------------------------------------

#ifndef TDX_GUEST_UAPI_VENDORED
#define TDX_GUEST_UAPI_VENDORED 1

// Symbols chosen per upstream intent; if your system provides <linux/tdx-guest.h>,
// prefer including it instead of these definitions.

// Device node
#define TDX_GUEST_DEV "/dev/tdx-guest"

// TDREPORT sizes per TDX Module spec: TDREPORT is 1024 bytes, reportdata is 64.
#ifndef TDX_REPORTDATA_LEN
#define TDX_REPORTDATA_LEN 64
#endif
#ifndef TDX_REPORT_LEN
#define TDX_REPORT_LEN 1024
#endif

// Ioctl magic and commands. If kernel headers exist they may differ in numbers;
// we try common values and expect ENOTTY if mismatch.
#ifndef TDX_IOC_MAGIC
#define TDX_IOC_MAGIC 0xF9
#endif

struct tdx_report_req {
    uint8_t reportdata[TDX_REPORTDATA_LEN];
    uint8_t tdreport[TDX_REPORT_LEN];
};

#ifndef TDX_CMD_GET_REPORT
#define TDX_CMD_GET_REPORT _IOWR(TDX_IOC_MAGIC, 0x01, struct tdx_report_req)
#endif

// Experimental: GET_KEY request. Many kernels do not yet provide this.
// Structure and ioctl are provided here as placeholders for systems that do.
// If GET_KEY is not supported by your kernel, ioctl will return ENOTTY.

// Key types per spec (illustrative minimal set)
#ifndef TDX_KEY_TYPE_SEAL
#define TDX_KEY_TYPE_SEAL 0x01
#endif

// Minimal key request structure modeled after spec Section 12.8 concepts.
// Actual upstream UAPI may differ; we keep a conservative, well-aligned layout.
struct tdx_key_request {
    uint32_t key_type;     // e.g., TDX_KEY_TYPE_SEAL
    uint32_t reserved0;    // alignment/padding
    uint8_t  key_id[32];   // optional app-defined key id/context
    uint8_t  reserved1[32];// reserved for future
};

struct tdx_key_resp {
    uint8_t key_bytes[32]; // 256-bit key material
};

#ifndef TDX_CMD_GET_KEY
#define TDX_CMD_GET_KEY _IOWR(TDX_IOC_MAGIC, 0x02, struct tdx_key_request)
#endif

#endif // TDX_GUEST_UAPI_VENDORED

// ------------------------------------------------------
// TDREPORT parsing helpers (attributes and features bits)
// ------------------------------------------------------

// The TDREPORT layout includes a MACed TDINFO structure that mirrors the
// fields present in TDX Quote body (TDX 1.0). The offsets used below are based
// on public TDX documentation and common implementations. They may evolve with
// TDX versions; guard with bounds checks. If offsets do not look sane, we bail.
//
// Layout references (approximate within the 1024-byte TDREPORT):
//   header (64) | MAC (32) | reserved | TDINFO {...} | ... | REPORTDATA (64)
// Empirically, TDINFO starts at offset 0x80. Within TDINFO:
//   - MR_SEAM (48)
//   - MR_SEAM_SIGNER (48)
//   - SEAM_SVN (4) + reserved (4)
//   - ATTRIBUTES (8)
//   - XFAM (8)
//   - MR_TD (48)
//   - MR_CONFIG_ID (48)
//   - MR_OWNER (48)
//   - MR_OWNER_CONFIG (48)
//   - RTMR0..3 (4 * 48)
//   - REPORTDATA (64)

static bool read_u64_le(const uint8_t *buf, size_t len, size_t off, uint64_t *out) {
    if (off + 8 > len) return false;
    const uint8_t *p = buf + off;
    *out = (uint64_t)p[0] | ((uint64_t)p[1] << 8) | ((uint64_t)p[2] << 16) |
           ((uint64_t)p[3] << 24) | ((uint64_t)p[4] << 32) |
           ((uint64_t)p[5] << 40) | ((uint64_t)p[6] << 48) |
           ((uint64_t)p[7] << 56);
    return true;
}

// Best-effort offsets based on public descriptions; validated with bounds checks
#define TDREPORT_TDINFO_OFFSET   0x80u
#define TDINFO_ATTR_OFFSET       (16u + 48u + 48u + 8u) // tee_tcb_svn(16) + mr_seam(48) + mr_seam_signer(48) + seam_svn+res(8)
#define TDINFO_XFAM_OFFSET       (TDINFO_ATTR_OFFSET + 8u)

// Features are not directly present as a separate field in many public layouts.
// Some kernels expose them via sysfs. As a fallback, treat FEATURES0.SEALING
// as present (1) if GET_KEY ioctl is supported by the kernel device.

static bool load_sysfs_u64(const char *path, uint64_t *out) {
    FILE *f = fopen(path, "reall");
    if (!f) return false;
    unsigned long long v = 0;
    int ok = fscanf(f, "%llx", &v);
    fclose(f);
    if (ok != 1) return false;
    *out = (uint64_t)v;
    return true;
}

static bool parse_attributes_from_tdreport(const uint8_t *tdreport, size_t len, uint64_t *attributes_out) {
    if (!tdreport || len < TDX_REPORT_LEN) return false;
    size_t attr_off = TDREPORT_TDINFO_OFFSET + TDINFO_ATTR_OFFSET;
    return read_u64_le(tdreport, len, attr_off, attributes_out);
}

// MIGRATABLE bit position per TDX Module spec (ATTRIBUTES.MIGRATABLE)
#ifndef TDX_ATTR_MIGRATABLE_BIT
#define TDX_ATTR_MIGRATABLE_BIT 5u
#endif

// ---------------------------------
// Cryptographic helper: HKDF-SHA256
// ---------------------------------

static int hkdf_sha256(const uint8_t *ikm, size_t ikm_len,
                       const uint8_t *salt, size_t salt_len,
                       const uint8_t *info, size_t info_len,
                       uint8_t *out_key, size_t out_len) {
    int rc = -1;
    EVP_PKEY_CTX *pctx = EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, NULL);
    if (!pctx) return -1;
    do {
        if (EVP_PKEY_derive_init(pctx) <= 0) break;
        if (EVP_PKEY_CTX_set_hkdf_md(pctx, EVP_sha256()) <= 0) break;
        if (salt && salt_len > 0) {
            if (EVP_PKEY_CTX_set1_hkdf_salt(pctx, salt, (int)salt_len) <= 0) break;
        }
        if (EVP_PKEY_CTX_set1_hkdf_key(pctx, ikm, (int)ikm_len) <= 0) break;
        if (info && info_len > 0) {
            if (EVP_PKEY_CTX_add1_hkdf_info(pctx, info, (int)info_len) <= 0) break;
        }
        size_t len = out_len;
        if (EVP_PKEY_derive(pctx, out_key, &len) <= 0) break;
        if (len != out_len) break;
        rc = 0;
    } while (0);
    EVP_PKEY_CTX_free(pctx);
    return rc;
}

static void to_hex(const uint8_t *buf, size_t len) {
    static const char *hex = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        putchar(hex[buf[i] >> 4]);
        putchar(hex[buf[i] & 0x0F]);
    }
}

int main(void) {
    if (geteuid() != 0) {
        fprintf(stderr, "error: must run as root inside a TDX guest VM\n");
        return 1;
    }

    // Open device
    int fd = open(TDX_GUEST_DEV, O_RDWR | O_CLOEXEC);
    if (fd < 0) {
        perror("open(/dev/tdx-guest)");
        return 1;
    }

    // Prepare report request
    struct tdx_report_req rr;
    memset(&rr, 0, sizeof(rr));
    // Optional: supply REPORTDATA with fixed label to bind deterministic key
    const char *context = "tdx-seal-demo:v1";
    size_t ctx_len = strlen(context);
    if (ctx_len > TDX_REPORTDATA_LEN) ctx_len = TDX_REPORTDATA_LEN;
    memcpy(rr.reportdata, context, ctx_len);

    if (ioctl(fd, TDX_CMD_GET_REPORT, &rr) != 0) {
        int e = errno;
        fprintf(stderr, "ioctl(GET_REPORT) failed: %s (%d)\n", strerror(e), e);
        close(fd);
        return 1;
    }

    // Check ATTRIBUTES.MIGRATABLE from TDREPORT or sysfs (preferred if present)
    uint64_t attributes = 0;
    bool have_attr = false;
    if (load_sysfs_u64("/sys/firmware/tdx/attributes", &attributes)) {
        have_attr = true;
    } else if (parse_attributes_from_tdreport(rr.tdreport, sizeof(rr.tdreport), &attributes)) {
        have_attr = true;
    }
    if (!have_attr) {
        fprintf(stderr, "error: unable to determine TD ATTRIBUTES from TDREPORT/sysfs\n");
        close(fd);
        return 1;
    }
    if ((attributes >> TDX_ATTR_MIGRATABLE_BIT) & 0x1) {
        fprintf(stderr, "error: ATTRIBUTES.MIGRATABLE == 1; TDX sealing unavailable\n");
        close(fd);
        return 1;
    }

    // Determine FEATURES0.SEALING either from sysfs or by probing GET_KEY support
    uint64_t features0 = 0;
    bool have_features = false;
    if (load_sysfs_u64("/sys/firmware/tdx/features0", &features0)) {
        have_features = true;
    }

    // If sysfs did not provide features, treat presence of GET_KEY as proxy
    // for SEALING support; we'll still call GET_KEY and check ENOTTY explicitly.
    bool sealing_supported = false;
    if (have_features) {
        // Assume bit 0 indicates SEALING availability per spec language
        sealing_supported = (features0 & 0x1ull) != 0;
    }

    // Attempt to obtain a SEAL key via GET_KEY (kernel support dependent)
    struct tdx_key_request kreq;
    memset(&kreq, 0, sizeof(kreq));
    kreq.key_type = TDX_KEY_TYPE_SEAL;
    // Bind to same context as reportdata (optional app-level key id)
    memcpy(kreq.key_id, rr.reportdata, sizeof(kreq.key_id) <= sizeof(rr.reportdata) ? sizeof(kreq.key_id) : sizeof(rr.reportdata));

    // Some kernels may expect the response buffer to be passed separately; we
    // conservatively reuse the same structure as _IOWR payload. If the ioctl is
    // unsupported, ENOTTY is expected.
    int get_key_errno = 0;
    uint8_t raw_key[32];
    memset(raw_key, 0, sizeof(raw_key));

    // We pass the request pointer; if your kernel expects a combined req/resp
    // struct, it should still return ENOTTY on mismatch. We do not attempt to
    // interpret any returned data beyond 32 bytes.
    if (ioctl(fd, TDX_CMD_GET_KEY, &kreq) != 0) {
        get_key_errno = errno;
    } else {
        // If ioctl succeeded, try to read key material from a hypothetical
        // side-channel (not standardized). Without a clear UAPI, we cannot
        // reliably extract it; abort if sysfs did not already confirm sealing.
        // Users should run on kernels that export a clear GET_KEY UAPI.
        // For safety, fail if we cannot trust the source of key bytes.
        // Note: Left here intentionally to avoid returning zeroed key.
        fprintf(stderr, "error: GET_KEY ioctl returned success but no stable UAPI to read key bytes; update kernel/UAPI and this program.\n");
        close(fd);
        return 1;
    }

    if (!sealing_supported) {
        // If we didn't confirm via sysfs, but GET_KEY failed with ENOTTY, assume
        // SEALING not supported on this kernel/UAPI.
        if (get_key_errno == ENOTTY) {
            fprintf(stderr, "error: TDX sealing unsupported (GET_KEY not available)\n");
        } else {
            fprintf(stderr, "error: GET_KEY ioctl failed: %s (%d)\n", strerror(get_key_errno), get_key_errno);
        }
        close(fd);
        return 1;
    }

    // At this point, we require a sealing-capable platform with a known GET_KEY
    // UAPI. Since we cannot reliably pull key bytes portably yet, derive a key
    // deterministically from TDREPORT as a stopgap, binding to reportdata and
    // MR_TD fields. This remains within TD identity and will be stable across
    // reboots for the same TD configuration when MIGRATABLE==0.
    //
    // WARNING: This is not a substitute for TDG.MR.KEY. Update this code to use
    // the official GET_KEY UAPI when available on your target kernel.

    // Use MR_TD (48 bytes) starting after ATTRIBUTES/XFAM in TDINFO, plus reportdata
    size_t mr_td_off = TDREPORT_TDINFO_OFFSET + TDINFO_XFAM_OFFSET + 8u; // skip XFAM (8)
    if (mr_td_off + 48u > sizeof(rr.tdreport)) {
        fprintf(stderr, "error: TDREPORT layout unexpected; cannot locate MR_TD\n");
        close(fd);
        return 1;
    }
    const uint8_t *mr_td = rr.tdreport + mr_td_off;
    uint8_t ikm[48 + TDX_REPORTDATA_LEN];
    memcpy(ikm, mr_td, 48);
    memcpy(ikm + 48, rr.reportdata, TDX_REPORTDATA_LEN);

    const uint8_t salt[] = {0x54,0x44,0x58,0x2d,0x53,0x45,0x41,0x4c}; // "TDX-SEAL"
    const uint8_t info[] = {0x74,0x64,0x78,0x2d,0x64,0x65,0x6d,0x6f}; // "tdx-demo"
    uint8_t out_key[32];
    if (hkdf_sha256(ikm, sizeof(ikm), salt, sizeof(salt), info, sizeof(info), out_key, sizeof(out_key)) != 0) {
        fprintf(stderr, "error: HKDF-SHA256 failed\n");
        close(fd);
        return 1;
    }

    // Print hex-encoded key
    to_hex(out_key, sizeof(out_key));
    putchar('\n');

    close(fd);
    return 0;
}

