# shellcheck shell=bash
# Shared constants and helpers for the headscale cold standby on m920s.
# Installed at /usr/local/lib/headscale-standby/common.sh (mode 644). Source it; do not execute.

DM_LAN=192.168.50.152
DM_WG=10.0.0.9
M920S_LAN=192.168.50.155
M920S_WG=10.0.0.12
BOOTSTRAP_IP=198.51.100.53
HS_NAME=headscale.el-jefe.me

BE88U_HOST=192.168.50.1
BE88U_PORT=2222
BE88U_USER=maxjeffwell
AX86U_HOST=192.168.50.103
AX86U_PORT=2222
AX86U_USER=maxjeffwell
VPS_WG=10.0.0.1
VPS_USER=maxjeffwell
DM_USER=maxjeffwell

KEY_DM=/root/.ssh/headscale-standby-dm
KEY_BE88U=/root/.ssh/headscale-standby-be88u
KEY_AX86U=/root/.ssh/headscale-standby-ax86u
KEY_VPS=/root/.ssh/headscale-standby-vps

STATE=/var/lib/headscale
STAGING=/var/lib/headscale/standby
METRICS=/var/lib/node_exporter/textfile_collector/headscale_standby.prom
LIB=/usr/local/lib/headscale-standby
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new)

log() { echo "$*"; logger -t headscale-standby -- "$*"; }

# _health URL -> 0 if HTTP 200 within 3 s
_health() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null)" = 200 ]; }

# _health_host <hostname> <ip> <path> -> 0 if https://<hostname><path> served at <ip> answers 200 (cert checked against hostname)
_health_host() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 --resolve "$1:443:$2" "https://$1$3" 2>/dev/null)" = 200 ]; }

# dm_live: dm's headscale answers on either path (wg0 http, or LAN https via its nginx by hostname)
dm_live_wg()  { _health "http://$DM_WG:8081/health"; }
dm_live_lan() { _health_host "$HS_NAME" "$DM_LAN" /health; }
dm_live()     { dm_live_wg || dm_live_lan; }

# hs_active: this host's headscale.service is active (overridable in tests)
hs_active() { systemctl is-active --quiet headscale; }

EDGE_NAME=edge.el-jefe.me
vps_public_ip() { dig +short +time=2 "$EDGE_NAME" @"$BE88U_HOST" 2>/dev/null | grep -E '^[0-9.]+$' | head -1; }

# local_live: this host's headscale answers
local_live() { _health "http://127.0.0.1:8081/health"; }

ssh_dm()    { ssh "${SSH_OPTS[@]}" -i "$KEY_DM"    "$DM_USER@$DM_LAN" "$@"; }
ssh_be88u() { ssh "${SSH_OPTS[@]}" -i "$KEY_BE88U" -p "$BE88U_PORT" "$BE88U_USER@$BE88U_HOST" "$@"; }
ssh_ax86u() { ssh "${SSH_OPTS[@]}" -i "$KEY_AX86U" -p "$AX86U_PORT" "$AX86U_USER@$AX86U_HOST" "$@"; }
ssh_vps()   { ssh "${SSH_OPTS[@]}" -i "$KEY_VPS"   "$VPS_USER@$VPS_WG" "$@"; }

# ---- pointer helpers (the four things promote/demote flip) ----
# pointer_target_ip <be88u|ax86u|vps|endpoints> <dm|m920s> -> the IP that pointer holds for that host
pointer_target_ip() {
  case "$1:$2" in
    be88u:dm|ax86u:dm)             echo "$DM_LAN" ;;
    be88u:m920s|ax86u:m920s)       echo "$M920S_LAN" ;;
    vps:dm|endpoints:dm)           echo "$DM_WG" ;;
    vps:m920s|endpoints:m920s)     echo "$M920S_WG" ;;
    *) return 1 ;;
  esac
}
# get_pointer <name> -> current IP (empty on failure)
get_pointer() {
  case "$1" in
    be88u)     ssh_be88u status 2>/dev/null | awk '{print $2}' ;;
    ax86u)     ssh_ax86u status 2>/dev/null | awk '{print $2}' ;;
    vps)       ssh_vps status 2>/dev/null | awk '$3=="yes"{print $2}' ;;   # empty unless the DNAT rule is really in place
    endpoints) kubectl -n headscale get endpoints headscale -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null ;;
    *) return 1 ;;
  esac
}
# set_pointer <name> <dm|m920s> -> prints resulting IP; non-zero if it did not land
set_pointer() {
  local want; want=$(pointer_target_ip "$1" "$2") || return 1
  local got
  case "$1" in
    be88u)     got=$(ssh_be88u "$2" | awk '{print $2}') ;;
    ax86u)     got=$(ssh_ax86u "$2" | awk '{print $2}') ;;
    vps)       got=$(ssh_vps "$2" | awk '{print $2}') ;;
    endpoints) kubectl -n headscale patch endpoints headscale --type=json \
                 -p "[{\"op\":\"replace\",\"path\":\"/subsets/0/addresses/0/ip\",\"value\":\"$want\"}]" >/dev/null \
               && got=$(get_pointer endpoints) ;;
    *) return 1 ;;
  esac
  echo "$got"; [ "$got" = "$want" ]
}
sync_age() { local t; t=$(cat "$STAGING/.last-sync" 2>/dev/null || echo 0); echo $(( $(date +%s) - t )); }

# ---- promote/demote state helpers (all overridable in tests via hs_active/STATE) ----
# install_snapshot_needed: the staged snapshot must become the live db only when headscale is NOT running and no live db exists
install_snapshot_needed() { ! hs_active && [ ! -f "$STATE/db.sqlite" ]; }
# install_snapshot: never replaces a db that may be open
install_snapshot() {
  if hs_active; then echo "refusing to replace $STATE/db.sqlite while headscale is active" >&2; return 1; fi
  rm -f "$STATE"/db.sqlite "$STATE"/db.sqlite-wal "$STATE"/db.sqlite-shm "$STATE/.db-sent-to-dm" || return 1
  cp "$STAGING/db.sqlite" "$STATE/db.sqlite" && cp "$STAGING/noise_private.key" "$STATE/noise_private.key" || return 1
  chown headscale:headscale "$STATE"/db.sqlite "$STATE"/noise_private.key && chmod 600 "$STATE"/db.sqlite "$STATE"/noise_private.key
}
# promote_snapshot_guards_apply: the snapshot-age / no-snapshot guards only matter before the snapshot is installed
promote_snapshot_guards_apply() { ! hs_active && [ ! -f "$STATE/db.sqlite" ]; }
# demote_db_copy_done: a copy marker counts only while headscale is stopped (a live headscale keeps writing after the marker)
demote_db_copy_done() { [ -f "$STATE/.db-sent-to-dm" ] && ! hs_active; }
# local_db_info: "nodes=N last_seen=<iso|none> mtime=<epoch>" for the live db (readable while headscale runs)
local_db_info() {
  [ -f "$STATE/db.sqlite" ] || { echo "nodes=0 last_seen=none mtime=0 (no live db)"; return 0; }
  echo "nodes=$(sqlite3 "$STATE/db.sqlite" 'SELECT count(*) FROM nodes' 2>/dev/null || echo '?') last_seen=$(sqlite3 "$STATE/db.sqlite" 'SELECT coalesce(max(last_seen),"none") FROM nodes' 2>/dev/null || echo '?') mtime=$(stat -c %Y "$STATE/db.sqlite")"
}
