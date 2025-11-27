## TDX Image Deployment - Azure

We assume you have logged into the Azure CLI and/or Google Cloud CLI,
and already have a builder machine set up. If not, see the other
instruction pages on how to run `az login` and set up a builder.

### Prerequisites

Make sure the Azure build completed successfully. The build creates:
- `build/tdx-debian-azure.efi` - The UEFI kernel image
- `build/tdx-debian-azure.vhd` - The Azure VHD disk image (30GB)

The build script verifies the VHD meets Azure's requirements:
- Fixed-size VHD format with proper footer
- Virtual size aligned to 1 MiB boundaries
- EFI System Partition with correct type GUID
- Gen2 UEFI boot compatible

Get the builder machine's IP address:

```
export EXTERNAL_IP=$(gcloud compute instances list --filter="name=gcp-builder" --format="get(networkInterfaces[0].accessConfigs[0].natIP)")

echo $EXTERNAL_IP
```

Copy the VHD image from the builder to your local machine:

```
scp -i ~/.ssh/google_compute_engine $USER@$EXTERNAL_IP:~/teekit/packages/images/build/tdx-debian-azure.vhd ./tdx-debian-azure.vhd
```

If you have have specified user/pass authentication, use your password
instead. Or, you may be able to use the gcloud scp:

```
gcloud compute scp \
  --project gcp-builder \
  --zone us-central1-a \
  "gcp-builder:~/teekit/packages/images/build/tdx-debian-azure.vhd" \
  ./tdx-debian-azure.vhd
```

Create a storage account. This must have a globally unique name:

```
export STORAGE_ACCT=tdx$(openssl rand -hex 6)

az storage account create \
  --name $STORAGE_ACCT \
  --resource-group tdx-group \
  --sku Standard_LRS
```

- To list storage accounts, you can also use: `az storage account list --query "[].name" -o tsv`.
- To delete storage accounts, use: `az storage account delete --name <name> --resource-group tdx-group --yes`

Now, create a container called `vhds`.

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
  --name tdx-debian-azure.vhd \
  --file tdx-debian-azure.vhd \
  --type page \
  --auth-mode login
```

- To list blobs: `az storage blob list --account-name $STORAGE_ACCT --container-name vhds --auth-mode login`
- To delete a blob: `az storage blob delete -n tdx-debian-azure.vhd -c vhds --account-name $STORAGE_ACCT --auth-mode login`

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
  --gallery-image-definition tdx-debian-azure \
  --publisher TeeKit \
  --offer tdx-debian-azure \
  --sku 1.0 \
  --os-type Linux \
  --os-state Generalized \
  --hyper-v-generation V2 \
  --features SecurityType=ConfidentialVMSupported
```

- To list image definitions: `az sig image-definition list --resource-group tdx-group --gallery-name tdxGallery`
- To delete image definitions: `az sig image-definition delete --resource-group tdx-group --gallery-name tdxGallery`

Create an image version from the VHD blob:

```
az sig image-version create \
  --resource-group tdx-group \
  --gallery-name tdxGallery \
  --gallery-image-definition tdx-debian-azure \
  --gallery-image-version 1.0.0 \
  --os-vhd-uri "https://${STORAGE_ACCT}.blob.core.windows.net/vhds/tdx-debian-azure.vhd" \
  --os-vhd-storage-account $STORAGE_ACCT
```

- To list: `az sig image-version list -g tdx-group -r tdxGallery -i tdx-debian-azure`
- To delete: `az sig image-version delete -g tdx-group -r tdxGallery -i tdx-debian-azure -e 1.0.0`

Create a VM from the gallery image:

```
az vm create \
  --name tdx-kettle \
  --resource-group tdx-group \
  --security-type ConfidentialVM \
  --os-disk-security-encryption-type VMGuestStateOnly \
  --image /subscriptions/$(az account show --query id -o tsv)/resourceGroups/tdx-group/providers/Microsoft.Compute/galleries/tdxGallery/images/tdx-debian-azure/versions/1.0.0 \
  --size Standard_DC2es_v5 \
  --enable-vtpm true \
  --enable-secure-boot false
```

**Note:** Using `VMGuestStateOnly` (instead of `DiskWithVMGuestState`) and `--enable-secure-boot false` is required because custom VHD images typically lack the UEFI Secure Boot signatures that Azure requires when using full disk encryption with guest state.

Configure Network Security Group (NSG) rules to allow inbound traffic on required ports:

```
# Get the network interface name for the VM
export NIC_NAME=$(az vm show \
  --name tdx-kettle \
  --resource-group tdx-group \
  --query "networkProfile.networkInterfaces[0].id" -o tsv | xargs basename)

# Get the NSG name associated with the VM's network interface (if it exists)
export NSG_NAME=$(az network nic show \
  --name $NIC_NAME \
  --resource-group tdx-group \
  --query "networkSecurityGroup.id" -o tsv | xargs basename)

# If NSG wasn't automatically created, create one
if [ -z "$NSG_NAME" ] || [ "$NSG_NAME" = "None" ]; then
  az network nsg create \
    --name tdx-kettle-nsg \
    --resource-group tdx-group
  NSG_NAME="tdx-kettle-nsg"

  # Associate NSG with the VM's network interface
  az network nic update \
    --name $NIC_NAME \
    --resource-group tdx-group \
    --network-security-group $NSG_NAME
fi

# Add inbound rule for all required ports
az network nsg rule create \
  --resource-group tdx-group \
  --nsg-name $NSG_NAME \
  --name allow-required-ports \
  --priority 1000 \
  --direction Inbound \
  --access Allow \
  --protocol Tcp \
  --destination-port-ranges 80 443 3000 3001 8080 8090 \
  --source-address-prefixes "*"
```

Get the new VM's public IP address:

```
az vm show \
  --name tdx-kettle \
  --resource-group tdx-group \
  --show-details \
  --query publicIps -o tsv

export KETTLE_IP=<...>
```

Check for running services:

```
curl http://${KETTLE_IP}:3001/uptime
```

### Configuring HTTPS with Custom Hostname

To enable HTTPS with Let's Encrypt certificates and nginx reverse proxy, configure the VM with a `hostname` tag **before** the initial boot or **before** restarting the VM:

```bash
# Configure hostname for the VM
az vm update \
  --name tdx-kettle \
  --resource-group tdx-group \
  --set tags.hostname="your-domain.example.com"

# Restart the VM to apply the hostname configuration
az vm restart --name tdx-kettle --resource-group tdx-group
```

**Important Prerequisites:**
- The hostname DNS must be configured to point to the VM's public IP address **before** the VM boots
- Ensure DNS propagation is complete (test with `dig +short your-domain.example.com`)
- The VM will automatically obtain Let's Encrypt certificates during boot using the ACME HTTP-01 challenge
- If DNS is not ready when the VM boots, certbot will fail and the VM will fall back to HTTP-only mode on port 3001

**Multiple Hostnames:**
You can specify multiple comma-separated hostnames:
```bash
az vm update \
  --name tdx-kettle \
  --resource-group tdx-group \
  --set tags.hostname="domain1.example.com,domain2.example.com"
```

After the VM restarts and certificates are obtained (typically 1-3 minutes after boot):
- HTTP requests on port 80 will redirect to HTTPS
- HTTPS will be available on port 443
- The kettle service will be proxied through nginx with TLS termination

Test the HTTPS endpoint:
```bash
curl https://your-domain.example.com/uptime
```

**Troubleshooting HTTPS Setup:**
If HTTPS is not working after 5 minutes:
1. Verify DNS is resolving correctly: `dig +short your-domain.example.com`
2. The kettle service should still be accessible via HTTP: `curl http://${KETTLE_IP}:3001/uptime`
3. Check if ports 80 and 443 are open: `nc -zv ${KETTLE_IP} 443`
4. If certbot failed during boot, restart the VM again after confirming DNS is working

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

## Troubleshooting

### Check VM Status

```
az vm get-instance-view \
  --name tdx-kettle \
  --resource-group tdx-group \
  --query "instanceView.statuses[*].{code:code, displayStatus:displayStatus}" \
  -o table
```

### List Deployments

```
az deployment group list \
  --resource-group tdx-group \
  --query "[].{name:name, state:properties.provisioningState, timestamp:properties.timestamp}" \
  -o table
```

### Check Deployment Errors

To see detailed deployment errors:

```
az deployment group list \
  --resource-group tdx-group \
  --query "[?properties.provisioningState=='Failed'].{name:name, error:properties.error}" \
  -o json

# Or view operations for a specific deployment
az deployment operation group list \
  --resource-group tdx-group \
  --name <deployment-name> \
  --query "[].{resource:properties.targetResource.resourceName, state:properties.provisioningState, duration:properties.duration}" \
  -o table
```

### Check Activity Logs

```
az monitor activity-log list \
  --resource-group tdx-group \
  --max-events 10 \
  --query "[].{time:eventTimestamp, status:status.value, operation:operationName.value}" \
  -o table
```

### DiskServiceInternalError

If you encounter a `DiskServiceInternalError` during VM creation, this typically indicates
an issue with the VHD image format or Azure's processing of the disk. Common causes:

1. **VHD format issues**: Ensure the build completed successfully and the VHD verification passed.
2. **Disk size**: Azure Confidential VMs may have minimum disk size requirements.
3. **Region availability**: Try deploying to a different region that supports DCesv5 VMs.

To debug, try creating the managed disk separately first:

```
# Create a managed disk from the VHD blob
az disk create \
  --name tdx-debug-disk \
  --resource-group tdx-group \
  --source "https://${STORAGE_ACCT}.blob.core.windows.net/vhds/tdx-debian-azure.vhd" \
  --hyper-v-generation V2 \
#  --security-type ConfidentialVM_DiskEncryptedWithPlatformKey \
  --os-type Linux
```

If the disk creation fails, examine the detailed error message for hints about the specific issue.

### Boot Diagnostics

Before creating the VM, enable boot diagnostics to capture console output:

```
# Create a storage account for boot diagnostics (if not already exists)
az storage account create \
  --name ${STORAGE_ACCT}diag \
  --resource-group tdx-group \
  --sku Standard_LRS

# Create VM with boot diagnostics enabled
az vm create \
  --name tdx-kettle \
  --resource-group tdx-group \
  --security-type ConfidentialVM \
  --os-disk-security-encryption-type VMGuestStateOnly \
  --image /subscriptions/$(az account show --query id -o tsv)/resourceGroups/tdx-group/providers/Microsoft.Compute/galleries/tdxGallery/images/tdx-debian-azure/versions/1.0.0 \
  --size Standard_DC2es_v5 \
  --enable-vtpm true \
  --enable-secure-boot false \
  --boot-diagnostics-storage ${STORAGE_ACCT}diag
```

Then view the boot log:

```
az vm boot-diagnostics get-boot-log --name tdx-kettle --resource-group tdx-group
```

## Cleanup

```
# Delete VM
az vm delete \
  --name tdx-kettle \
  --resource-group tdx-group \
  --yes

# Delete disk
az disk delete \
  --name tdx-secure-disk \
  --resource-group tdx-group \
  --yes

# Delete image version
az sig image-version delete \
  -g tdx-group \
  -r tdxGallery \
  -i tdx-debian-azure \
  -e 1.0.0

# Delete image definition
az sig image-definition delete \
  --resource-group tdx-group \
  --gallery-name tdxGallery \
  --gallery-image-definition tdx-debian-azure

# Delete gallery
az sig delete \
  --resource-group tdx-group \
  --gallery-name tdxGallery

# Delete storage blob
az storage blob delete \
  -n tdx-debian-azure.vhd \
  -c vhds \
  --account-name $STORAGE_ACCT \
  --auth-mode login
```
