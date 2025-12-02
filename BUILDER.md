## TDX Image Build Instructions

This document covers how to build the @teekit VM image, and set up a
builder machine that you can use for development or customizing the
VM image for your own purposes.

### Requirements

- A GCP or Azure account

### Setup

First, set up a build machine with --enable-nested-virtualization so
we have KVM acceleration enabled in the machine.

```
# For GCP:
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

# For Azure:
az vm create \
      --resource-group tdx-group \
      --name azure-builder \
      --image Canonical:ubuntu-24_04-lts:server:latest \
      --size Standard_D4s_v3 \
      --admin-username azureuser \
      --generate-ssh-keys \
      --os-disk-size-gb 300
```

SSH into the VM:

```
# For GCP:
gcloud compute ssh gcp-builder

# For Azure:
az ssh vm --resource-group tdx-group --name azure-builder
```

Clone the repo:

```
umask 0022
git clone https://github.com/canvasxyz/teekit.git
cd teekit
```

Use the setup script to install required packages. You can also follow
the script to install each dependency separately. The packages include
build tools, qemu, nvm, node, homebrew, lima, and sqld.

```
./scripts/setup.sh
```

### Building

```
cd packages/images
npm run build:vm
```

It should take 20-30 minutes to build the base image, and then ~5-7
minutes for each additional mkosi profile, if you want to build images
for GCP, Azure, and/or debugging.

```
npm run build:vm:all
```

Now you should have images inside the `build/` directory. To test,
you can start qemu:

```
scripts/test_local.sh
```

This will start qemu with the tdx-debian image, and bind a serial
console which you can use to watch the machine boot. If you have used
a `devtools` profile, it will also start an ssh server on port 2222.

### Accessing the machine (when using `devtools`)

```
# In a separate terminal:
socat - UNIX-CONNECT:/tmp/qemu-teekit-serial.sock

# After the system has booted:
curl http://localhost:8080/uptime
```
