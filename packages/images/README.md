# @teekit/images

This subpackage includes build tools for reproducible hardened Linux images,
based on Debian 16 and [flashbots-images](https://github.com/flashbots/flashbots-images).

Requirements: A Linux VM with systemd v250 or greater, e.g. Ubuntu 24.04, with
support for nested virtualization (/dev/kvm).

## Usage

1. Install qemu-utils and nix:

   ```
   sudo apt update
   sudo apt install -y qemu-utils qemu-system-x86
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
   scripts/bundle_kettle.sh

   scripts/env_wrapper.sh mkosi --force --profile=gcp -I tdx-kettle.conf
   ```

5. Export measurements:

   ```
   scripts/env_wrapper.sh measured-boot build/tdx-debian.efi build/measurements.json --direct-uki
   ```

## Testing Locally

After building the image, you can test it locally with QEMU:

```bash
./scripts/test_local.sh
```

This will boot the image with:
- Kettle service on port 3001 (http://localhost:3001)
- Dummy TDX DCAP server on port 8080 (http://localhost:8080)

## Adding Files to Modules

There are two main ways to add custom files to your
module. **mkosi.extra is preferred** because files are placed after
package installation and can override default package files. To add
overlay files before packages are installed, use `SkeletonTrees` and
`mkosi.skeleton` instead of `ExtraTrees` and `mkosi.extra`

To add files:

```bash
mkdir -p mymodule/mkosi.extra/etc/systemd/system/
mkdir -p mymodule/mkosi.extra/usr/bin/
mkdir -p mymodule/mkosi.extra/home/myuser/

# Add a custom systemd service
cat > mymodule/mkosi.extra/etc/systemd/system/myservice.service << 'EOF'
[Unit]
Description=My Custom Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/myapp
Restart=always

[Install]
WantedBy=minimal.target
EOF

# Add a custom script
cp myscript mymodule/mkosi.extra/usr/bin/
chmod +x mymodule/mkosi.extra/usr/bin/myscript

# Add configuration files
echo "config_value=123" > mymodule/mkosi.extra/etc/myapp.conf
```

## File Permissions and Ownership

Files copied via mkosi.extra inherit permissions from the source. To
set specific permissions or ownership, use the post-installation
script:

**`mymodule/mkosi.postinst`**:
```bash
#!/bin/bash
set -euxo pipefail

# Set file permissions
chmod 600 "$BUILDROOT/etc/myapp.conf"
chmod +x "$BUILDROOT/usr/bin/myapp"

# Set ownership (must use mkosi-chroot for user/group operations)
mkosi-chroot chown root:root /home/myuser/config
```

## Configuration Service

When the VM boots, `cloud-config.service` runs to obtain a manifest
before launching `kettle-launcher.service`.

The config script checks for GCP, Azure, and QEMU metadata services,
looking for a base64-encoded manifest. If it finds one, the manifest
is written to `/etc/kettle/cloud-config.env` and configured as as the
`MANIFEST` environment variable to initialize the kettle launcher.

For Google Cloud, set the manifest as a metadata attribute:

```
# Generate base64-encoded manifest
MANIFEST_B64=$(base64 -w0 manifest.json)

# Create VM instance with manifest metadata
gcloud compute instances create my-tee-vm \
  --image=tdx-debian \
  --metadata=manifest="$MANIFEST_B64"
```

For Azure, set the manifest as a tag:

```
# Generate base64-encoded manifest
MANIFEST_B64=$(base64 -w0 manifest.json)

# Create VM with manifest tag
az vm create \
  --name my-tee-vm \
  --image tdx-debian \
  --tags manifest="$MANIFEST_B64"
```

For local testing with QEMU, use the `test_local.sh` script, which
automatically starts a metadata service on the host at
`http://10.0.2.2:8090` and serves the manifest from
`packages/images/kettle-artifacts/manifest.json`.

```
cd packages/images
npm run test:local
```

The manifest is expected to be a JSON file with the following structure:

```
{
  "app": "file:///usr/lib/kettle/app.js", // also accepts http or https URL
  "sha256": "52b50d81b56ae6ebd2acc4c18f034a998fd60e43d181142fcca443faa21be217"
}
```

The VM build creates a demo app inside the VM at `/usr/lib/kettle/app.js`
which is what the test_local.sh script initializes. This allows us to bypass
publishing the manifest to S3 or Github Gists.

You may also inspect the generated default manifest used for testing at:
- `packages/images/build/tdx-debian/build/kettle/manifest.json` (during build)
- `packages/images/kettle-artifacts/manifest.json` (for testing)

### Troubleshooting

- Check cloud-config logs:
  - journalctl -u cloud-config.service
  - cat /var/log/cloud-config.log
- Check kettle-launcher logs:
  - journalctl -u kettle-launcher.service
  - cat /var/log/kettle.log
  - cat /var/log/kettle-error.log
- Check if the manifest was loaded:
  - cat /etc/kettle/cloud-config.env
- Test the metadata service (local/QEMU):
  - curl http://localhost:8090/manifest/decoded
  - curl http://localhost:8090/health
