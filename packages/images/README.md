# @teekit/images

This subpackage includes build tools for reproducible hardened Linux images,
based on Debian 13 and [flashbots-images](https://github.com/flashbots/flashbots-images).

Requirements: A Linux VM with systemd v250 or greater, e.g. Ubuntu 24.04, with
support for nested virtualization (/dev/kvm).

The build uses a multi-stage mkosi pipeline to optimize caching and separate build-time dependencies from the final image:

- Kernel (`kernel/`): Outputs compiled kernel at `/usr/lib/modules/$KERNEL_VERSION/vmlinuz`
- Base System (`base/`): Minimal Debian runtime environment (systemd, busybox, kmod, etc.)
- Build Tools (`build-tools/`): Used only during build, not in final image
- Kettle Runtime (`kettle-vm/`): Includes kettle artifacts, services, and configuration
  - Depends on base (for runtime) and build-tools (for build environment)

## Usage

1. Install make, qemu-utils, and nix:

   ```
   sudo apt update
   sudo apt install -y make qemu-utils qemu-system-x86
   NONINTERACTIVE=1 ./scripts/setup_deps.sh
   . ~/.nix-profile/etc/profile.d/nix.sh
   ```

2. Install homebrew:

   ```
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

   echo >> ~/.bashrc
   echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.bashrc
   eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
   ```

3. Install lima:

   ```
   brew install lima
   ```

4. Generate Secure Boot signing keys (required for Azure SGX builds):

   ```bash
   npm run genkeys:secureboot
   ```

   This generates cryptographic keys needed to sign the UKI (Unified Kernel Image)
   for UEFI Secure Boot on Azure Trusted Launch VMs. The following files are created:

   - `mkosi.secureboot.key` - Private signing key (keep secret!)
   - `mkosi.secureboot.crt` - Public certificate (enrolled in Azure UEFI)
   - `mkosi.secureboot.GUID.txt` - Unique identifier for key enrollment

5. Now that dependencies are installed, start a build using `env_wrapper.sh`,
   optionally using the Azure, GCP, Azure devtools, or GCP devtools profile.

   ```
   scripts/check_perms.sh
   scripts/setup_deps.sh
   scripts/prep_kettle.sh

   scripts/env_wrapper.sh mkosi --force --profile=gcp-devtools -I kettle-vm.conf
   ```

6. Export measurements:

   ```
   make measure
   ```

## Build Artifacts

After building, artifacts are located in the `build/` directory:

```
build/
├── kettle-vm.efi                     # Base UKI image  (no profile)
├── kettle-vm-devtools.efi            # Base UKI image  (devtools profile)
├── kettle-vm-gcp.efi                 # GCP UKI image   (gcp base profile)
├── kettle-vm-gcp.tar.gz              # GCP disk image  (gcp base profile)
├── kettle-vm-gcp-devtools.efi        # GCP UKI image   (gcp-devtools profile)
├── kettle-vm-gcp-devtools.tar.gz     # GCP disk image  (gcp-devtools profile)
├── kettle-vm-azure.efi               # Azure UKI image (azure base profile)
├── kettle-vm-azure.vhd               # Azure VHD image (azure base profile)
├── kettle-vm-azure-devtools.efi      # Azure UKI image (azure-devtools profile)
├── kettle-vm-azure-devtools.vhd      # Azure VHD image (azure-devtools profile)
├── kettle-vm-azsgx.efi               # Azure SGX UKI image (azsgx base profile)
├── kettle-vm-azsgx.vhd               # Azure SGX VHD image (azsgx base profile)
├── kettle-vm-azsgx-devtools.efi      # Azure SGX UKI image (azsgx-devtools profile)
└── kettle-vm-azsgx-devtools.vhd      # Azure SGX VHD image (azsgx-devtools profile)
```

## Testing Locally

After building the image, you can test it locally with QEMU:

```bash
./scripts/test_local.sh
```

This will boot the image with the kettle service on port 3001
(http://localhost:3001).

## Deploying

Use the various deploy commands to deploy to GCP, Azure, or Azure SGX.
They will generate a VM name (starting with kettle-vm-) and upload a
VM image.

```
npm run redeploy:gcp
npm run redeploy:az
npm run redeploy:azsgz
npm run redeploy:gcp:devtools
npm run redeploy:az:devtools
npm run redeploy:azsgx:devtools
```

Use the configure command afterwards to set up metadata.

```
npm run config:az
npm run config:gcp
```

To redeploy a new image to the same VM while reusing configuration metadata,
use the redeploy command:

```
npm run redeploy:gcp
npm run redeploy:az
npm run redeploy:azsgz
npm run redeploy:gcp:devtools
npm run redeploy:az:devtools
npm run redeploy:azsgx:devtools
```

### Intel Trust Authority Configuration (TDX only)

To enable Intel Trust Authority attestation, set the `trustauthority_api_key` tag.
The `trustauthority_api_url` is optional and defaults to `https://api.trustauthority.intel.com`.

For Azure, set the Trust Authority configuration as tags on an existing VM:
```
az vm update \
  --name my-tee-vm \
  --resource-group my-resource-group \
  --set tags.trustauthority_api_key="djE6N2U4..." \
        tags.trustauthority_api_url="https://api.trustauthority.intel.com"

az vm restart \
  --name my-tee-vm \
  --resource-group my-resource-group
```
