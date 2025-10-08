# TDX Verification

This assumes you have a Microsoft Azure account.

## Install Azure CLI

```
brew update && brew install azure-cli
```

## Login to Azure CLI

```
az login
```

## Create a resource group

```
az group create --name tdx-group --location eastus2
```

You should receive a success response in JSON.

## Create a VM

```
az vm create \
    --name tdx-vm \
    --resource-group tdx-group \
    --location eastus2 \
    --security-type ConfidentialVM \
    --os-disk-security-encryption-type DiskWithVMGuestState \
    --image Canonical:0001-com-ubuntu-confidential-vm-jammy:22_04-lts-cvm:22.04.202507300 \
    --size Standard_DC2es_v5 \
    --generate-ssh-keys
```

This uses a default confidential VM image provided by Canonical.
To look for other images, you can use `az vm image list` (it's slow).

```
az vm image list --offer com-ubuntu-confidential-vm  --all
```

If you have any issues, *stop and delete* the VM from the Azure Portal,
and as you are doing so, select any connected resources like public IPs
to be deleted as well. Deleting from the command line will leave orphaned network interfaces, public IPs, etc.: `az vm delete --name tdx-vm --resource-group tdx-group -y`

## Connecting to the VM

To connect to the VM:

```
ssh azureuser@[publicIpAddress] -i ~/.ssh/azureuser.pem
```

Check that TDX is working:

```
sudo dmesg | grep -i tdx
```

This should print `Memory Encryption Features active: Intel TDX`:

```
[    0.000000] tdx: Guest detected
[    1.404759] process: using TDX aware idle routine
[    1.404759] Memory Encryption Features active: Intel TDX
```

## Installing the Attestation Client

```
sudo add-apt-repository ppa:longsleep/golang-backports
sudo apt update
sudo apt install -y golang-go
touch config.json
cat <<EOF> config.json
{
   "trustauthority_api_url": "https://api.trustauthority.intel.com",
   "trustauthority_api_key": "djE6...nRHI="
}
EOF
curl -sL https://raw.githubusercontent.com/intel/trustauthority-client-for-go/main/release/install-tdx-cli-azure.sh | sudo bash -
sudo trustauthority-cli quote --aztdx
# sudo trustauthority-cli token -c config.json
```


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
curl -sL https://raw.githubusercontent.com/intel/trustauthority-client-for-go/main/release/install-tdx-cli-azure.sh | sudo bash -
```

Check that the attestation client is installed:

```
trustauthority-cli version
```

```
Intel® Trust Authority CLI for TDX
Version: v1.6.1-3be04c6
Build Date: 2024-10-17
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
   "trustauthority_api_key": "djE6...nRHI"
}
EOF
```

## Obtaining an Attestation

TODO: instructions for using the client based on
https://docs.rs/az-tdx-vtpm/latest/az_tdx_vtpm/index.html