#!/bin/sh
# NUT SHUTDOWNCMD: cordon + bounded drain of this k3s node, then halt.
# Runs as root from upsmon. Leaves a marker so k3s-uncordon-onboot.service
# undoes the cordon on the next boot (a deliberate maintenance cordon leaves
# no marker and is therefore never undone).
KUBECONFIG=/etc/kubernetes/node-powerfail.kubeconfig
KUBECTL=/usr/local/bin/kubectl
NODE=$(hostname)
FLAG=/var/lib/nut-drained.flag
LOG=/var/log/nut-drain.log
export KUBECONFIG
{
  echo "=== $(date '+%F %T') NUT shutdown: cordon+drain ${NODE} ==="
  timeout 20 "$KUBECTL" --request-timeout=10s cordon "$NODE"
  echo "cordon exit=$?"
  touch "$FLAG"
  timeout 150 "$KUBECTL" --request-timeout=15s drain "$NODE" \
      --ignore-daemonsets \
      --delete-emptydir-data \
      --force \
      --grace-period=30 \
      --timeout=120s \
      --skip-wait-for-delete-timeout=10
  echo "drain exit=$?"
  echo "=== $(date '+%F %T') drain done, halting ==="
} >> "$LOG" 2>&1
/sbin/shutdown -h +0
