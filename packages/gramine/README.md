# Kettle SGX Deployment with Gramine

This package provides a proof-of-concept for running workerd kettles
inside an Intel SGX enclave using the Gramine library OS.

## Quickstart

You should have the Azure CLI installed. Create a DC2ds_v3 VM with SGX
support. (You may need to request quota via the Azure portal first.)

```
az login

az group create --name sgxGroup --location eastus

az vm create \
  --resource-group sgxGroup \
  --name sgx-vm \
  --location eastus2 \
  --size Standard_DC2ds_v3 \
  --image Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest \
  --admin-username azureuser \
  --generate-ssh-keys

az ssh vm -g sgxGroup --name sgx-vm --local-user azureuser
```

## Setup Instructions

```
git clone https://github.com/canvasxyz/teekit.git
cd teekit

./scripts/setup-azure-sgx.sh
```

Log out and log in again. Then, set up the bundle directory and build:

```bash
# One-time setup: Configure bundle directory permissions
sudo mkdir -p /opt/kettle
sudo chown $USER:$USER /opt/kettle

# Build the project
npm install
npm run build

cd packages/gramine
npm run build:bundle    # Run ./scripts/build-kettle-bundle.sh
npm run build:enclave   # Run Gramine build, sign the enclave
SGX=1 make run          # Run the kettle at http://localhost:3001
```

**Note**: SGX enclave initialization takes **30-60 seconds**. The enclave is loading when you see "Emulating a raw syscall instruction" in the logs. Wait for the quote service to become available at `http://localhost:3333/healthz` before testing.

### Verifying Quotes

```typescript
import { TunnelClient } from "@teekit/tunnel"

const EXPECTED_MRENCLAVE = "1234567890abcdef..." // 64 hex chars
const EXPECTED_MRSIGNER = "fedcba0987654321..."  // 64 hex chars

const client = await TunnelClient.initialize("https://enclave.example.com", {
  sgx: true,
  measurements: {
    mr_enclave: EXPECTED_MRENCLAVE,
    mr_signer: EXPECTED_MRSIGNER,
    // TODO: report_data: ...
    // TODO: isv_svn (security version), isv_prod_id (product identifier, typically 1)
  }
})

// All requests are now verified and encrypted end-to-end
const response = await client.fetch("/api/data")
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKERD_PORT` | 3001 | HTTP port for workerd |
| `KETTLE_BUNDLE_DIR` | /opt/kettle | Bundle directory |
| `KETTLE_DATA_DIR` | /var/lib/kettle | Data directory for sealed storage |

### Makefile Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SGX` | 1 | Enable SGX (0 for direct mode) |
| `DEBUG` | 0 | Enable debug mode |
| `EDMM` | 0 | Enable dynamic memory (SGX2) |
| `LOG_LEVEL` | error | Gramine log level |

## Troubleshooting

### SGX Not Available

```bash
# Check SGX support
is-sgx-available

# Check if SGX driver is loaded
ls /dev/sgx*

# Check AESM service
systemctl status aesmd
```

### Build Fails with Permission Denied

If `npm run build:bundle` fails with "Permission denied" when copying to `/opt/kettle`:

```bash
# Run the one-time setup:
sudo mkdir -p /opt/kettle
sudo chown $USER:$USER /opt/kettle

# Then retry the build
npm run build:bundle
```

Alternatively, use the combined build script which handles permissions automatically:
```bash
./build-and-test-go.sh
```

### Quote Generation Fails

1. Verify DCAP is configured:
   ```bash
   cat /etc/sgx_default_qcnl.conf
   ```

2. Check PCCS connectivity (for on-prem):
   ```bash
   curl https://localhost:8081/sgx/certification/v4/rootcacrl
   ```

3. On Azure, ensure the Azure DCAP client is installed:
   ```bash
   apt install az-dcap-client
   ```

## Limitations

1. **Memory**: SGX EPC is limited (~256MB-512MB). Exceeding this causes paging.
2. **Performance**: Enclave transitions (ecalls/ocalls) add overhead.
3. **V8 Compatibility**: workerd/V8 has not been extensively tested with Gramine.
4. **No Shell Inside**: Unlike TDX devtools, you can't easily SSH into an enclave.
5. **In-Memory Storage**: DO SQLite storage is in-memory only; data is lost on restart.

## Next Steps

1. **Test workerd in Gramine** - Verify V8 works correctly
2. **Add persistent storage** - Implement file-based or external storage for DO data
3. **Production signing** - Use proper code signing workflow
4. **CI/CD** - Automate enclave builds and measurement extraction
