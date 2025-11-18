## TDX Image Deployment - GCP

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

To start a GCE VM, first create a manifest.json, and then encode it as base64.

If we have built the kettle and kettle artifacts in packages/images,
this will encode a default manifest, pointing to an app.js embedded in the VM:

```
export MANIFEST=$(base64 -i packages/images/kettle-artifacts/manifest.json | tr -d '\n')

# Result should be: ewogICJhcHAiOiAiZmlsZTovLy91c3IvbGliL2tldHRsZS9hcHAuanMiLAogICJzaGEyNTYiOiAiNTc3MWUxOWFiNDBhZTQzNWY1ZGUzNjEzYjVjMWQ4NTA0M2IyN2RhNmIzNGJmN2JhNDAyOWYwNDQ3MWU4NGRkOCIKfQ==
```

Then, start the VM:

```
gcloud compute instances create gcp-tdx-vm \
    --image=tdx-debian \
    --machine-type=c3-standard-4 \
    --zone=us-central1-a \
    --confidential-compute-type=TDX \
    --maintenance-policy=TERMINATE \
    --boot-disk-size=200GB
    --metadata=manifest="$MANIFEST"
```

To set the manifest later, you can also run:

```
gcloud compute instances add-metadata gcp-tdx-vm \
    --metadata=manifest="$MANIFEST"
gcloud compute instances reset gcp-tdx-vm
```

Assuming you haven't created firewall rules for the group yet, do so now:

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

Then, attach the firewall rules to the new VM:

```
gcloud compute instances add-tags gcp-tdx-vm --tags gcp-tdx-vm
```

Wait for the firewall rules to be applied. Then, check the VM is working:

```
export EXTERNAL_IP=$(gcloud compute instances describe gcp-tdx-vm \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
curl http://$EXTERNAL_IP:8080/uptime
```

For troubleshooting, check for output on the serial port:

```
gcloud compute instances get-serial-port-output gcp-tdx-vm
```

Or, to tail the output:

```
gcloud compute instances tail-serial-port-output gcp-tdx-vm
```
