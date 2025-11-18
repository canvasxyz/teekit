## TDX Image Deployment - Azure

We assume you have logged into the Azure CLI and/or Google Cloud CLI,
and already have a builder machine set up. If not, see the other
instruction pages on how to run `az login` and set up a builder.
(TODO: These are GCP instructions, add Azure instructions later.)

Get the builder machine's IP address:

```
gcloud compute instances list --filter="name=gcp-builder" --format="get(networkInterfaces[0].accessConfigs[0].natIP)"

export EXTERNAL_IP=<...>
```

Copy the VHD image from the builder to your local machine:

```
scp -i ~/.ssh/google_compute_engine $USER@$EXTERNAL_IP:~/teekit/packages/images/build/tdx-debian.vhd ./tdx-debian.vhd
```

If you have have specified user/pass authentication, use your password
instead. Or, you may be able to use the gcloud scp:

```
gcloud compute scp \
  --project gcp-builder \
  --zone us-central1-a \
  "gcp-builder:~/teekit/packages/images/build/tdx-debian.vhd" \
  ./tdx-debian.vhd
```

Create a storage account. This must have a globally unique name:

```
export STORAGE_ACCT=tdx$(openssl rand -hex 6)

az storage account create \
  --name $STORAGE_ACCT \
  --resource-group tdx-group \
  --sku Standard_LRS
```

Create a container called `vhds`.

```
az storage container create \
  --account-name $STORAGE_ACCT \
  --name vhds
```

Assign yourself permissions to interact with the storage container.

```
export MY_ID=$(az ad signed-in-user show --query id -o tsv)
export SA_ID=$(az storage account show -n $STORAGE_ACCT -g tdx-group --query id -o tsv)

az role assignment create \
  --assignee $MY_ID \
  --role "Storage Blob Data Owner" \
  --scope $SA_ID
```

Now you can upload the VHD image as a blob:

```
az storage blob upload \
  --account-name $STORAGE_ACCT \
  --container-name vhds \
  --name tdx-debian.vhd \
  --file tdx-debian.vhd \
  --type page \
  --auth-mode login
```

Create an Azure Compute Gallery (required for Confidential VMs):

**Note:** Managed Images (`az image create`) are not supported for Confidential VMs. You must use Azure Compute Gallery instead.

```
az sig create \
  --resource-group tdx-group \
  --gallery-name tdxGallery
```

Create an image definition:

```
az sig image-definition create \
  --resource-group tdx-group \
  --gallery-name tdxGallery \
  --gallery-image-definition tdx-debian \
  --publisher TeeKit \
  --offer tdx-debian \
  --sku 1.0 \
  --os-type Linux \
  --os-state Generalized \
  --hyper-v-generation V2 \
  --features SecurityType=ConfidentialVmSupported
```

Create an image version from the VHD blob:

```
az sig image-version create \
  --resource-group tdx-group \
  --gallery-name tdxGallery \
  --gallery-image-definition tdx-debian \
  --gallery-image-version 1.0.0 \
  --os-vhd-uri "https://${STORAGE_ACCT}.blob.core.windows.net/vhds/tdx-debian.vhd" \
  --os-vhd-storage-account $STORAGE_ACCT
```

Create a VM from the gallery image:

```
az vm create \
  --name tdx-kettle \
  --resource-group tdx-group \
  --security-type ConfidentialVM \
  --os-disk-security-encryption-type DiskWithVMGuestState \
  --image /subscriptions/$(az account show --query id -o tsv)/resourceGroups/tdx-group/providers/Microsoft.Compute/galleries/tdxGallery/images/tdx-debian/versions/1.0.0 \
  --size Standard_DC2es_v5 \
  --enable-secure-boot true \
  --enable-vtpm true
```

Get the new VM's public IP address:

```
gcloud compute instances list --filter="name=tdx-kettle" --format="get(networkInterfaces[0].accessConfigs[0].natIP)"

export KETTLE_IP=<...>
```

Check for running services:

```
curl http://${$KETTLE_IP}/uptime
```

To get a serial console to monitor the machine, you can also use:

```
az extension add --name serial-console --upgrade
az serial-console connect \
  --name tdx-kettle \
  --resource-group tdx-group

# Alternatively, if boot diagnostics need to be enabled:
az vm boot-diagnostics enable \
    --name tdx-kettle \
    --resource-group tdx-group
```