#!/bin/bash
# Root-side helper on dm for the standby wrapper. Installed at /usr/local/sbin/headscale-standby-dmside.sh (755).
# Called only via sudo from headscale-standby-export.sh. Verbs:
#   export      -> tar stream: db.sqlite (online-backup snapshot) + noise_private.key
#   config      -> /etc/headscale/config.yaml
#   state       -> systemctl is-active headscale (always exit 0)
#   info        -> "nodes=N last_seen=<iso|none> mtime=<epoch>" for dm's db (readable whether headscale runs or not)
#   receive-db  -> read a tar with db.sqlite from stdin; keep the current db as db.sqlite.demoted-<ts>; install the new one
#   start       -> systemctl start headscale nginx headscale-bootstrap-dnat (refuses if headscale already active)
set -euo pipefail
STATE=/var/lib/headscale
EXPORT=standby-export.sqlite

case "${1:-}" in
  export)
    sqlite3 "$STATE/db.sqlite" ".backup $STATE/$EXPORT"
    tar -C "$STATE" -c --transform="s/^$EXPORT\$/db.sqlite/" "$EXPORT" noise_private.key
    ;;
  config)
    cat /etc/headscale/config.yaml
    ;;
  state)
    systemctl is-active headscale || true
    ;;
  info)
    if [ -f "$STATE/db.sqlite" ]; then
      echo "nodes=$(sqlite3 "$STATE/db.sqlite" 'SELECT count(*) FROM nodes' 2>/dev/null || echo '?') last_seen=$(sqlite3 "$STATE/db.sqlite" 'SELECT coalesce(max(last_seen),"none") FROM nodes' 2>/dev/null || echo '?') mtime=$(stat -c %Y "$STATE/db.sqlite") state=$(systemctl is-active headscale || true)"
    else
      echo "nodes=0 last_seen=none mtime=0 state=$(systemctl is-active headscale || true) (no db)"
    fi
    ;;
  receive-db)
    if systemctl is-active --quiet headscale; then echo "dmside: refusing receive-db while headscale is active" >&2; exit 2; fi
    tmp=$(mktemp -d "$STATE/.recv.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
    tar -x -C "$tmp" db.sqlite
    [ "$(sqlite3 "$tmp/db.sqlite" 'PRAGMA integrity_check')" = ok ] || { echo "dmside: received db failed integrity_check" >&2; exit 1; }
    ts=$(date +%Y%m%d-%H%M%S)
    if [ -f "$STATE/db.sqlite" ]; then
      sqlite3 "$STATE/db.sqlite" 'PRAGMA wal_checkpoint(TRUNCATE)' >/dev/null 2>&1 || true   # fold the WAL into the forensic copy
      mv "$STATE/db.sqlite" "$STATE/db.sqlite.demoted-$ts"
    fi
    rm -f "$STATE/db.sqlite-wal" "$STATE/db.sqlite-shm"
    install -m 600 -o headscale -g headscale "$tmp/db.sqlite" "$STATE/db.sqlite"
    echo "dmside: installed db ($(sqlite3 "$STATE/db.sqlite" 'SELECT count(*) FROM nodes') nodes); previous kept as db.sqlite.demoted-$ts"
    ;;
  start)
    if systemctl is-active --quiet headscale; then echo "dmside: headscale already active" >&2; exit 2; fi
    systemctl start headscale nginx headscale-bootstrap-dnat
    for i in $(seq 1 30); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8081/health)" = 200 ] && { echo "dmside: headscale up"; exit 0; }
      sleep 1
    done
    echo "dmside: headscale did not answer /health within 30s" >&2; exit 1
    ;;
  *)
    echo "dmside: refused: ${1:-<none>}" >&2; exit 64
    ;;
esac
