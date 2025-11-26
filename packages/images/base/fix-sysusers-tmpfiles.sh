#!/bin/bash
set -euo pipefail

# Fix systemd configuration files that use newer syntax not understood by the host's
# systemd-sysusers and systemd-tmpfiles utilities.
#
# The modifiers like 'u!', 'L$', 'd$' were added in systemd v256+ and cause errors
# when the host system's tools are older.
#
# This script runs as a PrepareScript (before sysusers/tmpfiles) to remove these files
# that will be cleaned up by debloat.sh anyway.

# Remove tmpfiles.d - these use new 'L$' and 'd$' modifiers
rm -rf "$BUILDROOT/usr/lib/tmpfiles.d"

# Remove sysusers.d - these use new 'u!' modifier  
rm -rf "$BUILDROOT/usr/lib/sysusers.d"

# Also clean up systemd network config that uses new syntax
rm -rf "$BUILDROOT/usr/lib/systemd/network"

