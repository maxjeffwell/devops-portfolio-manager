#!/bin/sh
# Split-horizon target for headscale.el-jefe.me on the home routers.
# Same file on the BE88U and the AX86U Pro: /jffs/scripts/headscale-dns-target.sh (mode 755).
# Forced command for the m920s standby key (nvram sshd_authkeys):
#   command="/jffs/scripts/headscale-dns-target.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 ...
# Usage: headscale-dns-target.sh {status|dm|m920s}   (SSH_ORIGINAL_COMMAND wins when set)
#   status -> "<router> <current-ip> <tools ok|missing>"   (tools = the reload command this router needs)
#   dm | m920s -> set the record, back up the file, reload the resolver, print status. Idempotent.
# A forced command runs without /etc/profile, so Entware paths are set explicitly.
export PATH=/opt/sbin:/opt/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH
DM=192.168.50.152
M920S=192.168.50.155
NAME=headscale.el-jefe.me
cmd="${SSH_ORIGINAL_COMMAND:-$1}"

case "$(nvram get productid)" in
  RT-BE88U)     R=be88u; F=/jffs/configs/hosts.homearpa; TOOL=service ;;
  RT-AX86U_PRO) R=ax86u; F=/opt/share/unbound/configs/unbound.conf.add; TOOL=unbound-control ;;
  *) echo "headscale-dns-target: unknown router $(nvram get productid)" >&2; exit 65 ;;
esac
tools() { if which "$TOOL" >/dev/null 2>&1 && [ -w "$F" ]; then echo ok; else echo missing; fi; }   # busybox sh on Merlin has no `command` builtin

current() {
  if [ "$R" = be88u ]; then
    grep -E "^[0-9.]+ $NAME\$" "$F" | awk '{print $1}' | head -1
  else
    grep -oE "\"$NAME\. 60 IN A [0-9.]+\"" "$F" | grep -oE '[0-9.]+"$' | tr -d '"' | head -1
  fi
}

set_ip() {
  ip=$1
  [ "$(current)" = "$ip" ] && return 0
  [ "$(tools)" = ok ] || { echo "headscale-dns-target: $R: $TOOL missing or $F not writable" >&2; exit 1; }
  cp -p "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)" || { echo "headscale-dns-target: $R: backup of $F failed" >&2; exit 1; }
  if [ "$R" = be88u ]; then
    sed -i "s/^[0-9.]* $NAME\$/$ip $NAME/" "$F" || { echo "headscale-dns-target: be88u: sed on $F failed" >&2; exit 1; }
    service restart_dnsmasq >/dev/null 2>&1 || { echo "headscale-dns-target: be88u: service restart_dnsmasq failed" >&2; exit 1; }
  else
    sed -i "s/\"$NAME\. 60 IN A [0-9.]*\"/\"$NAME. 60 IN A $ip\"/" "$F" || { echo "headscale-dns-target: ax86u: sed on $F failed" >&2; exit 1; }
    unbound-control local_data_remove "$NAME" >/dev/null 2>&1
    unbound-control local_data "$NAME. 60 IN A $ip" >/dev/null 2>&1 || { echo "headscale-dns-target: ax86u: unbound-control local_data failed" >&2; exit 1; }
  fi
  [ "$(current)" = "$ip" ] || { echo "headscale-dns-target: $R: $F does not show $ip after edit" >&2; exit 1; }
}

case "$cmd" in
  status) ;;
  dm)     set_ip "$DM" ;;
  m920s)  set_ip "$M920S" ;;
  *) echo "headscale-dns-target: refused: ${cmd:-<none>}" >&2; exit 64 ;;
esac
echo "$R $(current) $(tools)"
