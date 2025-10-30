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
    --ssh-key-values \~/.ssh/id_rsa.pub
```

This uses a default confidential VM image provided by Canonical.

To delete the vm (this will leave resources like public IPs):

```
az vm list
az vm delete --name tdx-vm --resource-group tdx-group -y
```

## Connecting to the VM

To connect to the VM:

```
ssh [publicIpAddress] -i ~/.ssh/id_rsa
```

If you need to find the public IP again:

```
az vm list-ip-addresses --name tdx-vm
```

## TDX Attestation

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
curl -sL https://raw.githubusercontent.com/intel/trustauthority-client-for-go/main/release/install-tdx-cli-azure.sh | sudo bash -
```

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
   "trustauthority_api_key": "djE6...nRHI="
}
EOF
```

## Obtaining an Attestation

```
sudo trustauthority-cli quote --aztdx
```
