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

Clone the repo:

```
umask 0022
git clone https://github.com/flashbots/flashbots-images.git
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

Now we should have an image at `build/tdx-debian`.

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

Let's validate the checksum:

```
user@gcp-builder:~/flashbots-images$ sha256sum build/tdx-debian
4841e00a8cbac1194ab327ddc1d0183d061ed272590b937ec6ca34d542552745  build/tdx-debian
```

You can also try running the build again to verify determinism.

To get measurements:

```
make measure
EFI Boot Stages:
  Stage 1 - Unified Kernel Image (UKI): cfe890156ef32a40263449f28cab9b5c0aa10241ebbd66cb87c1e18de653eb6d
  Stage 2 - Linux                     : 62d9abd973301959f45028c2f4ebb0fb86916bd06a05a84ba4bb21e5f1e49ad6
Linux LOAD_FILE2 protocol:
  cmdline: "console=tty0 console=ttyS0,115200n8 mitigations=auto,nosmt spec_store_bypass_disable=on nospectre_v2\x00"
  initrd (digest b9221077a3a5040de85638670dc1605b0c1344b0ec48206a568bc1ac93c3a4f0)
UKI sections:
  Section  1 - .linux   (   5841920 bytes):     0da293e37ad5511c59be47993769aacb91b243f7d010288e118dc90e95aaef5a, 3e5905ab13fa49d219421866f77ac05cbddd0e957c595c5dae53c8ace839eaaf
  Section  2 - .osrel   (       308 bytes):     3fb9e4e3cc810d4326b5c13cef18aee1f9df8c5f4f7f5b96665724fa3b846e08, 2be74762aa695cdc80776331acb66172903f83ceaa7412183483ee2537a4f77c
  Section  3 - .cmdline (       101 bytes):     461203a89f23e36c3a4dc817f905b00484d2cf7e7d9376f13df91c41d84abe46, 5b20d03fb990ccafdcfa1ddb37feff37141e728776ed89f335798f3c3899a135
  Section  4 - .initrd  (  34221859 bytes):     15ee37e75f1e8d42080e91fdbbd2560780918c81fe3687ae6d15c472bbdaac75, b9221077a3a5040de85638670dc1605b0c1344b0ec48206a568bc1ac93c3a4f0
  Section  5 - .uname   (         7 bytes):     da7a6d941caa9d28b8a3665c4865c143db8f99400ac88d883370ae3021636c30, 2200d673ad92228af377b9573ed86e7a4e36a87a2a9a08d8c1134aca3ddb021c
  Section  6 - .sbat    (       309 bytes):     ff552fd255be18a3d61c0da88976fc71559d13aad12d1dfe1708cf950cc4b74c, eae67f3a8f5614d71bd75143feeecbb3c12cd202192e2830f0fb1c6df0f4a139
  Section  7 - .data   :        not measured
  Section  8 - .reloc  :        not measured
  Section  9 - .rodata :        not measured
  Section 10 - .sdmagic:        not measured
  Section 11 - .text   :        not measured
PCR[ 4]: be0be2401a90819477ddf9f1d55d361d49e15be0209765dff092484d4f8a5131
PCR[ 9]: 0798c8399d7e3bb23db8e67cc4ba442f7a884d5f81b7a7b49dd214f31e69dc34
PCR[11]: bb722a61c8eb6c1984791e7fb034ab781a57ae4cbf5591cac99397050ee36563
PCR[12]: 0000000000000000000000000000000000000000000000000000000000000000
PCR[13]: 0000000000000000000000000000000000000000000000000000000000000000
PCR[15]: 0000000000000000000000000000000000000000000000000000000000000000
Note: Lima VM is still running. To stop it, run: limactl stop tee-builder
echo "Measurements exported to build/measurements.json"
Measurements exported to build/measurements.json
```

We can try running it in qemu:

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

Since we're not running on a TDX machine, this will fail with an error,
but it's enough to confirm that the server is working. Use C-a x to quit
once you're done.

Now, let's make builds for GCP and Azure.

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

# Open port 80 and 443:
gcloud compute firewall-rules create allow-http-80 \
    --direction=INGRESS \
    --priority=1000 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:80 \
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

Check the VM is working:

```
curl http://<external_ip>/attest/48656c6c6f20576f726c64
```

```
gcloud compute instances get-serial-port-output gcp-tdx-vm2
```
