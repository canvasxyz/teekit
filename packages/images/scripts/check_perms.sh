#!/bin/bash

check_perms() {
    local path="$1"
    local expected_perms="$2"

    if [ ! -e "$path" ]; then
        echo "Error: $path not found"
        return 1
    fi

    # Cross-platform way to get octal permissions
    perms=$(stat -c "%a" "$path" 2>/dev/null || stat -f "%OLp" "$path" 2>/dev/null)

    if [ "$perms" = "$expected_perms" ]; then
        return 0
    else
        echo "$path has incorrect permissions ($perms), expected $expected_perms"
        return 1
    fi
}

check_perms "base/mkosi.skeleton/init" "755" || chmod 755 base/mkosi.skeleton/init
check_perms "base/mkosi.skeleton/etc" "755" || chmod 755 base/mkosi.skeleton/etc
check_perms "base/mkosi.skeleton/etc/resolv.conf" "644" || chmod 644 base/mkosi.skeleton/etc/resolv.conf

# Ensure mkosi.tools/nix symlink exists for nix store access in sandbox
if [ -d "mkosi.tools" ]; then
    if [ ! -e "mkosi.tools/nix" ]; then
        echo "Creating mkosi.tools/nix symlink for sandbox nix store access..."
        ln -sf /nix mkosi.tools/nix
    fi
fi

echo "Permissions check completed!"
