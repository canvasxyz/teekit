## Flashbots Base Images Build

Set up a build machine. This uses Ubuntu 24.04 so we have systemd 250+:

```
gcloud compute instances create gcp-builder \
      --enable-nested-virtualization \
      --machine-type=c3-standard-4 \
      --zone=us-central1-a \
      --image-family=ubuntu-2404-lts-amd64 \
      --image-project=ubuntu-os-cloud \
      --boot-disk-size=200GB
```

SSH into the VM:

```
gcloud compute ssh gcp-builder
```

Enable KVM virtualization for the build VM, and then log out, and log
in again.

```
sudo usermod -aG kvm $USER
```

We are using a slightly modified version of the Flashbots mkosi build
scripts, to create a reproducible build based on Debian 13 (see
base/base.conf: `Distribution=debian, Release=trixie`).

Clone the base images:

```
umask 0022
git clone https://github.com/canvasxyz/flashbots-images.git
cd flashbots-images
```

Install make, qemu-utils, and nix:

```
sudo apt update
sudo apt install -y make qemu-utils qemu-system-x86
NONINTERACTIVE=1 ./scripts/setup_deps.sh
. ~/.nix-profile/etc/profile.d/nix.sh
```

Install homebrew:

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

echo >> ~/.bashrc
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.bashrc
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
```

Install lima:

```
brew install lima
```

At this point, you may have to edit `scripts/env_wrapper.sh:105` to
allow git to use the ~/mnt directory inside the tee-builder image.

```
- lima_exec "cd ~/mnt && /home/debian/.nix-profile/bin/nix develop -c ${cmd[*]@Q}"
+ lima_exec "cd ~/mnt && git config --global --add safe.directory ~/mnt &&
+ /home/debian/.nix-profile/bin/nix develop -c ${cmd[*]@Q}"
```

Now build in the container:

```
make build IMAGE=tdx-dummy
```

Now you should have an image at `build/tdx-debian`.

```
‣  Running finalize script /home/debian/mnt/base/debloat.sh…
‣  Normalizing modification times of /.
‣  Normalizing modification times of /boot
‣  Normalizing modification times of /efi
‣  Creating cpio archive /var/tmp/mkosi-workspace-wu7z8m2m/initrd…
‣  Compressing /var/tmp/mkosi-workspace-wu7z8m2m/initrd with zstd
‣  Generating unified kernel image for kernel version 6.13.12
Wrote unsigned /work/var/tmp/mkosi-workspace-wu7z8m2m/staging/tdx-debian.efi
‣  Saving manifest tdx-debian.manifest
‣  /home/debian/mkosi-output/tdx-debian.efi size is 38.3M, consumes 38.3M.
Check ./build/ directory for output files
```

Validate the checksum:

```
user@gcp-builder:~/flashbots-images$ sha256sum build/tdx-debian
d57a99ba68597673ea4f831f39793a07f958547e359107f0d31b56c186a06354  build/tdx-debian
```

You can also try running the build again to verify determinism.

If you need to debug, try running it in qemu:

```

sudo qemu-system-x86_64 \
    -enable-kvm \
    -machine type=q35,smm=on \
    -m 4096M \
    -nographic \
    -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd \
    -drive file=/usr/share/OVMF/OVMF_VARS_4M.fd,if=pflash,format=raw \
    -kernel build/tdx-debian.efi \
    -netdev user,id=net0,hostfwd=tcp::2222-:22,hostfwd=tcp::8080-:8080 \
    -device virtio-net-pci,netdev=net0 \
    -device virtio-scsi-pci,id=scsi0 \
    -drive file=persistent.qcow2,format=qcow2,if=none,id=disk0 \
    -device scsi-hd,drive=disk0,bus=scsi0.0,channel=0,scsi-id=0,lun=10

# In a separate terminal:
curl http://localhost:8080/attest/48656c6c6f20576f726c64
```

Without running inside a TDX VM, this will fail with an error, but
it's enough to confirm that the server is working. Use C-a x to quit.

Now, we'll make builds for GCP and Azure.

## GCP

To build an image for GCP:

```
scripts/env_wrapper.sh mkosi --force --profile=gcp -I tdx-dummy.conf
```

This creates an image at `build/tdx-debian.tar.gz` which contains a
`disk.raw` file, which is ready to upload to GCP. To launch a container
with it, copy the image back from the VM, create a bucket, and upload
(do all this outside the VM):

```
gcloud compute scp gcp-builder:flashbots-images/build/tdx-debian.tar.gz ./tdx-debian.tar.gz

# The first time you upload images to GCP, create a storage bucket:
gcloud storage buckets create gs://canvas-tdx-images \
  --location=us-central1 \
  --default-storage-class=STANDARD \
  --uniform-bucket-level-access

# Copy to GCP and create an image:
gcloud storage cp tdx-debian.tar.gz gs://canvas-tdx-images
gcloud compute images delete tdx-debian --quiet
gcloud compute images create tdx-debian \
  --source-uri gs://canvas-tdx-images/tdx-debian.tar.gz \
  --storage-location=us-central1 \
  --guest-os-features=UEFI_COMPATIBLE,VIRTIO_SCSI_MULTIQUEUE,GVNIC,TDX_CAPABLE

# Start a GCE VM with the image:
gcloud compute instances delete gcp-tdx-vm2 --quiet --zone us-central1-a
gcloud compute instances create gcp-tdx-vm2 \
      --image=tdx-debian \
      --machine-type=c3-standard-4 \
      --zone=us-central1-a \
      --confidential-compute-type=TDX \
      --maintenance-policy=TERMINATE \
      --boot-disk-size=200GB

# Open ports 80, 8080, and 443:
gcloud compute firewall-rules create allow-http-80 \
    --direction=INGRESS \
    --priority=1000 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:80 \
    --source-ranges=0.0.0.0/0 \
    --target-tags=gcp-tdx-vm
gcloud compute firewall-rules create allow-http-8080 \
    --direction=INGRESS \
    --priority=1000 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:8080 \
    --source-ranges=0.0.0.0/0 \
    --target-tags=gcp-tdx-vm
gcloud compute firewall-rules create allow-https-443 \
    --direction=INGRESS \
    --priority=1000 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:443 \
    --source-ranges=0.0.0.0/0 \
    --target-tags=gcp-tdx-vm
gcloud compute instances add-tags gcp-tdx-vm2 --tags gcp-tdx-vm
```

Wait for the firewall rules to be applied. Then, check the VM is working:

```
curl http://<external_ip>:8080/attest/48656c6c6f20576f726c64
```

For further debug output, check for output on the serial port:

```
gcloud compute instances get-serial-port-output gcp-tdx-vm2
```
