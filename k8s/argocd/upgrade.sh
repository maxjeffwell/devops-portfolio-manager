#!/usr/bin/env bash
# Re-vendor the upstream Argo CD install manifest at a given tag and stamp the
# version + sha256 into kustomization.yaml. Review with
#   kubectl diff --server-side -k k8s/argocd
# before committing; Argo CD then syncs itself (app: argocd).
set -euo pipefail
tag="${1:?usage: $0 vX.Y.Z}"
dir="$(cd "$(dirname "$0")" && pwd)"
url="https://raw.githubusercontent.com/argoproj/argo-cd/${tag}/manifests/install.yaml"
# Supply-chain note: upstream publishes no detached signature for install.yaml,
# so the controls are (1) HTTPS-only with TLS >= 1.2, (2) the manifest must
# reference exactly the requested tag, (3) the sha256 is stamped into
# kustomization.yaml and (4) the reviewer runs `kubectl diff` before commit —
# an unexpected image, registry or RBAC change shows up there. Never wire this
# script into automation.
curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$dir/install.yaml.new"
grep -q "image: quay.io/argoproj/argocd:${tag}$" "$dir/install.yaml.new" || { echo "downloaded manifest does not reference ${tag}" >&2; rm -f "$dir/install.yaml.new"; exit 1; }
if grep -o 'image: [^ ]*' "$dir/install.yaml.new" | grep -v -E '^image: (quay.io/argoproj/argocd:|ghcr.io/dexidp/dex:|public.ecr.aws/docker/library/redis:)'; then
  echo "unexpected image registry/name above — review before continuing" >&2; rm -f "$dir/install.yaml.new"; exit 1
fi
mv "$dir/install.yaml.new" "$dir/install.yaml"
sha="$(sha256sum "$dir/install.yaml" | cut -c1-64)"
sed -i -E \
  -e "s|(argo-cd/)v[0-9]+\.[0-9]+\.[0-9]+(/manifests/install.yaml)|\1${tag}\2|" \
  -e "s|^(#   version: ).*|\1${tag}|" \
  -e "s|^(#   sha256: ).*|\1${sha}|" "$dir/kustomization.yaml"
echo "vendored ${tag} (sha256 ${sha})"; echo "next: kubectl diff --server-side -k ${dir}"
