#!/bin/bash
# Boot gate: wait (bounded) for the NAS NFS servers before k3s-agent starts,
# so pods with NFS volumes and host automounts don't come up against a NAS
# that is still booting after a power outage. Never blocks forever: after
# DEADLINE seconds it logs a warning and exits 0 so the node still joins.
DEADLINE=${DEADLINE:-900}
INTERVAL=5
# ip:export pairs. The export must appear in showmount -e (proves exports are
# loaded, not just nfsd listening). Falls back to a TCP check on 2049 where
# showmount is not installed.
TARGETS="192.168.50.149:/mnt/backups 192.168.50.109:/volume1/k8s-nfs"

ready() {
  local ip=$1 exp=$2
  if [ -x /usr/sbin/showmount ]; then
    timeout 8 /usr/sbin/showmount -e "$ip" 2>/dev/null | grep -q "^${exp}[[:space:]]"
  else
    timeout 3 bash -c "exec 3<>/dev/tcp/${ip}/2049" 2>/dev/null
  fi
}

start=$(date +%s)
while :; do
  pending=""
  for t in $TARGETS; do
    ready "${t%%:*}" "${t#*:}" || pending="$pending $t"
  done
  if [ -z "$pending" ]; then
    logger -t nfs-gate "all NFS servers ready after $(( $(date +%s) - start ))s"
    exit 0
  fi
  if [ $(( $(date +%s) - start )) -ge "$DEADLINE" ]; then
    logger -t nfs-gate "WARNING: deadline ${DEADLINE}s reached, still waiting on:${pending} - starting k3s anyway"
    exit 0
  fi
  sleep "$INTERVAL"
done
