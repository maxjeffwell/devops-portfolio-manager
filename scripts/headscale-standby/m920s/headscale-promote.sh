#!/bin/bash
# Make m920s the live headscale. Run as root on m920s.
#   headscale-promote.sh [--force] [--dry-run]
# Exit: 0 done (or nothing to do), 2 refused by a guard, 1 a step failed (earlier steps stay done; re-run to finish).
set -uo pipefail
source /usr/local/lib/headscale-standby/common.sh

FORCE=""; DRY=""
for a in "$@"; do case "$a" in --force) FORCE=1 ;; --dry-run) DRY=1 ;; *) echo "usage: $0 [--force] [--dry-run]" >&2; exit 64 ;; esac; done

# ---- guards ----
if dm_live && [ -z "$FORCE" ]; then
  echo "refused: dm headscale answers (use --force to override)"; exit 2
fi
age=$(sync_age)
if [ "$age" -gt 900 ] && [ -z "$FORCE" ]; then
  echo "refused: last sync ${age}s ago (use --force to promote from a stale snapshot)"; exit 2
fi
[ -s "$STAGING/db.sqlite" ] || { echo "refused: no snapshot in $STAGING"; exit 2; }
echo "snapshot age ${age}s, dm $(dm_live && echo up || echo down), force=${FORCE:-0}"

results=()
run() { # run <label> <already-check-cmd> <action-cmd>
  local label=$1 check=$2 action=$3
  if eval "$check"; then echo "already: $label"; results+=("$label: already"); return 0; fi
  if [ -n "$DRY" ]; then echo "WOULD: $label"; return 0; fi
  echo "doing: $label"
  if eval "$action"; then results+=("$label: OK"); log "promote: $label OK"; else results+=("$label: FAIL"); log "promote: $label FAILED"; return 1; fi
}
fail() { echo "FAILED at: $1 — fix and re-run; completed steps are skipped as 'already'"; printf '  %s\n' "${results[@]}"; exit 1; }

run "sync timer off" \
    '[ "$(systemctl is-enabled headscale-standby-sync.timer 2>/dev/null)" = disabled ]' \
    'systemctl disable --now headscale-standby-sync.timer >/dev/null 2>&1' || fail "sync timer off"

run "install snapshot as live db" \
    '[ -f "$STATE/db.sqlite" ] && cmp -s "$STAGING/db.sqlite" "$STATE/db.sqlite" 2>/dev/null' \
    'rm -f "$STATE"/db.sqlite "$STATE"/db.sqlite-wal "$STATE"/db.sqlite-shm && cp "$STAGING/db.sqlite" "$STATE/db.sqlite" && cp "$STAGING/noise_private.key" "$STATE/noise_private.key" && chown headscale:headscale "$STATE"/db.sqlite "$STATE"/noise_private.key && chmod 600 "$STATE"/db.sqlite "$STATE"/noise_private.key' || fail "install snapshot as live db"

wait_health() { local i; for i in $(seq 1 30); do local_live && return 0; sleep 1; done; return 1; }
run "start headscale" 'local_live' \
    'systemctl enable --now headscale >/dev/null 2>&1 && wait_health' || fail "start headscale"
if [ -z "$DRY" ]; then
  n=$(headscale nodes list -o json 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo "?")
  echo "headscale nodes: $n"
fi

run "start nginx" 'systemctl is-active --quiet nginx' \
    'systemctl enable --now nginx >/dev/null 2>&1 && nginx -t >/dev/null 2>&1' || fail "start nginx"

for p in be88u ax86u vps endpoints; do
  run "pointer $p -> m920s" \
      "[ \"\$(get_pointer $p)\" = \"$(pointer_target_ip "$p" m920s)\" ]" \
      "set_pointer $p m920s >/dev/null" || fail "pointer $p"
done

verify() {
  local ok=0
  for r in "$BE88U_HOST" "$AX86U_HOST"; do
    a=$(dig +short +time=2 "$HS_NAME" @"$r" | head -1)
    [ "$a" = "$M920S_LAN" ] && echo "  dns @$r: $a OK" || { echo "  dns @$r: ${a:-none} FAIL"; ok=1; }
  done
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$HS_NAME:443:$M920S_LAN" "https://$HS_NAME/health")
  [ "$c" = 200 ] && echo "  lan https: $c OK" || { echo "  lan https: $c FAIL"; ok=1; }
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$M920S_WG:8081/health")
  [ "$c" = 200 ] && echo "  wg0 http: $c OK" || { echo "  wg0 http: $c FAIL"; ok=1; }
  v=$(get_pointer vps); [ "$v" = "$M920S_WG" ] && echo "  vps dnat: $v OK" || { echo "  vps dnat: ${v:-none} FAIL"; ok=1; }
  e=$(get_pointer endpoints); [ "$e" = "$M920S_WG" ] && echo "  endpoints: $e OK" || { echo "  endpoints: ${e:-none} FAIL"; ok=1; }
  return $ok
}
if [ -n "$DRY" ]; then echo "WOULD: verify (dns x2, lan https, wg0 http, vps, endpoints)"; echo "dry-run complete, nothing changed"; exit 0; fi

echo "verify:"; verify && vr=OK || vr=FAIL
echo "summary:"; printf '  %s\n' "${results[@]}"; echo "  verify: $vr"
echo "demote with: headscale-demote.sh"
[ "$vr" = OK ]
