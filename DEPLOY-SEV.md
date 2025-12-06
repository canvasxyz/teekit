# AMD SEV-SNP Verification

```
gcloud compute instances create gcp-sev-vm \
      --machine-type=n2d-standard-2 \
      --zone=us-central1-a \
      --confidential-compute-type=SEV_SNP \
      --maintenance-policy=TERMINATE \
      --image-family=ubuntu-2404-lts-amd64 \
      --image-project=ubuntu-os-cloud \
      --boot-disk-size=25GB \
      --min-cpu-platform="AMD Milan"
```
