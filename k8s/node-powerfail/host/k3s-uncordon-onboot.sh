#!/bin/sh
# Uncordon this node on boot ONLY if the previous shutdown was a UPS
# power-fail drain (marker present). Marker is cleared only on success so an
# unreachable API retries on the next boot.
FLAG=/var/lib/nut-drained.flag
[ -f "$FLAG" ] || exit 0

KUBECONFIG=/etc/kubernetes/node-powerfail.kubeconfig
KUBECTL=/usr/local/bin/kubectl
NODE=$(hostname)
LOG=/var/log/nut-drain.log
export KUBECONFIG

# Wait up to ~2 min for the API (over Tailscale) after boot.
i=0
while [ "$i" -lt 24 ]; do
  if timeout 10 "$KUBECTL" --request-timeout=8s get node "$NODE" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 5
done

{
  echo "=== $(date '+%F %T') boot: uncordon ${NODE} (post-drain marker present) ==="
  timeout 30 "$KUBECTL" --request-timeout=15s uncordon "$NODE"
  rc=$?
  echo "uncordon exit=${rc}"
  if [ "$rc" -eq 0 ]; then
    rm -f "$FLAG"
    echo "marker cleared"
  fi
} >> "$LOG" 2>&1
