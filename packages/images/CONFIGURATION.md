## Configuration

When the VM boots, `cloud-launcher.service` runs to obtain a manifest
before launching `kettle-launcher.service`.

The config script checks for GCP, Azure, and QEMU metadata services,
looking for a base64-encoded manifest. If it finds one, the manifest
is written to `/etc/kettle/cloud-launcher.env` and configured as as the
`MANIFEST` environment variable to initialize the kettle launcher.

For Google Cloud, set the manifest as a metadata attribute:

```
# Generate base64-encoded manifest
MANIFEST_B64=$(base64 -w0 manifest.json)

# Create VM instance with manifest metadata
gcloud compute instances create my-tee-vm \
  --image=tdx-debian \
  --metadata=manifest="$MANIFEST_B64"
```

For Azure, set the manifest as a tag:

```
# Generate base64-encoded manifest
MANIFEST_B64=$(base64 -w0 manifest.json)

# Create VM with manifest tag
az vm create \
  --name my-tee-vm \
  --image tdx-debian \
  --tags manifest="$MANIFEST_B64"
```

For local testing with QEMU, use the `test_local.sh` script, which
automatically starts a metadata service on the host at
`http://10.0.2.2:8090` and serves the manifest from
`packages/images/kettle-artifacts/manifest.json`.

```
cd packages/images
npm run test:local
```

The manifest is expected to be a JSON file with the following structure:

```
{
  "app": "file:///usr/lib/kettle/app.js", // also accepts http or https URL
  "sha256": "52b50d81b56ae6ebd2acc4c18f034a998fd60e43d181142fcca443faa21be217"
}
```

The VM build creates a demo app inside the VM at `/usr/lib/kettle/app.js`
along with a default manifest at `/usr/lib/kettle/manifest.json`. This allows
the VM to start automatically without any metadata configuration, bypassing
the need to publish the manifest to S3 or Github Gists.

If no `MANIFEST` environment variable is provided via cloud metadata, the
kettle launcher will automatically use the embedded default manifest.

You may also inspect the generated default manifest used for testing at:
- `packages/images/build/tdx-debian/build/kettle/manifest.json` (during build)
- `packages/images/kettle-artifacts/manifest.json` (for testing)
- `/usr/lib/kettle/manifest.json` (inside the VM)

## HTTPS Configuration

You may also provide a `hostname` metadata config variable to enable HTTPS support
via Let's Encrypt and nginx reverse proxy. This can be:
- A single hostname (e.g., `example.com`)
- A comma-delimited list of hostnames (e.g., `foo.com,bar.com,baz.com`)

For Google Cloud, set the hostname as a metadata attribute:
```
gcloud compute instances create my-tee-vm \
  --metadata=hostname="foo.com,bar.com"
```

For Azure, set the hostname as a tag:
```
az vm create \
  --name my-tee-vm \
  --tags hostname="foo.com,bar.com"
```

### Intel Trust Authority Configuration

To enable Intel Trust Authority attestation, set the `trustauthority_api_key` tag.
The `trustauthority_api_url` is optional and defaults to `https://api.trustauthority.intel.com`.

For Azure, set the Trust Authority configuration as tags on an existing VM:
```
az vm update \
  --name my-tee-vm \
  --resource-group my-resource-group \
  --set tags.trustauthority_api_key="djE6N2U4..." \
        tags.trustauthority_api_url="https://api.trustauthority.intel.com"

az vm restart \
  --name my-tee-vm \
  --resource-group my-resource-group
```

### Addendum: Certbot Proxy Behavior

When hostnames are provided, the VM will:
1. **Obtain a single SAN certificate** for all specified hostnames using certbot
2. **Configure nginx as a reverse proxy** to route HTTPS traffic to kettles
3. **Map hostnames to kettles** in sequential order (first hostname → first kettle, etc.)

The mapping between hostnames and manifests works as follows:

- **Equal counts** (e.g., 3 manifests, 3 hostnames):
  - `hostname1:443` → kettle 0 on port 3001
  - `hostname2:443` → kettle 1 on port 3002
  - `hostname3:443` → kettle 2 on port 3003
  - All kettles are accessible via HTTPS ✓

- **More hostnames than manifests** (e.g., 2 manifests, 3 hostnames):
  - `hostname1:443` → kettle 0 on port 3001 ✓
  - `hostname2:443` → kettle 1 on port 3002 ✓
  - `hostname3:443` → tries to proxy to port 3003 (no kettle exists) ✗
  - Extra hostnames will return 502 Bad Gateway errors

- **More manifests than hostnames** (e.g., 3 manifests, 2 hostnames):
  - `hostname1:443` → kettle 0 on port 3001
  - `hostname2:443` → kettle 1 on port 3002
  - Third kettle on port 3003 has **no HTTPS proxy** ⚠️
  - The unmapped kettle is only accessible via `http://<vm-ip>:3003`

- **Duplicate hostnames** (e.g., `foo.com,foo.com,bar.com`):
  - Duplicates are automatically removed: `foo.com,bar.com`
  - Behaves the same as if unique hostnames were provided
  - Only the first occurrence of each hostname is used

If certificate acquisition fails (e.g., DNS not configured, rate limits hit), the
certbot-launcher service will exit gracefully and kettles will run without HTTPS
support. Kettles remain accessible via HTTP on ports 3001, 3002, etc.

**Note**: Let's Encrypt limits a domain to 50 certificates/week by default.
A new certificate is obtained at each VM boot, so avoid frequent reboots in
production.
