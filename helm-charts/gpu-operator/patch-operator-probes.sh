#!/bin/bash
# Patches the gpu-operator controller deployment to fix:
#   1. Aggressive probe timeouts (hardcoded in Helm template)
#   2. Leader election timeouts too short for WireGuard + loaded API server
#
# Probe changes:
#   Previous: timeout=1s, period=20s, failureThreshold=3
#   New:      timeout=5s, period=30s, failureThreshold=5
#
# Leader election changes:
#   Previous: --leader-elect (defaults: renew=10s, lease=renew+5s=15s)
#   New:      -leader-lease-renew-deadline=30s (lease=35s)
#
# NOTE: This patch will be overwritten by the next helm upgrade.
# Re-run this script after every `helm upgrade gpu-operator`.

set -euo pipefail

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

echo "Patching gpu-operator deployment probes..."
kubectl patch deployment gpu-operator -n gpu-operator --type=json -p='[
  {
    "op": "replace",
    "path": "/spec/template/spec/containers/0/livenessProbe/timeoutSeconds",
    "value": 5
  },
  {
    "op": "replace",
    "path": "/spec/template/spec/containers/0/livenessProbe/periodSeconds",
    "value": 30
  },
  {
    "op": "replace",
    "path": "/spec/template/spec/containers/0/livenessProbe/failureThreshold",
    "value": 5
  },
  {
    "op": "replace",
    "path": "/spec/template/spec/containers/0/readinessProbe/timeoutSeconds",
    "value": 5
  },
  {
    "op": "replace",
    "path": "/spec/template/spec/containers/0/readinessProbe/failureThreshold",
    "value": 5
  },
  {
    "op": "replace",
    "path": "/spec/template/spec/containers/0/args",
    "value": [
      "--leader-elect",
      "-leader-lease-renew-deadline=30s",
      "--zap-time-encoding=epoch",
      "--zap-log-level=info"
    ]
  }
]'

echo "Patch applied. Waiting for rollout..."
kubectl rollout status deployment/gpu-operator -n gpu-operator --timeout=120s

echo ""
echo "Leader election args:"
kubectl get deployment gpu-operator -n gpu-operator -o jsonpath='{.spec.template.spec.containers[0].args}' | python3 -m json.tool 2>/dev/null || \
kubectl get deployment gpu-operator -n gpu-operator -o jsonpath='{.spec.template.spec.containers[0].args}'

echo ""
echo "Liveness probe:"
kubectl get deployment gpu-operator -n gpu-operator -o jsonpath='{.spec.template.spec.containers[0].livenessProbe}' | python3 -m json.tool 2>/dev/null || \
kubectl get deployment gpu-operator -n gpu-operator -o jsonpath='{.spec.template.spec.containers[0].livenessProbe}'
echo ""
