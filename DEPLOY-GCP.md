## Deploying to GCP

This document covers how to deploy a @teekit VM image to Google Cloud,
with configuration for Intel TDX Confidential Computing.

_Note: GCP is not supported as a primary deployment platform right now.
These instructions may be incomplete or out of date._

## Setup

To build an image for GCP:

```
scripts/env_wrapper.sh mkosi --force --profile=gcp -I tdx-kettle.conf
```

This creates an image at `build/tdx-debian.tar.gz` which contains a
`disk.raw` file, which is ready to upload to GCP. To launch a container
with it, copy the image back from the VM, create a bucket, and upload:

```
# Option 1: Use SCP
scp -i ~/.ssh/google_compute_engine $USER@$EXTERNAL_IP:~/teekit/packages/images/build/tdx-debian.tar.gz ./tdx-debian.tar.gz

# Option 2: Use SCP and the gcloud CLI
gcloud compute scp gcp-builder:~/teekit/packages/images/build/tdx-debian.tar.gz ./tdx-debian.tar.gz

# The first time you upload images to GCP, create a storage bucket:
gcloud storage buckets create gs://canvas-tdx-images \
  --location=us-central1 \
  --default-storage-class=STANDARD \
  --uniform-bucket-level-access

# Copy to GCP storage:
gcloud storage cp tdx-debian.tar.gz gs://canvas-tdx-images

# Delete any previous VM image:
gcloud compute images delete tdx-debian --quiet

# Create a new image:
gcloud compute images create tdx-debian \
  --source-uri gs://canvas-tdx-images/tdx-debian.tar.gz \
  --storage-location=us-central1 \
  --guest-os-features=UEFI_COMPATIBLE,VIRTIO_SCSI_MULTIQUEUE,GVNIC,TDX_CAPABLE

# Delete any previous VM:
gcloud compute instances delete gcp-tdx-vm --quiet --zone us-central1-a
```

Create firewall rules before creating the VM:

```
gcloud compute firewall-rules create allow-ports \
    --direction=INGRESS \
    --priority=1000 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:80,tcp:443,tcp:3000,tcp:3001,tcp:8080,tcp:8090 \
    --source-ranges=0.0.0.0/0 \
    --target-tags=gcp-tdx-vm
```

To start a GCE VM, first create a manifest.json, and then encode it as base64.

If we have built the kettle and kettle artifacts in packages/images,
this will encode a default manifest, pointing to an app.js embedded in the VM:

```
export MANIFEST=$(base64 -i packages/images/kettle-artifacts/manifest.json | tr -d '\n')

# Result should be: ewogICJhcHAiOiAiZmlsZTovLy9saWIva2V0dGxlL2FwcC5qcyIsCiAgInNoYTI1NiI6ICI1NzcxZTE5YWI0MGFlNDM1ZjVkZTM2MTNiNWMxZDg1MDQzYjI3ZGE2YjM0YmY3YmE0MDI5ZjA0NDcxZTg0ZGQ4Igp9Cg
```

Then, start the VM:

```
gcloud compute instances create gcp-tdx-vm \
    --image=tdx-debian \
    --machine-type=c3-standard-4 \
    --zone=us-central1-a \
    --confidential-compute-type=TDX \
    --maintenance-policy=TERMINATE \
    --boot-disk-size=200GB \
    --tags=gcp-tdx-vm \
    --metadata=manifest="$MANIFEST"
```

You can also set the manifest later:

```
gcloud compute instances add-metadata gcp-tdx-vm --metadata=manifest="$MANIFEST"
gcloud compute instances reset gcp-tdx-vm
```

To wait for the machine to boot, you can check for output on the serial port:

```
gcloud compute instances tail-serial-port-output gcp-tdx-vm
```

Then, check the VM is working:

```
export EXTERNAL_IP=$(gcloud compute instances describe gcp-tdx-vm \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
echo gcp-tdx-vm is at $EXTERNAL_IP
curl http://$EXTERNAL_IP:8080/uptime
```
