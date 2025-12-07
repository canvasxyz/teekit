# Getting Started

This guide walks you through setting up a Google Cloud VM using
the @teekit kettle, and running your own application inside it.

We use a SEV-SNP VM, which provides hardware-enforced isolation for
your application. Code running inside cannot be observed or tampered
with by the cloud provider. Clients can cryptographically verify
they're talking to your exact code via remote attestation.

Compared to TDX, SEV-SNP is a earlier generation technology that has
been in general availability for longer (~3-4 years vs. ~1-2 years).
It is available on more platforms (including Google Cloud, AWS, Azure)
and has better support for using sealing keys to persisting data.

Tradeoffs include weaker isolation at the hypervisor level, and thus,
a lessened security posture against malicious cloud providers.
However, given that neither Intel nor AMD consider hardware attacks on
memory encryption to be within their security model, we consider
SEV-SNP to be an essentially equivalent technology to Intel TDX.

## Overview

1. Set up a builder machine
2. Build the VM image
3. Deploy the VM image
4. Configure the VM image with metadata
5. Redeploy the VM image
6. Write your app.ts
7. Publish your app.ts
8. Launch your application

## Step 0: Prerequisites

Before you begin, you should have the GCP CLI installed, and you
should be authenticated (`gcloud auth login`). If not, use the link
later in this step to install the CLI.

(If you get signed out, run `gcloud auth login`. By default, sessions
will expire after 24 hours.)

You should also have the Kettle CLI installed. Either install the
latest version from NPM, or use a local build:

```
npm install -g @teekit/kettle

# Install a local build from the workspace root:
npm i
npm run build
./install.sh
```

## Step 1: Set Up a Builder Machine

First, create a builder machine with nested virtualization turned on.

```
gcloud compute instances create gcp-builder \
      --enable-nested-virtualization \
      --machine-type=c3-standard-4 \
      --zone=us-central1-a \
      --image-family=ubuntu-2404-lts-amd64 \
      --image-project=ubuntu-os-cloud \
      --boot-disk-size=300GB \
      --metadata=startup-script='#!/bin/bash
        # Add default user to kvm group
        usermod -aG kvm $(logname)
      '
```

SSH into the machine:

```
gcloud compute ssh gcp-builder
```

Install the gcloud CLI inside the builder machine, following the
instructions at https://cloud.google.com/sdk/docs/install-sdk.

```
gcloud auth login
```

Clone the repository and install dependencies.

```
umask 0022
git clone https://github.com/canvasxyz/teekit.git
cd teekit
./scripts/setup.sh
```

## Step 2: Build the VM Image

```
cd packages/images
npm run build:gcp:devtools
```

This will take 20-30 minutes and produces a GCP image at
`build/kettle-vm-devtools.tar.gz`.

## Step 3: Deploy the VM Image

This will deploy your VM to Google Cloud using the smallest SEV-SNP VM
(2 vCPUs, currently ~$66/month).

```
npm run deploy:gcp:devtools --sev-snp
```

## Step 4: Configure the VM Image with Metadata

Once your VM has started, configure it:

- `hostname` should be configured with a host whose DNS points to your VM's public IP.
- (optional) `manifest` should be configured with a base64 encoded copy of your app manifest.
- (optional) `trustauthority_api_key` should be configured with an Intel Trust Authority API key.

We provide a config script that uses dynamic DNS to assign your
machine a hostname. Register an account with dynv6.net, and then run:

```
npm run config:gcp
```

This will prompt you for your VM name or IP address, dynv6 API key,
and an Intel Trust Authority key (which we do not need for SEV-SNP
VMs; press Enter to skip).

The script will configure your machine with a hostname on dynv6.net,
and then reboot it and wait for HTTPS to come online. See Troubleshooting
if you encounter any issues.

## Step 5: Redeploy the VM Image (optional)

You may wish to redeploy a different image to this VM later. You can
use a redeploy script to do this, to avoid reconfiguring the machine:

```
# Try a dry run first
scripts/redeploy_gcp.sh --sev-snp my-kettle-vm build/kettle-vm-devtools.tar.gz --dry-run

# Actually redeploy the VM
scripts/redeploy_gcp.sh --sev-snp my-kettle-vm build/kettle-vm-devtools.tar.gz
```

## Step 6: Write Your Application

Create your `app.ts` that will run inside the kettle VM.

You can refer to `packages/kettle/app.ts` as an example. You should
use Hono as the server, and SQLite (sqld) as the database. The
application will run inside a Cloudflare `workerd` runtime.

```
# Run your application locally:
kettle start-worker packages/kettle/app.ts
```

## Step 7: Publish Your Application

When you're done writing your application, publish it to a Github Gist.
This will prompt you for a Github API key (use one scoped to gist creation):

```
kettle publish packages/kettle/app.ts
```

This generates a manifest file of the format:

```
{
  "app": "https://gist.githubusercontent.com/example/4e3442.../app.ts",
  "sha256": "52b50d..."
}
```

Once you have a manifest, you can try launching it locally:

```
kettle launch manifest.json
```

## Step 8: Launch Your Application

Finally, we're ready to deploy your application to a production server!
To configure your VM to run your application, provide the manifest when
running the config script:

```
npm run config:gcp
```

Alternatively, you can also configure the metadata manually, just
make sure to reboot the machine afterwards:

```
VM_NAME=my-kettle-vm
MANIFEST_B64=$(base64 -w0 manifest.json)
gcloud compute instances add-metadata "$VM_NAME" --metadata=manifest=$MANIFEST_B64
gcloud compute instances reset "$VM_NAME"
```

Wait for the reboot to complete, and for HTTPS to come online once
Certbot finishes. You should be able to access your application via
its public IP, or via the hostname that we just set up.

If you're running the default application, try querying the /uptime
endpoint using `curl`. Or, go to packages/demo/src/App.tsx and replace
the remote server with your new hostname.

```
curl http://136.112.93.209:3001/uptime
curl https://136-112-93-209.dynv6.net/uptime
```

## Troubleshooting

### Check serial console

```bash
gcloud compute instances add-metadata my-kettle-vm --metadata=serial-port-enable=true
gcloud compute connect-to-serial-port my-kettle-vm
```

### Check service logs (requires `devtools`)

```bash
gcloud compute ssh my-kettle-vm

# Inside the VM
cat /var/log/kettle.log
cat /var/log/cloud-launcher.log
cat /var/log/certbot-launcher.log
```

### HTTPS not working

1. Confirm DNS resolves: `dig +short myapp.example.com`
2. Check certbot logs: `journalctl -u certbot-launcher.service`
3. HTTP fallback works: `curl http://<VM_IP>:3001/uptime`
