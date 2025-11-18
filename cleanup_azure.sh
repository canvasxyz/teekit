#!/bin/bash
set -euo pipefail

# Azure VM and Resource Cleanup Script
# This script deletes VMs, NICs, disks, NSGs, public IPs, and VNETs from the tdx-group resource group

echo "========================================="
echo "Azure Resource Cleanup for tdx-group"
echo "========================================="
echo ""

RESOURCE_GROUP="tdx-group"

# Step 1: Delete all VMs
echo "[1/6] Deleting Virtual Machines..."
VMS=$(az vm list -g "$RESOURCE_GROUP" --query "[].name" -o tsv 2>/dev/null || echo "")
if [ -n "$VMS" ]; then
  while IFS= read -r vm; do
    echo "  Deleting VM: $vm"
    az vm delete --name "$vm" --resource-group "$RESOURCE_GROUP" -y --no-wait
  done <<< "$VMS"
  echo "  VM deletion initiated (running in background)"
else
  echo "  No VMs found"
fi
echo ""

# Step 2: Wait for VM deletions to complete
echo "[2/6] Waiting for VM deletions to complete..."
sleep 10
echo "  Done waiting"
echo ""

# Step 3: Delete all Network Interfaces
echo "[3/6] Deleting Network Interfaces..."
NICS=$(az network nic list -g "$RESOURCE_GROUP" --query "[].name" -o tsv 2>/dev/null || echo "")
if [ -n "$NICS" ]; then
  while IFS= read -r nic; do
    echo "  Deleting NIC: $nic"
    az network nic delete --name "$nic" --resource-group "$RESOURCE_GROUP" --no-wait
  done <<< "$NICS"
  echo "  NIC deletion initiated"
else
  echo "  No NICs found"
fi
echo ""

# Step 4: Delete all Disks
echo "[4/6] Deleting Disks..."
DISKS=$(az disk list -g "$RESOURCE_GROUP" --query "[].{name:name,rg:resourceGroup}" -o tsv 2>/dev/null || echo "")
if [ -n "$DISKS" ]; then
  while IFS=$'\t' read -r disk_name disk_rg; do
    echo "  Deleting Disk: $disk_name (in $disk_rg)"
    az disk delete --name "$disk_name" --resource-group "$disk_rg" -y --no-wait
  done <<< "$DISKS"
  echo "  Disk deletion initiated"
else
  echo "  No disks found"
fi
echo ""

# Step 5: Delete all Public IPs
echo "[5/6] Deleting Public IP Addresses..."
PUBLIC_IPS=$(az network public-ip list -g "$RESOURCE_GROUP" --query "[].name" -o tsv 2>/dev/null || echo "")
if [ -n "$PUBLIC_IPS" ]; then
  while IFS= read -r pip; do
    echo "  Deleting Public IP: $pip"
    az network public-ip delete --name "$pip" --resource-group "$RESOURCE_GROUP" --no-wait
  done <<< "$PUBLIC_IPS"
  echo "  Public IP deletion initiated"
else
  echo "  No Public IPs found"
fi
echo ""

# Step 6: Delete all Network Security Groups
echo "[6/6] Deleting Network Security Groups..."
NSGS=$(az network nsg list -g "$RESOURCE_GROUP" --query "[].name" -o tsv 2>/dev/null || echo "")
if [ -n "$NSGS" ]; then
  while IFS= read -r nsg; do
    echo "  Deleting NSG: $nsg"
    az network nsg delete --name "$nsg" --resource-group "$RESOURCE_GROUP" --no-wait
  done <<< "$NSGS"
  echo "  NSG deletion initiated"
else
  echo "  No NSGs found"
fi
echo ""

# Step 9: List remaining resources
echo "Listing remaining resources in $RESOURCE_GROUP..."
az resource list --resource-group "$RESOURCE_GROUP" -o table
echo ""

echo "========================================="
echo "Cleanup initiated for all resources!"
echo "========================================="
echo ""
echo "Note: Deletions are running in the background with --no-wait."
echo "Resources will be fully deleted within a few minutes."
echo ""
echo "To verify cleanup status, run:"
echo "  az resource list --resource-group $RESOURCE_GROUP -o table"
