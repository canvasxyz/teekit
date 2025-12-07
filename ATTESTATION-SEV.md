# SEV-SNP Verification

This assumes you have a Google Cloud account.

## Install gcloud SDK

Instructions: https://cloud.google.com/sdk/docs/install-sdk

Check Python version (see instructions):

```
% python3 -V
Python 3.13.1
```

Download and install `gcloud`:

```
wget https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-darwin-arm.tar.gz
tar -vxzf google-cloud-cli-darwin-arm.tar.gz
./google-cloud-sdk/install.sh  # Select yes when prompted to update $PATH
source ~/.zshrc                # Or .bashrc, etc.
```

Sign in interactively with your GCP account, and select or create a project.

(If you get signed out, run `gcloud auth login`. By default, sessions
will expire after 24 hours.)

```
gcloud init
```

Configure the default zone to `us-central1-a`.

If you have to select a new name or change any other configuration
settings, run the `gcloud init` command again.

---

## Creating a TDX VM

We are going to create a VM with these configuration options:

- Machine type: n2d-standard-2
- Zone: us-central1-a
- Confidential compute type: SEV-SNP
- Maintenance policy: TERMINATE
- Image family: ubuntu-2204-lts
- Image project: ubuntu-os-cloud
- Disk size: 25GB (instead of default 10GB)

```
gcloud compute instances create gcp-sev-vm \
      --machine-type=n2d-standard-2 \
      --zone=us-central1-a \
      --confidential-compute-type=SEV_SNP \
      --maintenance-policy=TERMINATE \
      --image-family=ubuntu-2204-lts \
      --image-project=ubuntu-os-cloud \
      --min-cpu-platform="AMD Milan" \
      --boot-disk-size=25GB
```

This should give you output like:

```
Created [https://www.googleapis.com/compute/v1/projects/sev-1-468104/zones/us-central1-a/instances/gcp-sev-vm].
NAME        ZONE           MACHINE_TYPE   PREEMPTIBLE  INTERNAL_IP  EXTERNAL_IP    STATUS
gcp-sev-vm  us-central1-a  n2d-standard-2              10.128.0.2   35.222.15.208  RUNNING
```

If you want to remove the VM when you're done (this takes about 30-60 seconds):

```
gcloud compute instances delete gcp-sev-vm
```

If you want to see running VMs:

```
gcloud compute instances list
```

## Connecting to the VM

To connect to the VM:

```
gcloud compute ssh gcp-sev-vm
```

This will provision an SSH key, add it to the project metadata, and
restart the machine allowing SSH.

This does not affect the machine's measurement, since the SSH key is
provided by a Google metadata service over private networking.

Check that SEV-SNP is present:

```
ls /dev/sev-guest
```

## Installing the Attestation Client

```
wget https://github.com/virtee/snpguest/releases/download/v0.10.0/snpguest
```

Check that the client has been successfully downloaded:

```
./snpguest
```

## Attestation

Fill request-data.bin with random report data, and then request an attested report:

```
./snpguest report attestation-report.bin request-data.bin --random
./snpguest display report attestation-report.bin
```

Fetch VCEK, ASK, ARK certificates:

```
mkdir /tmp/certs
sudo ./snpguest fetch vcek pem /tmp/certs attestation_report.bin --processor-model Milan
```

```
./snpguest fetch ca pem /tmp/certs Milan
```

## FAQs

#### How do I find my IP address from the command line?

You can query any of these external services:

```
nslookup myip.opendns.com resolver1.opendns.com
```

```
curl ifconfig.me
```

#### How can I increase the disk size?

```
gcloud compute disks resize gcp-sev-vm --size=<NEW_SIZE>GB --zone=us-central1-a
```

```
gcloud compute ssh gcp-sev-vm
sudo growpart /dev/nvme0n1 1
sudo resize2fs /dev/nvme0n1p1
```