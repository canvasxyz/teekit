# Canonical TDX Build

This guide covers building an Ubuntu image, using the
[canonical/tdx](https://github.com/canonical/tdx) repository.

```
gcloud compute ssh gcp-tdx-vm
```

You should have 25GB of space to build a TD guest image.
Use `df -m` to check if you're not sure.

First clone the canonical/tdx package.

We will preinstall packages needed by create-td-image.sh (since the
script doesn't show progress when installing packages).

```
git clone https://github.com/canonical/tdx.git
sudo apt install --yes qemu-utils libguestfs-tools virtinst genisoimage libvirt-daemon-system isc-dhcp-client
```

Now the script will download an Ubuntu 24.04 image, and convert it to
a TDX guest image.

This happens in two stages:

In the first stage, we use Ubuntu's built in cloudinit, to boot from a
cloudinit ISO image that configures networking, basic packages
(e.g. Python), root passwords, etc. The cloudinit scripts updates the
disk, and then we power off the VM.

In the second stage, we install the TDX kernel, other linux modules,
the tdx-tools CLI, and other drivers, e.g. Ollama, Kobuk.

In total, running the script will take a while (~15 min in tests).

```
cd tdx/guest-tools/image/
sudo ./create-td-image.sh -v 24.04 -s 20
```

Now we should have an image.

```
cd
sha256sum /home/tdx-user/tdx/guest-tools/image/tdx-guest-ubuntu-24.04-generic.qcow2
```

Convert it to a GCE-compatible disk image:

```
qemu-img convert -f qcow2 -O raw tdx-guest-ubuntu-24.04-generic.qcow2 disk.raw
qemu-img info disk.raw
```

This should show the size:

```
image: disk.raw
file format: raw
virtual size: 104 GiB (111132278784 bytes)
disk size: 4.6 GiB
```

Now tarball and gzip it:

```
tar -Szcf disk.tar.gz disk.raw
```

Copy the image back from the VM:

```
gcloud compute scp gcp-tdx-vm:/home/tdx-user/disk.tar.gz ./disk.tar.gz
```

Create a bucket:

```
gcloud storage buckets create gs://canvas-tdx-images \
  --location=us-central1 \
  --default-storage-class=STANDARD \
  --uniform-bucket-level-access
```

Upload the image to the bucket:

```
gcloud storage cp disk.tar.gz gs://canvas-tdx-images
```

Import into GCE as an image:

```
gcloud compute images create tdx-ubuntu-2404 \
  --source-uri gs://canvas-tdx-images/disk.tar.gz \
  --storage-location=us-central1 \
  --guest-os-features=UEFI_COMPATIBLE,VIRTIO_SCSI_MULTIQUEUE,GVNIC,TDX_CAPABLE
```

Start a TDX VM with the image:

```
gcloud compute instances create gcp-tdx-vm2 \
      --image=tdx-ubuntu-2404 \
      --machine-type=c3-standard-4 \
      --zone=us-central1-a \
      --confidential-compute-type=TDX \
      --maintenance-policy=TERMINATE \
      --boot-disk-size=25GB
```

SSH into the machine:

```
gcloud compute ssh root@gcp-tdx-vm2
```

Enter the password that you provided earlier.