#!/bin/bash
# Off-box archive of asustor-zfs snapshots to Garage S3 bucket 'zfs-archive'.
# Runs as the third tier of the snapshot lifecycle:
#   03:00  K8s CronJob takes VolumeSnapshot CRs (creates ZFS snapshots via openebs-zfs CSI)
#   03:15  syncoid replicates asustor-zfs -> synology-zfs (in-pool HA tier)
#   03:30  THIS SCRIPT: zfs send -> Garage (off-box doomsday tier)
#
# Strategy: incremental sends keyed by per-dataset state file. First run does full;
# subsequent runs send the delta between last-archived snapshot and current latest.
# State recovery: if the last-archived snapshot has been pruned locally, falls back
# to a fresh full send.

set -euo pipefail

POOL="asustor-zfs"
BUCKET="zfs-archive"
ENDPOINT="https://s3.el-jefe.me"
STATE_DIR="/var/lib/zfs-archive/state"
LOCK_FILE="/var/lib/zfs-archive/.lock"
ZSTD_LEVEL="${ZSTD_LEVEL:-3}"

mkdir -p "$STATE_DIR"

# Single-instance guard
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date)] another zfs-archive run is in progress, exiting" >&2
  exit 0
fi

log() { echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] $*"; }

# Tooling sanity
for cmd in zfs zstd aws flock; do
  command -v "$cmd" >/dev/null || { log "ERROR: $cmd not in PATH"; exit 1; }
done

# Credentials must come from EnvironmentFile (systemd) or external sourcing.
[[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]] \
  || { log "ERROR: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set"; exit 1; }
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

archive_dataset() {
  local dataset="$1"                                        # e.g. asustor-zfs/pvc-abc
  local short_name="${dataset#${POOL}/}"                    # pvc-abc
  local state_file="$STATE_DIR/$(echo "$short_name" | tr '/' '_').last"

  # Latest snapshot on this dataset (sorted by creation, last = newest)
  local latest_snap
  latest_snap="$(zfs list -t snapshot -H -o name -s creation "$dataset" 2>/dev/null | tail -1 || true)"
  [[ -n "$latest_snap" ]] || { log "$dataset: no snapshots, skipping"; return; }

  local snap_name="${latest_snap#*@}"
  local last_sent=""
  [[ -f "$state_file" ]] && last_sent="$(cat "$state_file")"

  # Sunday: force fresh full so incremental chains never exceed 7 links.
  # Bounded chain length = bounded restore time and bounded blast radius if a stream corrupts.
  if [[ "$(date +%u)" == "7" ]]; then
    last_sent=""
    log "$dataset: Sunday — forcing fresh full send"
  fi

  if [[ "$last_sent" == "$snap_name" ]]; then
    log "$dataset: $snap_name already archived"
    return
  fi

  local s3_key send_cmd
  if [[ -z "$last_sent" ]] || ! zfs list "$dataset@$last_sent" >/dev/null 2>&1; then
    # First send for this dataset, or the previous baseline got pruned locally — full send
    s3_key="$short_name/${snap_name}.full.zst"
    send_cmd=(zfs send "$dataset@$snap_name")
    log "$dataset: FULL send -> s3://$BUCKET/$s3_key"
  else
    # Incremental from last archived snapshot to current latest
    s3_key="$short_name/${last_sent}__${snap_name}.incr.zst"
    send_cmd=(zfs send -i "$dataset@$last_sent" "$dataset@$snap_name")
    log "$dataset: INCR send ${last_sent} -> ${snap_name} -> s3://$BUCKET/$s3_key"
  fi

  if "${send_cmd[@]}" \
       | zstd -"$ZSTD_LEVEL" -T0 --quiet \
       | aws s3 cp --endpoint-url="$ENDPOINT" --quiet - "s3://$BUCKET/$s3_key"
  then
    echo "$snap_name" > "$state_file"
    log "$dataset: archived $snap_name OK"
  else
    log "$dataset: archive FAILED (state file unchanged, will retry next run)" >&2
    return 1
  fi
}

log "=== zfs-archive run starting (pool=$POOL bucket=$BUCKET) ==="

# Iterate every child dataset of the pool. The pool root itself (e.g. 'asustor-zfs')
# is line 1 of `zfs list -r`, so `tail -n +2` cleanly skips it.
# (Avoid `grep -v` here: it returns exit 1 when filtering out the only line, which
# combined with pipefail would fail the whole pipeline on an empty pool.)
zfs list -H -o name -r "$POOL" | tail -n +2 | while read -r ds; do
  archive_dataset "$ds" || log "$ds: continuing despite failure"
done

# ------------------------------------------------------------
# RETENTION: delete Garage objects older than RETAIN_DAYS
# ------------------------------------------------------------
# Sunday-forced-full (above) caps incremental chain length at 7 links, so
# this 30-day cutoff means at most ~4 weekly chains live in Garage. When an
# old full's expiration arrives, its descendants will also be over the cutoff
# (they were sent within the same week), so the whole chain gets pruned together.
RETAIN_DAYS=30
log "=== pruning Garage objects older than ${RETAIN_DAYS} days ==="
NOW=$(date +%s)
PRUNE_COUNT=0
aws s3 ls --endpoint-url="$ENDPOINT" --recursive "s3://$BUCKET/" 2>/dev/null \
  | while read -r DATE TIME _SIZE KEY; do
      [[ -z "${KEY:-}" ]] && continue
      OBJ_TS=$(date -d "$DATE $TIME" +%s 2>/dev/null) || continue
      AGE_DAYS=$(( (NOW - OBJ_TS) / 86400 ))
      if [[ "$AGE_DAYS" -gt "$RETAIN_DAYS" ]]; then
        log "pruning s3://$BUCKET/$KEY (age: ${AGE_DAYS}d)"
        aws s3 rm --endpoint-url="$ENDPOINT" --quiet "s3://$BUCKET/$KEY" || \
          log "WARN: failed to prune $KEY (will retry next run)"
      fi
    done

log "=== zfs-archive run complete ==="
