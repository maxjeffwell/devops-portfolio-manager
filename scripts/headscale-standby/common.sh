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

# dm_live: dm's headscale answers on either path
dm_live() { _health "http://$DM_WG:8081/health" || _health "https://$DM_LAN/health"; }

# local_live: this host's headscale answers
local_live() { _health "http://127.0.0.1:8081/health"; }

ssh_dm()    { ssh "${SSH_OPTS[@]}" -i "$KEY_DM"    "$DM_USER@$DM_LAN" "$@"; }
ssh_be88u() { ssh "${SSH_OPTS[@]}" -i "$KEY_BE88U" -p "$BE88U_PORT" "$BE88U_USER@$BE88U_HOST" "$@"; }
ssh_ax86u() { ssh "${SSH_OPTS[@]}" -i "$KEY_AX86U" -p "$AX86U_PORT" "$AX86U_USER@$AX86U_HOST" "$@"; }
ssh_vps()   { ssh "${SSH_OPTS[@]}" -i "$KEY_VPS"   "$VPS_USER@$VPS_WG" "$@"; }
