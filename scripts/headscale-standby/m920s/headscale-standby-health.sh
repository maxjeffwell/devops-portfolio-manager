#!/bin/bash
# Always-on health probe for the two headscale hosts. Runs from headscale-standby-health.timer every minute,
# in BOTH standby and promoted states (promote/demote never touch this timer). Feeds HeadscaleTwoWriters.
set -uo pipefail
source /usr/local/lib/headscale-standby/common.sh
HEALTH_METRICS=/var/lib/node_exporter/textfile_collector/headscale_standby_health.prom
dm_up=0; local_up=0
dm_live && dm_up=1
local_live && local_up=1
tmp=$(mktemp "$(dirname "$HEALTH_METRICS")/.headscale_standby_health.XXXXXX")
cat > "$tmp" <<EOM
# HELP headscale_standby_health_up 1 if that host's headscale answers /health (probed from m920s).
# TYPE headscale_standby_health_up gauge
headscale_standby_health_up{target="dm"} $dm_up
headscale_standby_health_up{target="m920s"} $local_up
EOM
chmod 644 "$tmp" && mv "$tmp" "$HEALTH_METRICS"
