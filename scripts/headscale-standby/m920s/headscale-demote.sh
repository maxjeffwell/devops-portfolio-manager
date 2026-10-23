#!/bin/bash
# Hand headscale back to dm. Run as root on m920s.
#   headscale-demote.sh [--keep-dm-db] [--dry-run]
# Preconditions: dm reachable over the standby key AND dm's headscale.service stopped (the operator stops it; this script never does).
# Default: the standby's live database is copied to dm (it was the writer). --keep-dm-db skips that copy.
# Exit: 0 done, 2 refused by a guard, 1 a step failed (earlier steps stay done; re-run to finish).
set -uo pipefail
source /usr/local/lib/headscale-standby/common.sh

KEEP=""; DRY=""
for a in "$@"; do case "$a" in --keep-dm-db) KEEP=1 ;; --dry-run) DRY=1 ;; *) echo "usage: $0 [--keep-dm-db] [--dry-run]" >&2; exit 64 ;; esac; done

# ---- guards ----
state=$(ssh_dm state 2>/dev/null) || { echo "refused: dm not reachable over the standby key"; exit 2; }
if [ "$state" != inactive ] && [ "$state" != failed ]; then
  echo "refused: dm headscale is $state (stop it on dm first: sudo systemctl stop headscale)"; exit 2
fi
echo "dm headscale: $state; m920s $(local_live && echo live || echo not live); keep-dm-db=${KEEP:-0}"

results=()
run() { # run <label> <already-check-cmd> <action-cmd>
  local label=$1 check=$2 action=$3
  if eval "$check"; then echo "already: $label"; results+=("$label: already"); return 0; fi
  if [ -n "$DRY" ]; then echo "WOULD: $label"; return 0; fi
  echo "doing: $label"
  if eval "$action"; then results+=("$label: OK"); log "demote: $label OK"; else results+=("$label: FAIL"); log "demote: $label FAILED"; return 1; fi
}
fail() { echo "FAILED at: $1 — fix and re-run; completed steps are skipped as 'already'"; printf '  %s\n' "${results[@]}"; exit 1; }

ts=$(date +%Y%m%d-%H%M%S)
if [ -z "$KEEP" ]; then
  run "copy standby db to dm" \
      '[ ! -f "$STATE/db.sqlite" ] || [ -f "$STATE/.db-sent-to-dm" ]' \
      'sqlite3 "$STATE/db.sqlite" ".backup $STATE/.demote-export.sqlite" && tar -C "$STATE" -c --transform="s/^.demote-export.sqlite\$/db.sqlite/" .demote-export.sqlite | ssh_dm receive-db && rm -f "$STATE/.demote-export.sqlite" && touch "$STATE/.db-sent-to-dm"' || fail "copy standby db to dm"
else
  echo "skip: copy standby db to dm (--keep-dm-db)"
fi

run "stop headscale and nginx on m920s" \
    '! systemctl is-active --quiet headscale && ! systemctl is-active --quiet nginx' \
    'systemctl disable --now headscale nginx >/dev/null 2>&1; ! local_live' || fail "stop headscale and nginx on m920s"

run "retire live db on m920s" \
    '[ ! -f "$STATE/db.sqlite" ]' \
    'mv "$STATE/db.sqlite" "$STATE/db.sqlite.demoted-$ts" && rm -f "$STATE"/db.sqlite-wal "$STATE"/db.sqlite-shm "$STATE/.db-sent-to-dm"' || fail "retire live db on m920s"

for p in be88u ax86u vps endpoints; do
  run "pointer $p -> dm" \
      "[ \"\$(get_pointer $p)\" = \"$(pointer_target_ip "$p" dm)\" ]" \
      "set_pointer $p dm >/dev/null" || fail "pointer $p"
done

run "start headscale on dm" 'dm_live' 'ssh_dm start' || fail "start headscale on dm"

run "sync timer on" \
    '[ "$(systemctl is-enabled headscale-standby-sync.timer 2>/dev/null)" = enabled ]' \
    'systemctl enable --now headscale-standby-sync.timer >/dev/null 2>&1' || fail "sync timer on"

verify() {
  local ok=0
  for r in "$BE88U_HOST" "$AX86U_HOST"; do
    a=$(dig +short +time=2 "$HS_NAME" @"$r" | head -1)
    [ "$a" = "$DM_LAN" ] && echo "  dns @$r: $a OK" || { echo "  dns @$r: ${a:-none} FAIL"; ok=1; }
  done
  dm_live && echo "  dm health: OK" || { echo "  dm health: FAIL"; ok=1; }
  v=$(get_pointer vps); [ "$v" = "$DM_WG" ] && echo "  vps dnat: $v OK" || { echo "  vps dnat: ${v:-none} FAIL"; ok=1; }
  e=$(get_pointer endpoints); [ "$e" = "$DM_WG" ] && echo "  endpoints: $e OK" || { echo "  endpoints: ${e:-none} FAIL"; ok=1; }
  return $ok
}
if [ -n "$DRY" ]; then echo "WOULD: verify (dns x2, dm health, vps, endpoints)"; echo "dry-run complete, nothing changed"; exit 0; fi

echo "verify:"; verify && vr=OK || vr=FAIL
echo "summary:"; printf '  %s\n' "${results[@]}"; echo "  verify: $vr"
[ "$vr" = OK ]
