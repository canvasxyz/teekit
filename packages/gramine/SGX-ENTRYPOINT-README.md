# SGX Entrypoint

A single Go binary that serves as the entrypoint for Gramine SGX enclaves. It combines:

1. **SGX Quote Service** - HTTP server for attestation quote generation
2. **workerd Launcher** - Starts and manages the workerd process

This replaces the previous two-component setup (bash entrypoint.sh + Go sgx-quote-service).

## Quick Start

### Build the Binary

```bash
cd packages/gramine
make -f sgx-entrypoint.mk
```

This creates `sgx-entrypoint` (~4.5MB static binary).

### Test Locally with Gramine

```bash
# Build, sign, and test the enclave
./build-and-test-go.sh
```

## How It Works

The `sgx-entrypoint` binary:

1. Starts an HTTP server on port 3333 (configurable via `QUOTE_SERVICE_PORT`)
2. Waits for the HTTP server to be ready
3. Launches workerd as a child process with provided arguments
4. Forwards signals (SIGTERM, SIGINT) to workerd for graceful shutdown
5. Exits when workerd exits

### Gramine Integration

The Gramine manifest specifies `sgx-entrypoint` as the entrypoint:

```toml
libos.entrypoint = "/opt/kettle/sgx-entrypoint"

loader.argv = [
  "/opt/kettle/sgx-entrypoint",
  "serve",
  "--experimental",
  "--verbose",
  "workerd.config.capnp",
]
```

Arguments after `sgx-entrypoint` are passed directly to workerd.

## API

### Health Check

```bash
curl http://localhost:3333/healthz
```

Response:
```json
{
  "status": "ok",
  "service": "sgx-entrypoint",
  "enclave": true,
  "attestation_type": "dcap"
}
```

### Generate Quote (no key binding)

```bash
curl http://localhost:3333/quote
```

### Generate Quote (with x25519 public key binding)

```bash
curl -X POST http://localhost:3333/quote \
  -H "Content-Type: application/json" \
  -d '{"publicKey": [1,2,3,4,...,32]}'
```

Response:
```json
{
  "quote": "AwACAAAAAAALABAAk5pyM...",
  "tee_type": "sgx",
  "report_data": "xYz..."
}
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `QUOTE_SERVICE_PORT` | `3333` | Port for the quote service HTTP server |
| `WORKERD_PATH` | `/usr/local/bin/workerd` | Path to workerd binary |

## Files

| File | Description |
|------|-------------|
| `sgx-entrypoint.go` | Combined Go implementation |
| `sgx-entrypoint.mk` | Reproducible build configuration |
| `workerd.manifest.template` | Gramine manifest using sgx-entrypoint |

### Archived Files

Previous Node.js-based implementation is archived in `docs/reference/`:

- `sgx-quote-service.ts` - Original TypeScript implementation
- `entrypoint-nodejs.sh` - Original bash entrypoint for Node.js
- `workerd-nodejs.manifest.template` - Manifest with Node.js

## Benefits

| Metric | Previous (bash + Go) | Combined | Improvement |
|--------|---------------------|----------|-------------|
| Components | 2 (bash script + Go binary) | 1 (Go binary) | **Simpler** |
| Trusted files | 2 entries | 1 entry | **Smaller TCB** |
| Dependencies | bash, curl, sleep, kill | None | **Zero dependencies** |
| Startup | Sequential with health polling | Internal wait | **Faster** |
| Signal handling | bash trap → kill | Native Go | **More reliable** |

## Build Reproducibility

The build is designed to be reproducible:

```bash
# Build twice and compare
make -f sgx-entrypoint.mk clean && make -f sgx-entrypoint.mk
sha256sum sgx-entrypoint > hash1.txt

make -f sgx-entrypoint.mk clean && make -f sgx-entrypoint.mk
sha256sum sgx-entrypoint > hash2.txt

diff hash1.txt hash2.txt  # Should be identical
```

Build flags:
- `-trimpath` - Remove file paths
- `-mod=readonly` - Don't modify go.mod
- `-s -w` - Strip debug info
- `-extldflags=-static` - Static linking
- `CGO_ENABLED=0` - No C dependencies

## Troubleshooting

### Build fails: "go: command not found"

Install Go:
```bash
sudo apt install golang-go
```

### Enclave fails to start

Check logs:
```bash
journalctl -u gramine-sgx -n 50
```

Common issues:
- Port 3333 already in use (check with `lsof -i :3333`)
- workerd binary not found (check `WORKERD_PATH`)
- AESM service not running (`systemctl status aesmd`)

### Quote generation fails

Verify SGX is available:
```bash
is-sgx-available
ls -l /dev/sgx*
```

---

**Version**: 2.0
**Date**: 2025-12-31
