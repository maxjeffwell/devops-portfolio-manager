#!/bin/bash
# Read-only view of who is live and where every pointer points. Run as root on m920s.
set -uo pipefail
source /usr/local/lib/headscale-standby/common.sh

up() { if "$1"; then echo up; else echo down; fi; }
echo "dm-health $(up dm_live)"
echo "m920s-health $(up local_live)"
for p in be88u ax86u vps endpoints; do echo "$p $(get_pointer "$p")"; done
echo "sync-age $(sync_age)"
echo "timer $(systemctl is-enabled headscale-standby-sync.timer 2>/dev/null || echo missing)"
