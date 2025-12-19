## CI Self-Hosted Runner Instructions

This document covers how to set up a self-hosted Github Actions
runner, which you can use to create reproducible mkosi builds and
measurements of the @teekit VM.

(Building VM images requires KVM virtualization support, which is not
available in GitHub's standard runners, so a self-hosted runner is
required.)

### Requirements

- **Linux kernel**: 5.15+ (for KVM support)
- **systemd**: 250+ (required by mkosi)
- **User permissions**: Access to `/dev/kvm` device

### Setup

```
gcloud compute instances create ci-builder \
      --enable-nested-virtualization \
      --machine-type=c3-standard-4 \
      --zone=us-east1-b \
      --image-family=ubuntu-2404-lts-amd64 \
      --image-project=ubuntu-os-cloud \
      --boot-disk-size=400GB \
      --metadata=startup-script='#!/bin/bash
        # Add default user to kvm group
        usermod -aG kvm $(logname)
      '
```

SSH into the VM:

```
gcloud compute ssh ci-builder
```

Install the build dependencies:

```
git clone https://github.com/canvasxyz/teekit.git

cd teekit

# Run the base setup script to install build tools, nvm, brew, lima.
./scripts/setup.sh

# Run the image builder setup script to check for dependencies, systemd, and to install nix.
./packages/images/scripts/setup_deps.sh

# Verify KVM permissions:
./packages/images/scripts/check_perms.sh
```

Get the runner registration token from Github:

1. Go to your GitHub repository
2. Navigate to **Settings** → **Actions** → **Runners**
3. Click **New self-hosted runner**
4. Select **Linux** as the OS, **X64** as the architecutre
5. Copy the commands shown (they should be approximately the same as below)

```
# Create a directory for the runner
mkdir ~/runner && cd ~/runner

# Download the latest runner package (Github may recommend a new package)
curl -o actions-runner-linux-x64-2.311.0.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.311.0/actions-runner-linux-x64-2.311.0.tar.gz

# Extract the installer
tar xzf ./actions-runner-linux-x64-2.311.0.tar.gz

# Configure the runner (use the token provided by Github)
./config.sh \
  --url https://github.com/canvasxyz/teekit \
  --token $TOKEN \
  --name ci-builder \
  --labels self-hosted,Linux,X64,kvm \
  --work _work \
  --runnergroup Default

# Install as a service (recommended)
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

Go back to Settings → Actions → Runners in Github, and you should now
see your runner listed as "Idle".

The runner will automatically update itself when new versions are
available. This can be configured from `~/actions-runner/.service`.

Finally, since the builds generate large artifacts, we should set up automatic cleanup:

```bash
# Add to crontab
crontab -e

# Clean build artifacts older than 7 days (runs daily at 2 AM)
0 2 * * * find ~/actions-runner/_work -name 'build' -type d -mtime +7 -exec rm -rf {} + 2>/dev/null
```

### Troubleshooting

```
sudo ./svc.sh status                                      # Check runner status
df -h                                                     # Check disk space
ls -l /dev/kvm                                            # Check KVM availability
journalctl -u actions.runner.*                            # View runner logs
tail -f ~/actions-runner/_diag/*.log                      # View build logs
ls -lh ~/actions-runner/_work/*/*/packages/images/build/  # Check recent builds
```

### Log Rotation

```bash
# Configure logrotate for runner logs
sudo nano /etc/logrotate.d/github-runner

# Add:
# /home/*/actions-runner/_diag/*.log {
#     daily
#     rotate 7
#     compress
#     delaycompress
#     missingok
#     notifempty
# }
```

### Out of Disk Space

```bash
# Clean old builds
find ~/actions-runner/_work -name 'build' -type d -exec rm -rf {} + 2>/dev/null

# Clean Lima cache (if using)
npm run clean:lima

# Clean Nix store
nix-collect-garbage -d
```
