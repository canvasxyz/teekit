#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include <errno.h>
#include <sys/ioctl.h>
#include <fcntl.h>
#include <openssl/sha.h>
#include <openssl/evp.h>

// TDX TDCALL function numbers
#define TDG_MR_REPORT 0x00000001
#define TDG_KEY_REQUEST 0x00000002

// TDX feature and attribute bits
#define TDX_FEATURES0_SEALING_BIT 0x00000001
#define TDX_ATTRIBUTES_MIGRATABLE_BIT 0x00000001

// TDX error codes
#define TDX_SUCCESS 0x00000000
#define TDX_ERROR_INVALID_PARAMETER 0x80000001
#define TDX_ERROR_INVALID_OPERAND 0x80000002
#define TDX_ERROR_INVALID_OPERATION 0x80000003
#define TDX_ERROR_SEALING_NOT_AVAILABLE 0x80000004

// TDX structures
typedef struct {
    uint64_t rax;
    uint64_t rbx;
    uint64_t rcx;
    uint64_t rdx;
    uint64_t rsi;
    uint64_t rdi;
    uint64_t r8;
    uint64_t r9;
    uint64_t r10;
    uint64_t r11;
    uint64_t r12;
    uint64_t r13;
    uint64_t r14;
    uint64_t r15;
} tdx_registers_t;

typedef struct {
    uint8_t report[1024];  // TDX measurement report
    uint8_t mrenclave[32]; // MRENCLAVE value
} tdx_report_t;

typedef struct {
    uint8_t sealing_key[32]; // Derived sealing key
} tdx_sealing_key_t;

// Function prototypes
static int check_root_privileges(void);
static int check_tdx_features(void);
static int check_tdx_attributes(void);
static int tdcall_mr_report(tdx_report_t *report);
static int tdcall_key_request(const uint8_t *mrenclave, tdx_sealing_key_t *sealing_key);
static int derive_private_key(const tdx_sealing_key_t *sealing_key, uint8_t *private_key);
static void print_hex(const char *label, const uint8_t *data, size_t len);
static void secure_zero_memory(void *ptr, size_t len);

// TDCALL instruction wrapper (inline assembly)
static inline int tdcall(uint64_t function, tdx_registers_t *regs) {
    int result;
    
#ifdef __linux__
    __asm__ volatile (
        "movq %1, %%rax\n\t"
        "movq %2, %%rbx\n\t"
        "movq %3, %%rcx\n\t"
        "movq %4, %%rdx\n\t"
        "movq %5, %%rsi\n\t"
        "movq %6, %%rdi\n\t"
        "movq %7, %%r8\n\t"
        "movq %8, %%r9\n\t"
        "movq %9, %%r10\n\t"
        "movq %10, %%r11\n\t"
        "movq %11, %%r12\n\t"
        "movq %13, %%r14\n\t"
        "movq %14, %%r15\n\t"
        "tdcall\n\t"
        "movq %%rax, %0\n\t"
        "movq %%rbx, %1\n\t"
        "movq %%rcx, %2\n\t"
        "movq %%rdx, %3\n\t"
        "movq %%rsi, %4\n\t"
        "movq %%rdi, %5\n\t"
        "movq %%r8, %6\n\t"
        "movq %%r9, %7\n\t"
        "movq %%r10, %8\n\t"
        "movq %%r11, %9\n\t"
        "movq %%r12, %10\n\t"
        "movq %%r14, %12\n\t"
        "movq %%r15, %13\n\t"
        : "=m" (result), "=m" (regs->rbx), "=m" (regs->rcx), "=m" (regs->rdx),
          "=m" (regs->rsi), "=m" (regs->rdi), "=m" (regs->r8), "=m" (regs->r9),
          "=m" (regs->r10), "=m" (regs->r11), "=m" (regs->r12), "=m" (regs->r13),
          "=m" (regs->r14), "=m" (regs->r15)
        : "m" (function), "m" (regs->rbx), "m" (regs->rcx), "m" (regs->rdx),
          "m" (regs->rsi), "m" (regs->rdi), "m" (regs->r8), "m" (regs->r9),
          "m" (regs->r10), "m" (regs->r11), "m" (regs->r12), "m" (regs->r13),
          "m" (regs->r14), "m" (regs->r15)
        : "%rax", "memory"
    );
#else
    // For non-Linux systems (like macOS), we'll simulate the TDCALL
    // In a real TDX environment, this would be replaced with actual TDCALL
    fprintf(stderr, "Warning: TDCALL not available on this platform. This is a simulation.\n");
    
    // Simulate successful TDCALL for testing purposes
    result = TDX_SUCCESS;
    
    // Simulate some register values for testing
    if (function == 0x00000000) { // TDG.VP.INFO
        regs->rdx = TDX_FEATURES0_SEALING_BIT; // Simulate SEALING available
    } else if (function == TDG_MR_REPORT) {
        // Simulate measurement report - rcx contains buffer address
        uint8_t *report_buffer = (uint8_t *)regs->rcx;
        if (report_buffer) {
            memset(report_buffer, 0xAB, 32); // Simulate MRENCLAVE
        }
    } else if (function == TDG_KEY_REQUEST) {
        // Simulate sealing key - rsi contains key buffer address
        uint8_t *key_buffer = (uint8_t *)regs->rsi;
        if (key_buffer) {
            memset(key_buffer, 0xCD, 32); // Simulate sealing key
        }
    }
#endif
    
    return result;
}

// Check if running as root
static int check_root_privileges(void) {
    if (geteuid() != 0) {
        fprintf(stderr, "Error: This program must be run as root to access TDX features\n");
        return -1;
    }
    return 0;
}

// Check TDX_FEATURES0.SEALING bit
static int check_tdx_features(void) {
    tdx_registers_t regs = {0};
    int result;
    
    // Read TDX_FEATURES0 register
    regs.rcx = 0; // TDX_FEATURES0 register
    result = tdcall(0x00000000, &regs); // TDG.VP.INFO function
    
    if (result != TDX_SUCCESS) {
        fprintf(stderr, "Error: Failed to read TDX_FEATURES0 register (error: 0x%x)\n", result);
        return -1;
    }
    
    // Check SEALING bit
    if (!(regs.rdx & TDX_FEATURES0_SEALING_BIT)) {
        fprintf(stderr, "Error: TDX sealing is not available (TDX_FEATURES0.SEALING = 0)\n");
        return -1;
    }
    
    printf("TDX_FEATURES0.SEALING = 1 (sealing available)\n");
    return 0;
}

// Check ATTRIBUTES.MIGRATABLE bit
static int check_tdx_attributes(void) {
    tdx_registers_t regs = {0};
    int result;
    
    // Read TDX_ATTRIBUTES register
    regs.rcx = 1; // TDX_ATTRIBUTES register
    result = tdcall(0x00000000, &regs); // TDG.VP.INFO function
    
    if (result != TDX_SUCCESS) {
        fprintf(stderr, "Error: Failed to read TDX_ATTRIBUTES register (error: 0x%x)\n", result);
        return -1;
    }
    
    // Check MIGRATABLE bit
    if (regs.rdx & TDX_ATTRIBUTES_MIGRATABLE_BIT) {
        fprintf(stderr, "Error: TDX sealing is not available (ATTRIBUTES.MIGRATABLE = 1)\n");
        return -1;
    }
    
    printf("ATTRIBUTES.MIGRATABLE = 0 (sealing available)\n");
    return 0;
}

// Get TDX measurement report
static int tdcall_mr_report(tdx_report_t *report) {
    tdx_registers_t regs = {0};
    int result;
    
    if (!report) {
        return TDX_ERROR_INVALID_PARAMETER;
    }
    
    // Set up registers for TDG.MR.REPORT
    regs.rcx = (uint64_t)report->report; // Report buffer address
    regs.rdx = sizeof(report->report);   // Report buffer size
    
    result = tdcall(TDG_MR_REPORT, &regs);
    
    if (result != TDX_SUCCESS) {
        fprintf(stderr, "Error: TDG.MR.REPORT failed (error: 0x%x)\n", result);
        return result;
    }
    
    // Extract MRENCLAVE from the report (first 32 bytes)
    memcpy(report->mrenclave, report->report, 32);
    
    printf("Successfully obtained TDX measurement report\n");
    return TDX_SUCCESS;
}

// Request sealing key using MRENCLAVE
static int tdcall_key_request(const uint8_t *mrenclave, tdx_sealing_key_t *sealing_key) {
    tdx_registers_t regs = {0};
    int result;
    
    if (!mrenclave || !sealing_key) {
        return TDX_ERROR_INVALID_PARAMETER;
    }
    
    // Set up registers for TDG.KEY.REQUEST
    regs.rcx = (uint64_t)mrenclave;           // MRENCLAVE address
    regs.rdx = 32;                            // MRENCLAVE size
    regs.rsi = (uint64_t)sealing_key->sealing_key; // Sealing key buffer
    regs.rdi = sizeof(sealing_key->sealing_key);   // Sealing key buffer size
    
    result = tdcall(TDG_KEY_REQUEST, &regs);
    
    if (result != TDX_SUCCESS) {
        fprintf(stderr, "Error: TDG.KEY.REQUEST failed (error: 0x%x)\n", result);
        return result;
    }
    
    printf("Successfully derived sealing key\n");
    return TDX_SUCCESS;
}

// Derive deterministic private key from sealing key
static int derive_private_key(const tdx_sealing_key_t *sealing_key, uint8_t *private_key) {
    EVP_MD_CTX *ctx;
    const EVP_MD *md;
    unsigned int len;
    
    if (!sealing_key || !private_key) {
        return -1;
    }
    
    // Use SHA-256 to derive private key from sealing key
    md = EVP_sha256();
    ctx = EVP_MD_CTX_new();
    
    if (!ctx) {
        fprintf(stderr, "Error: Failed to create EVP_MD_CTX\n");
        return -1;
    }
    
    if (EVP_DigestInit_ex(ctx, md, NULL) != 1) {
        fprintf(stderr, "Error: Failed to initialize digest\n");
        EVP_MD_CTX_free(ctx);
        return -1;
    }
    
    // Hash the sealing key with a domain separator
    const char *domain_separator = "TDX_SEALING_PRIVATE_KEY_DERIVATION";
    if (EVP_DigestUpdate(ctx, domain_separator, strlen(domain_separator)) != 1 ||
        EVP_DigestUpdate(ctx, sealing_key->sealing_key, sizeof(sealing_key->sealing_key)) != 1) {
        fprintf(stderr, "Error: Failed to update digest\n");
        EVP_MD_CTX_free(ctx);
        return -1;
    }
    
    if (EVP_DigestFinal_ex(ctx, private_key, &len) != 1) {
        fprintf(stderr, "Error: Failed to finalize digest\n");
        EVP_MD_CTX_free(ctx);
        return -1;
    }
    
    EVP_MD_CTX_free(ctx);
    
    printf("Successfully derived deterministic private key\n");
    return 0;
}

// Print hex data
static void print_hex(const char *label, const uint8_t *data, size_t len) {
    printf("%s: ", label);
    for (size_t i = 0; i < len; i++) {
        printf("%02x", data[i]);
    }
    printf("\n");
}

// Securely zero memory
static void secure_zero_memory(void *ptr, size_t len) {
    if (ptr && len > 0) {
        volatile uint8_t *p = (volatile uint8_t *)ptr;
        while (len--) {
            *p++ = 0;
        }
    }
}

int main(int argc, char *argv[]) {
    (void)argc;  // Suppress unused parameter warning
    (void)argv;  // Suppress unused parameter warning
    tdx_report_t report = {0};
    tdx_sealing_key_t sealing_key = {0};
    uint8_t private_key[32] = {0};
    int result;
    
    printf("Intel TDX Sealing - Deterministic Private Key Derivation\n");
    printf("========================================================\n\n");
    
    // Check root privileges
    if (check_root_privileges() != 0) {
        return 1;
    }
    
    // Check TDX sealing availability
    if (check_tdx_features() != 0) {
        return 1;
    }
    
    if (check_tdx_attributes() != 0) {
        return 1;
    }
    
    // Get TDX measurement report
    result = tdcall_mr_report(&report);
    if (result != TDX_SUCCESS) {
        return 1;
    }
    
    // Print MRENCLAVE
    print_hex("MRENCLAVE", report.mrenclave, 32);
    
    // Request sealing key
    result = tdcall_key_request(report.mrenclave, &sealing_key);
    if (result != TDX_SUCCESS) {
        return 1;
    }
    
    // Print sealing key
    print_hex("Sealing Key", sealing_key.sealing_key, 32);
    
    // Derive deterministic private key
    result = derive_private_key(&sealing_key, private_key);
    if (result != 0) {
        return 1;
    }
    
    // Print derived private key
    print_hex("Derived Private Key", private_key, 32);
    
    printf("\nSuccessfully derived deterministic private key using TDX sealing!\n");
    
    // Securely clear sensitive data
    secure_zero_memory(&report, sizeof(report));
    secure_zero_memory(&sealing_key, sizeof(sealing_key));
    secure_zero_memory(private_key, sizeof(private_key));
    
    return 0;
}
