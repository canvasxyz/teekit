# @teekit/images

This subpackage includes build tools for reproducible hardened Linux images,
based on Debian 16 and [flashbots-images](https://github.com/flashbots/flashbots-images).

Requirements: A Linux VM with systemd v250 or greater, e.g. Ubuntu 24.04, with
support for nested virtualization (/dev/kvm).

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
   scripts/env_wrapper.sh mkosi --force --profile=gcp -I tdx-dummy.conf
   ```

5. Export measurements:

   ```
   make measure
   ```

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

### File Permissions and Ownership

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

# View all available targets
make help
```
