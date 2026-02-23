#!/bin/bash
# Patches the gpu-operator controller deployment to fix aggressive probe timeouts
# The gpu-operator Helm chart hardcodes probe settings in its template,
# so we patch the deployment after helm upgrade.
#
# Previous: timeout=1s, period=20s, failureThreshold=3
# New:      timeout=5s, period=30s, failureThreshold=5
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
  }
]'

echo "Patch applied. Waiting for rollout..."
kubectl rollout status deployment/gpu-operator -n gpu-operator --timeout=120s
echo "Done. New probe settings:"
kubectl get deployment gpu-operator -n gpu-operator -o jsonpath='{.spec.template.spec.containers[0].livenessProbe}' | python3 -m json.tool 2>/dev/null || \
kubectl get deployment gpu-operator -n gpu-operator -o jsonpath='{.spec.template.spec.containers[0].livenessProbe}'
echo ""
