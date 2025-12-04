# @teekit/images

This subpackage includes build tools for reproducible hardened Linux images,
based on Debian 13 and [flashbots-images](https://github.com/flashbots/flashbots-images).

Requirements: A Linux VM with systemd v250 or greater, e.g. Ubuntu 24.04, with
support for nested virtualization (/dev/kvm).

The build uses a multi-stage mkosi pipeline to optimize caching and separate build-time dependencies from the final image:

- Kernel (`kernel/`): Outputs compiled kernel at `/usr/lib/modules/$KERNEL_VERSION/vmlinuz`
- Base System (`base/`): Minimal Debian runtime environment (systemd, busybox, kmod, etc.)
- Build Tools (`build-tools/`): Used only during build, not in final image
- sqld: (`sqld/`): Builds the libsql server binary, depends on build-tools stage
- TDX Kettle (`tdx-kettle/`): Includes kettle artifacts, services, and configuration
  - Depends on base (for runtime) and sqld (for binary)

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

4. Now that dependencies are installed, start a build using `env_wrapper.sh`,
   optionally using the Azure, GCP, or devtools profile.

   ```
   scripts/check_perms.sh
   scripts/setup_deps.sh

   # If building tdx-kettle with kettle integration, bundle kettle first
   scripts/prep_kettle.sh

   scripts/env_wrapper.sh mkosi --force --profile=gcp -I tdx-kettle.conf
   ```

5. Export measurements:

   ```
   make measure
   ```

## Build Artifacts

After building, artifacts are located in the `build/` directory:

```
build/
├── tdx-debian.efi           # Base UKI image (no profile)
├── tdx-debian.tar.gz         # GCP disk image (gcp profile)
├── tdx-debian-azure.efi      # Azure UKI image (azure profile)
├── tdx-debian-azure.vhd      # Azure VHD image (azure profile)
└── tdx-debian-devtools.efi   # Development UKI image (devtools profile)
```

The different ImageId values ensure that building multiple profiles (via `npm run build:all`) won't overwrite each other's EFI artifacts.

## Testing Locally

After building the image, you can test it locally with QEMU:

```bash
./scripts/test_local.sh
```

This will boot the image with:
- Kettle service on port 3001 (http://localhost:3001)
- Dummy TDX DCAP server on port 8080 (http://localhost:8080)

## Deploying

You can deploy the image to Azure (recommended) or GCP TDX machines,
depending on which profile you built the image with.

Follow the instructions in DEPLOY-AZURE.md or DEPLOY-GCP.md for
reference.

## Adding Files to Modules

There are two main ways to add custom files to your
module. **mkosi.extra is preferred** because files are placed after
package installation and can override default package files. To add
overlay files before packages are installed, use `SkeletonTrees` and
`mkosi.skeleton` instead of `ExtraTrees` and `mkosi.extra`.

Permissions and modification times are both normalized during the
build process, in the post-installation script, for reproducibility.

## Troubleshooting

- Check cloud-launcher logs:
  - journalctl -u cloud-launcher.service
  - cat /var/log/cloud-launcher.log
- Check if the manifest was loaded:
  - cat /etc/kettle/cloud-launcher.env
- Check kettle-launcher logs:
  - journalctl -u kettle-launcher.service
  - cat /var/log/kettle.log
  - cat /var/log/kettle-error.log
- Test the metadata service (local/QEMU):
  - curl http://localhost:8090/manifest/decoded
  - curl http://localhost:8090/health
