Quote samples are obtained from:

SGX:

- https://github.com/tlsnotary/tlsn-quote-verification
- https://github.com/chinenyeokafor/verify_sgx_quote
- https://github.com/aggregion/occlum-sgx-quote
- https://github.com/intel/SGX-TDX-DCAP-QuoteVerificationLibrary

TDX:

- https://github.com/edgelesssys/go-tdx-qpl/tree/main/blobs
- https://github.com/MoeMahhouk/tdx-quote-parser
- https://github.com/Phala-Network/dcap-qvl/tree/master/sample
- https://github.com/confidential-containers/trustee
- https://github.com/datachainlab/zkdcap
- https://github.com/intel/SGX-TDX-DCAP-QuoteVerificationLibrary

tdx-v4-gcp.json is obtained from Google Cloud following instructions
in qvl/ATTESTATION-GCP.md.

tdx-v4-azure is obtained from Azure following instructions
in qvl/ATTESTATION.md.

SEV-SNP:

sev-gcp.bin: SEV-SNP attestation report from a Google Cloud confidential VM.
This is a version 5 SNP attestation report (1184 bytes) obtained from the
AMD Secure Processor via the /dev/sev-guest device.

Report characteristics:
  - Version: 5 (SNP)
  - VMPL: 0 (most privileged)
  - Signature algorithm: 1 (ECDSA P-384 with SHA-384)
  - Debug: disabled
  - SMT: allowed by policy, enabled on platform

Note: The report_data field is all zeros (no guest-provided data).
The measurement contains the SHA-384 hash of the initial guest memory.

For verification, the VCEK certificate must be obtained from AMD's Key
Distribution Service (KDS) using the chip_id and TCB version from the report:
https://kdsintf.amd.com/vcek/v1/{product_name}/{chip_id}

COMPATIBILITY NOTES:

SEV-SNP vs Intel TDX/SGX:

- SEV-SNP reports are signed directly by the AMD Secure Processor (no quoting enclave)
- Certificate chain is NOT embedded in the report (must fetch from AMD KDS)
- Uses ECDSA P-384 with SHA-384 (TDX/SGX use P-256 with SHA-256)
- Measurement is 48 bytes (SHA-384 hash)

SEV versions:

- SEV (original): Launch-time attestation only, version 1 reports - NOT SUPPORTED
- SEV-ES: Enhanced security, but same attestation model as SEV - NOT SUPPORTED
- SEV-SNP: Runtime attestation, version 2+ reports - SUPPORTED

Report format versions:

- Version 0: Reserved/invalid
- Version 1: Original SEV (different format, not compatible)
- Version 2+: SEV-SNP (supported by this implementation)

Signature algorithm:

- Algorithm 0: Reserved or legacy (some early implementations)
- Algorithm 1: ECDSA P-384 with SHA-384 (current standard)
  Both values are accepted for compatibility.
