#!/bin/bash
# Sync headscale.el-jefe.me TLS cert from cert-manager secret to local nginx.
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
DIR=/etc/headscale/tls
NEWCRT=$(kubectl -n headscale get secret headscale-tls -o jsonpath='{.data.tls\.crt}' | base64 -d)
[ -n "$NEWCRT" ] || exit 1
if ! diff -q <(printf '%s' "$NEWCRT") "$DIR/tls.crt" >/dev/null 2>&1; then
  printf '%s' "$NEWCRT" > "$DIR/tls.crt.new"
  kubectl -n headscale get secret headscale-tls -o jsonpath='{.data.tls\.key}' | base64 -d > "$DIR/tls.key.new"
  chmod 600 "$DIR/tls.key.new"
  mv "$DIR/tls.crt.new" "$DIR/tls.crt"
  mv "$DIR/tls.key.new" "$DIR/tls.key"
  if systemctl is-active --quiet nginx; then nginx -t && systemctl reload nginx; fi
  logger -t sync-headscale-cert "updated headscale TLS cert and reloaded nginx"
fi
