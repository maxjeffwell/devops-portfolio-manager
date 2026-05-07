#!/bin/bash
# Wrapper around syncoid to replicate asustor-zfs -> synology-zfs.
# Exits cleanly if asustor-zfs has no child datasets (transient empty-pool state),
# rather than failing the systemd service.

set -euo pipefail

POOL_SRC="asustor-zfs"
POOL_DST="synology-zfs/asustor-zfs"

# How many entries does `zfs list -r` return? 1 = just the pool root, no children.
child_count=$(($(zfs list -H -o name -r "$POOL_SRC" | wc -l) - 1))

if [[ "$child_count" -eq 0 ]]; then
  echo "$(date) $POOL_SRC has no child datasets, nothing to replicate"
  exit 0
fi

echo "$(date) $POOL_SRC has $child_count child dataset(s), starting syncoid"
exec /usr/sbin/syncoid \
  --recursive \
  --skip-parent \
  --no-sync-snap \
  --quiet \
  "$POOL_SRC" "$POOL_DST"
