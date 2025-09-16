# TDX Verification

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

- Machine type: c3-standard-4
- Zone: us-central1-a
- Confidential compute type: TDX
- Maintenance policy: TERMINATE
- Image family: ubuntu-2204-lts
- Image project: ubuntu-os-cloud

```
gcloud compute instances create gcp-tdx-vm \
      --machine-type=c3-standard-4 \
      --zone=us-central1-a \
      --confidential-compute-type=TDX \
      --maintenance-policy=TERMINATE \
      --image-family=ubuntu-2204-lts \
      --image-project=ubuntu-os-cloud
```

This should give you output like:

```
Created [https://www.googleapis.com/compute/v1/projects/tdx-1-468104/zones/us-central1-a/instances/gcp-tdx-vm].
NAME        ZONE           MACHINE_TYPE   PREEMPTIBLE  INTERNAL_IP  EXTERNAL_IP    STATUS
gcp-tdx-vm  us-central1-a  c3-standard-4               10.128.0.2   35.222.15.208  RUNNING
```

If you want to remove the VM when you're done (this takes about 30-60 seconds):

```
gcloud compute instances delete gcp-tdx-vm
```

## Connecting to the VM

To connect to the VM:

```
gcloud compute ssh gcp-tdx-vm
```

This will provision an SSH key, add it to the project metadata, and
restart the machine allowing SSH.

This does not affect the TDX measurement, since the SSH key is
provided by a Google metadata service over private networking.

Check that TDX is working:

```
sudo dmesg | grep -i tdx
```

This should print `Memory Encryption Features active: Intel TDX`:

```
$ sudo dmesg | grep -i tdx
[    0.000000] tdx: Guest detected
[    1.404759] process: using TDX aware idle routine
[    1.404759] Memory Encryption Features active: Intel TDX
```

## Installing the Attestation Client

```
sudo apt update
sudo apt install -y golang-go
```

Check that Go is installed:

```
go version
```

```
go version go1.18.1 linux/amd64
```

Install the attestation client:

```
curl -sL https://raw.githubusercontent.com/intel/trustauthority-client-for-go/main/release/install-tdx-cli.sh | sudo bash -
```

Check that the attestation client is installed:

```
trustauthority-cli version
```

```
Intel® Trust Authority CLI
Version: v1.10.0-eb394ed
Build Date: 2025-06-23
```

Now we must configure the attestation client.

Go to https://portal.trustauthority.intel.com/login and register
an account. This requires sending an email to Intel Trust Authority
to get an API key. For full instructions see:

https://docs.trustauthority.intel.com/main/articles/articles/ita/howto-manage-subscriptions.html

Now configure the API key, by creating config.json in your home directory:

```
touch config.json
cat <<EOF> config.json
{
   "trustauthority_api_url": "https://api.trustauthority.intel.com",
   "trustauthority_api_key": "<attestation api key>"
}
EOF
```

## Obtaining an Attestation

```
sudo trustauthority-cli evidence --tdx -c config.json
```

```
[DEBUG] GET https://api.trustauthority.intel.com/appraisal/v2/nonce
{
  "tdx": {
     "runtime_data": null,
     "quote": "BA...",
     "event_log": "W3...",
     "verifier_nonce": {
        "val": "cV...Q==",
        "iat": "M...EM=",
        "signature": "vc...L"
        }
     }
}
```

```
$ sudo trustauthority-cli token -c config.json
Trace Id: PkSuTGpKoAMEIPQ=
Request Id: 2d91b0a5-f26d-4348-83a6-c8a4cead1ca7
eyJhb...
```

## Verifying an Attestation

```
sudo trustauthority-cli evidence --tdx -c config.json > attestation.json
```
