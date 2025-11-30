#!/bin/bash
set -euo pipefail

LIMA_VM="${LIMA_VM:-tee-builder}"

# Minimum free space in GB before triggering cleanup (default: 10GB)
NIX_MIN_FREE_SPACE_GB="${NIX_MIN_FREE_SPACE_GB:-10}"

# Check nix store free space and clean if needed
check_nix_free_space() {
    local nix_store="/nix/store"

    # Skip if nix store doesn't exist
    if [ ! -d "$nix_store" ]; then
        return 0
    fi

    # Get free space in GB (using df on the nix store mount point)
    local free_space_kb
    free_space_kb=$(df -P "$nix_store" 2>/dev/null | awk 'NR==2 {print $4}')

    if [ -z "$free_space_kb" ]; then
        return 0
    fi

    local free_space_gb=$((free_space_kb / 1024 / 1024))

    echo "Nix store free space: ${free_space_gb}GB (threshold: ${NIX_MIN_FREE_SPACE_GB}GB)"

    if [ "$free_space_gb" -lt "$NIX_MIN_FREE_SPACE_GB" ]; then
        echo -e "\033[1;33m⚠ Low disk space detected in nix store. Running cleanup...\033[0m"

        echo "Running nix-collect-garbage..."
        nix-collect-garbage -d 2>/dev/null || nix-collect-garbage 2>/dev/null || true

        echo "Running nix store optimise..."
        nix store optimise 2>/dev/null || true

        # Report new free space
        free_space_kb=$(df -P "$nix_store" 2>/dev/null | awk 'NR==2 {print $4}')
        if [ -n "$free_space_kb" ]; then
            free_space_gb=$((free_space_kb / 1024 / 1024))
            echo -e "\033[1;32m✓ Cleanup complete. Free space now: ${free_space_gb}GB\033[0m"
        fi
    fi
}

# Check if Lima should be used
should_use_lima() {
    # Use Lima by default for now
    true ||
    # Use Lima on macOS or if FORCE_LIMA is set
    [[ "$OSTYPE" == "darwin"* ]] || [ -n "${FORCE_LIMA:-}" ] ||
    # Use Lima if it's available but Nix is not
    (command -v limactl &>/dev/null && ! command -v nix &>/dev/null)
}

# Setup Lima if needed
setup_lima() {
    # Check KVM availability on Linux
    if [[ "$OSTYPE" != "darwin"* ]]; then
        if [ ! -e /dev/kvm ]; then
            echo -e "\033[1;33m⚠ WARNING: /dev/kvm not found. KVM acceleration unavailable.\033[0m"
            echo -e "\033[1;33m  VM performance will be significantly degraded.\033[0m"
        elif [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
            echo -e "\033[1;33m⚠ WARNING: No permission to access /dev/kvm.\033[0m"
            echo -e "\033[1;33m  Add your user to the kvm group: sudo usermod -aG kvm \$USER\033[0m"
            echo -e "\033[1;33m  Then log out and log back in, or run: sg kvm -c 'your-command'\033[0m"
        fi
    fi

    # Regenerate lima.yaml with absolute path if template exists
    if [ -f "lima.template.yaml" ]; then
        images_dir="$(pwd)"
        sed "s|ABSOLUTE_IMAGES_PATH|$images_dir|g" lima.template.yaml > lima.yaml
    fi

    # Check if Lima is installed
    if ! command -v limactl &>/dev/null; then
        echo -e "Lima is not installed. Please install Lima to use this script."
        echo -e "Visit: https://lima-vm.io/docs/installation/"
        exit 1
    fi

    # Create VM if it doesn't exist
    if ! limactl list "$LIMA_VM" > /dev/null 2>&1; then
        declare -a args=()
        if [ -n "${LIMA_CPUS:-}" ]; then
            args+=("--cpus" "$LIMA_CPUS")
        fi
        if [ -n "${LIMA_MEMORY:-}" ]; then
            args+=("--memory" "$LIMA_MEMORY")
        fi
        if [ -n "${LIMA_DISK:-}" ]; then
            args+=("--disk" "$LIMA_DISK")
        fi

        echo -e "Creating $LIMA_VM VM..."
        # Portable way to expand array on bash 3 & 4
        limactl create -y --name "$LIMA_VM" ${args[@]+"${args[@]}"} lima.yaml
    fi

    # Start VM if not running
    status=$(limactl list "$LIMA_VM" --format "{{.Status}}")
    if [ "$status" != "Running" ]; then
        echo -e "Starting $LIMA_VM VM..."
        limactl start -y "$LIMA_VM"

        rm -f NvVars # Remove stray file created by QEMU
    fi
}

# Execute command in Lima VM
lima_exec() {
    # Allocate TTY (-t) for pretty output in nix commands
    # Add -o LogLevel=QUIET to suppress SSH "Shared connection closed" messages
    ssh -F "$HOME/.lima/$LIMA_VM/ssh.config" "lima-$LIMA_VM" \
        -t -o LogLevel=QUIET \
        -- "$@"
}

# Check if in nix environment
in_nix_env() {
    [ -n "${IN_NIX_SHELL:-}" ] || [ -n "${NIX_STORE:-}" ]
}

if [ $# -eq 0 ]; then
    echo "Error: No command specified"
    exit 1
fi

cmd=("$@")

is_mkosi_cmd() {
    [[ "${cmd[0]}" == "mkosi" ]] || [[ "${cmd[0]}" == *"/mkosi" ]]
}

if is_mkosi_cmd && [ -n "${MKOSI_EXTRA_ARGS:-}" ]; then
    # TODO: these args will be overriden by default cache/out dir in Lima
    # Not a big deal, but might worth fixing
    cmd+=($MKOSI_EXTRA_ARGS)
fi

if should_use_lima; then
    setup_lima

    mkosi_cache=/home/debian/mkosi-cache
    mkosi_output=/home/debian/mkosi-output
    mkosi_builddir=/home/debian/mkosi-builddir

    if is_mkosi_cmd; then
        lima_exec mkdir -p "$mkosi_cache" "$mkosi_output" "$mkosi_builddir"

        cmd+=(
            # We can't use default cache dir from mnt/, because it is mounted
            # from host, and mkosi will try to preserve root/other permissions
            # without success.
            "--cache-directory=$mkosi_cache"
            # For the same reason, we need to use separate output dir.
            # mkosi tries to preserve ownership of output files, which fails,
            # as it is running from root in a user namespace.
            "--output-dir=$mkosi_output"
            # Same issue for build directory - must be on local filesystem
            "--build-dir=$mkosi_builddir"
        )
    fi

    # Check nix store free space inside Lima VM and clean if needed
    lima_exec "$(declare -f check_nix_free_space); NIX_MIN_FREE_SPACE_GB=$NIX_MIN_FREE_SPACE_GB check_nix_free_space"

    # Build environment variables to pass to the Lima VM
    # SOURCE_DATE_EPOCH is critical for reproducible builds
    lima_env=""
    if [ -n "${SOURCE_DATE_EPOCH:-}" ]; then
        lima_env="SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH "
    fi

    # Mark ~/mnt as a safe directory to avoid "dubious ownership" errors.
    # The mount is owned by the host user, but Lima runs as debian user.
    lima_exec "git config --global --add safe.directory /home/debian/mnt"

    # Initialize a temporary git repo so Nix respects .gitignore when copying
    # to the store. Without .git, Nix copies ALL files (~1.2GB). With .git,
    # Nix respects .gitignore (~1MB). We remove .git afterward to avoid confusion.
    lima_exec "cd ~/mnt && git init -q && git add -A && git -c user.name='nix' -c user.email='nix@localhost' commit -q -m 'nix' --allow-empty"

    # Set up trap to clean up .git even if interrupted (Ctrl+C, etc.)
    cleanup_git() {
        lima_exec "rm -rf ~/mnt/.git" 2>/dev/null || true
    }
    trap cleanup_git EXIT

    lima_exec "cd ~/mnt && ${lima_env}/home/debian/.nix-profile/bin/nix develop -c ${cmd[*]@Q}"

    # Clean up temporary git repo (also runs via trap on exit)
    cleanup_git
    trap - EXIT

    if is_mkosi_cmd; then
        # Use cp --no-preserve=ownership,timestamps instead of mv to avoid permission errors.
        # - ownership: user IDs in the unshare namespace don't map to valid users on the host
        # - timestamps: SSHFS can't preserve timestamps on symlinks; timestamps are normalized afterward anyway
        lima_exec "mkdir -p ~/mnt/build && cp -a --no-preserve=ownership,timestamps '$mkosi_output'/* ~/mnt/build/ && rm -rf '$mkosi_output'/*" || true

        # Normalize output file timestamps for reproducibility if SOURCE_DATE_EPOCH is set
        # Normalize ALL files in build directory to ensure reproducible outputs
        if [ -n "${SOURCE_DATE_EPOCH:-}" ]; then
            TOUCH_TIME=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || \
                         date -u -r "$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || \
                         echo "197001010000.00")
            if [ -n "$TOUCH_TIME" ]; then
                # Normalize all files and directories in build directory
                find build -mindepth 1 -exec touch -h -t "$TOUCH_TIME" {} \; 2>/dev/null || true
            fi
        fi

        echo "Check ./build/ directory for output files"
        echo
    fi

    echo "Note: Lima VM is still running. To stop it, run: limactl stop $LIMA_VM"
else
    if in_nix_env; then
        exec "${cmd[@]}"
    else
        # Check nix store free space and clean if needed before entering nix environment
        check_nix_free_space
        exec nix develop -c "${cmd[@]}"
    fi
fi
