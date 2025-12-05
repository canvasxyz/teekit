# Getting Started: TDX VM on Azure

This guide walks you through setting up a TDX (Trust Domain Extensions)
VM on Azure and running your own application inside it.

## What You Get

A TDX VM provides hardware-enforced isolation for your
application. Code running inside cannot be observed or tampered with,
even by the cloud provider. Clients can cryptographically verify
they're talking to your exact code via remote attestation.

## Overview

1. Set up a builder machine
2. Build the TDX VM image
3. Write your app.ts
4. Deploy to Azure
5. Test your deployment

---

## Prerequisites

- Azure CLI installed and authenticated (`az login`)
- A GCP or Azure VM for building images (nested virtualization required)
- Node.js 20+

---

## Step 1: Set Up a Builder Machine

The image build requires a Linux VM with nested virtualization. Create one:

```bash
# Azure
az vm create \
  --resource-group tdx-group \
  --name azure-builder \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --size Standard_D4s_v3 \
  --admin-username azureuser \
  --generate-ssh-keys \
  --os-disk-size-gb 300

# SSH in
az ssh vm --resource-group tdx-group --name azure-builder
```

Clone the repository and install dependencies:

```bash
umask 0022
git clone https://github.com/canvasxyz/teekit.git
cd teekit
./scripts/setup.sh
```

---

## Step 2: Build the TDX VM Image

```bash
cd packages/images
npm run build:az
```

This takes 20-30 minutes and produces:
- `build/tdx-debian-azure.efi` — UEFI kernel image
- `build/tdx-debian-azure.vhd` — Azure VHD (30GB)

---

## Step 3: Write Your Application

Create your `app.ts` using the Hono framework. Your app runs inside
the TDX enclave and is served via the @teekit/kettle runtime, which
is based on V8 / workerd.

### Minimal Example

```typescript
import { Hono } from "hono"
import { cors } from "hono/cors"
import { upgradeWebSocket } from "hono/cloudflare-workers"
import { TunnelServer } from "@teekit/tunnel"
import type { Env } from "@teekit/kettle/worker"

const app = new Hono<{ Bindings: Env }>()
app.use("/*", cors())

// Initialize TunnelServer for remote attestation
const { wss } = await TunnelServer.initialize(
  app,
  async () => {
    // In production, this returns the real TDX quote
    const { tappdV4Base64 } = await import("@teekit/tunnel/samples")
    const buf = Uint8Array.from(atob(tappdV4Base64), (ch) => ch.charCodeAt(0))
    return { quote: buf }
  },
  { upgradeWebSocket },
)

// Your routes
app.get("/hello", (c) => c.json({ message: "Hello from TDX!" }))

app.get("/uptime", (c) => {
  return c.json({ uptime: process.uptime() })
})

export default app
```

### Key Concepts

| Component | Purpose |
|-----------|---------|
| `Hono` | Web framework (Cloudflare Workers-compatible) |
| `TunnelServer` | Handles remote attestation and encrypted channels |
| `wss` | WebSocket server for real-time connections |
| `Env` | Environment bindings (DB, quote service, etc.) |

### Available Features

- **HTTP routes** — Standard REST endpoints via Hono
- **WebSockets** — Real-time bidirectional communication
- **Database** — SQLite via libsql (`getDb(c.env)`)
- **Attestation** — TDX quotes bound to your app's public key

---

## Step 4: Create a Manifest

The manifest tells the VM which application to run:

```json
{
  "app": "file:///usr/lib/kettle/app.js",
  "sha256": "<sha256-of-your-app.js>"
}
```

Generate the SHA256:
```bash
sha256sum app.js | awk '{print $1}'
```

The manifest can reference:
- `file://` — App bundled in the VM image
- `https://` — App fetched at boot from a URL

---

## Step 5: Deploy to Azure

First, we have to deploy the VM image to Azure (before we can configure it).

```bash
cd packages/images
npm run deploy:az
```

The deploy script handles everything: storage account, gallery, image upload, and VM creation.
Alternatively, see [DEPLOY-AZURE.md](../DEPLOY-AZURE.md) for step-by-step commands.

Once your VM has started, configure it:

- `trustauthority_api_key` should be configured with your Intel Trust Authority API key.
- `hostname` should be configured with a host whose DNS is already pointing to your VM's public IP.
- `manifest` should be configured with a base64 encoded copy of your manifest.

You must restart your VM once you've configured metadata tags.

```bash
MANIFEST_B64=$(base64 -w0 manifest.json)

az vm update \
  --name my-tdx-app \
  --resource-group tdx-group \
  --set tags.manifest="$MANIFEST_B64" \
    tags.hostname="example.com" \
    tags.trustauthority_api_key="djE6..." \

az vm restart \
  --name my-tdx-app \
  --resource-group tdx-group
```

---

## Step 6: Test Your Deployment

Get the VM's public IP:

```bash
az vm show \
  --name my-tdx-app \
  --resource-group tdx-group \
  --show-details \
  --query publicIps -o tsv
```

Test the endpoints:

```bash
# Health check
curl http://<VM_IP>:3001/uptime

# Your custom route
curl http://<VM_IP>:3001/hello

# With HTTPS (if hostname configured)
curl https://myapp.example.com/hello
```

---

## Local Testing

You can test your image locally, using qemu, before deploying:

```bash
cd packages/images
npm run test:local
```

This boots the VM in QEMU with:
- Kettle service on `http://localhost:3001`
- Metadata service on `http://localhost:8090`

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Client                             │
│  1. Connect to TDX VM                                       │
│  2. Receive attestation quote                               │
│  3. Verify quote (proves code integrity)                    │
│  4. Establish encrypted channel                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   Azure Confidential VM                     │
│                   (Standard_DC2es_v5)                       │
├─────────────────────────────────────────────────────────────┤
│  TDX Hardware Isolation                                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  kettle runtime                                       │  │
│  │  ├── Your app.ts (port 3001)                          │  │
│  │  ├── TunnelServer (attestation + encryption)          │  │
│  │  └── libsql database                                  │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  nginx (optional, for HTTPS)                          │  │
│  │  └── Reverse proxy with Let's Encrypt certs           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

### Check service logs

```bash
# Via Azure serial console
az serial-console connect --name my-tdx-app --resource-group tdx-group

# Inside the VM
journalctl -u kettle-launcher.service
journalctl -u cloud-launcher.service
cat /var/log/kettle.log
```

### Verify manifest loaded

```bash
cat /etc/kettle/cloud-launcher.env
```

### HTTPS not working

1. Confirm DNS resolves: `dig +short myapp.example.com`
2. Check certbot logs: `journalctl -u certbot-launcher.service`
3. HTTP fallback works: `curl http://<VM_IP>:3001/uptime`
