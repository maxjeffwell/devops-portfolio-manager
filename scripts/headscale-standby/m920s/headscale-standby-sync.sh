#!/bin/bash
# Pull a consistent headscale snapshot from dm into the standby staging dir on m920s.
# Runs from headscale-standby-sync.timer every minute. Never touches the live DB.
# Exit: 0 synced, 1 sync failed (metrics still written), 3 refused (local headscale is live).
set -uo pipefail
source /usr/local/lib/headscale-standby/common.sh

write_metrics() { # $1 sync_ok $2 last_sync_epoch $3 dm_up $4 local_up
  local tmp; tmp=$(mktemp "$(dirname "$METRICS")/.headscale_standby.XXXXXX")
  cat > "$tmp" <<EOF
# HELP headscale_standby_last_sync_timestamp_seconds Unix time of the last successful snapshot pull from dm.
# TYPE headscale_standby_last_sync_timestamp_seconds gauge
headscale_standby_last_sync_timestamp_seconds $2
# HELP headscale_standby_sync_ok 1 if the last sync run succeeded.
# TYPE headscale_standby_sync_ok gauge
headscale_standby_sync_ok $1
# HELP headscale_standby_health_up 1 if that host's headscale answers /health.
# TYPE headscale_standby_health_up gauge
headscale_standby_health_up{target="dm"} $3
headscale_standby_health_up{target="m920s"} $4
EOF
  chmod 644 "$tmp" && mv "$tmp" "$METRICS"
}

last_sync() { cat "$STAGING/.last-sync" 2>/dev/null || echo 0; }

dm_up=0; local_up=0
dm_live && dm_up=1
local_live && local_up=1

if [ "$local_up" = 1 ]; then
  log "refusing: local headscale is live"
  write_metrics 0 "$(last_sync)" "$dm_up" "$local_up"
  exit 3
fi

tmp=$(mktemp -d "$STAGING/.tmp.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

if ! ssh_dm export | tar -x -C "$tmp"; then
  log "sync failed: export from dm"
  write_metrics 0 "$(last_sync)" "$dm_up" "$local_up"; exit 1
fi
if [ "$(sqlite3 "$tmp/db.sqlite" 'PRAGMA integrity_check')" != ok ]; then
  log "sync failed: snapshot integrity_check not ok"
  write_metrics 0 "$(last_sync)" "$dm_up" "$local_up"; exit 1
fi
if ! ssh_dm config > "$tmp/dm-config.yaml" || [ ! -s "$tmp/dm-config.yaml" ]; then
  log "sync failed: config from dm"
  write_metrics 0 "$(last_sync)" "$dm_up" "$local_up"; exit 1
fi

chmod 600 "$tmp"/db.sqlite "$tmp"/noise_private.key "$tmp"/dm-config.yaml
mv -f "$tmp/db.sqlite" "$STAGING/db.sqlite"
mv -f "$tmp/noise_private.key" "$STAGING/noise_private.key"
mv -f "$tmp/dm-config.yaml" "$STAGING/dm-config.yaml"
now=$(date +%s); echo "$now" > "$STAGING/.last-sync"

# drift check: dm's config rewritten for m920s should equal the standby's hand-managed config
if ! diff -q <(sed -f "$LIB/config.yaml.sed" "$STAGING/dm-config.yaml") /etc/headscale/config.yaml >/dev/null; then
  log "WARN: dm config drifted from standby config (diff $STAGING/dm-config.yaml vs /etc/headscale/config.yaml)"
fi

write_metrics 1 "$now" "$dm_up" "$local_up"
exit 0
