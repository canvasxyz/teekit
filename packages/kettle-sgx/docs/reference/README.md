# Archived Reference Files

This directory contains the original Node.js-based SGX quote service implementation
that has been replaced by the consolidated Go-based `sgx-entrypoint` binary.

These files are kept as reference documentation and are **no longer used** in production.

## Archived Files

### `sgx-quote-service.ts`

The original TypeScript implementation of the SGX quote service. This ran on Node.js
inside the Gramine enclave and provided:

- HTTP server on port 3333
- `GET /healthz` - Health check endpoint
- `GET/POST /quote` - Quote generation with optional x25519 public key binding
- Rate limiting (10 requests/minute per IP)
- CORS support
- Gramine `/dev/attestation` integration

**Replaced by**: `sgx-entrypoint.go` (combined Go implementation in parent directory)

### `workerd-nodejs.manifest.template`

The original Gramine manifest template that included Node.js dependencies:

- `/usr/bin/node` mount
- `/usr/share/nodejs` trusted files
- `sgx-quote-service.js` trusted file
- `entrypoint.sh` (bash script version)

**Replaced by**: `workerd.manifest.template` (uses `sgx-entrypoint` in parent directory)

### `entrypoint-nodejs.sh`

The original enclave entrypoint script that used Node.js to run the quote service:

```bash
node /opt/kettle/sgx-quote-service.js &
```

**Replaced by**: `sgx-entrypoint` (single Go binary that does both quote service + workerd launching)

## Current Implementation

The current implementation uses a single Go binary called `sgx-entrypoint` that:

1. Starts an HTTP server for SGX quote generation (port 3333)
2. Launches workerd as a child process
3. Forwards signals for graceful shutdown

This replaces both the bash `entrypoint.sh` script and the separate `sgx-quote-service` binary.

## Why the Change?

The consolidated `sgx-entrypoint` provides several advantages:

1. **Single binary**: One component instead of two (bash script + Go binary)
2. **Smaller TCB**: No bash, curl, sleep, kill utilities needed in enclave
3. **Faster startup**: No external health check polling
4. **Simpler dependencies**: Zero runtime dependencies
5. **Better signal handling**: Native Go signal forwarding vs bash traps
6. **Reproducible builds**: Easier to verify binary integrity

See `SGX-ENTRYPOINT-README.md` in the parent directory for full details.

## If You Need to Revert

If for some reason you need to revert to the previous two-component setup:

1. Check git history for `entrypoint.sh` and `sgx-quote-service.go`
2. Restore `workerd.manifest.template` to reference both files
3. Update build scripts to build `sgx-quote-service` instead of `sgx-entrypoint`

However, this is **not recommended** as the consolidated version is simpler and more efficient.
