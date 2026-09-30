# Argo CD — self-managed install

Argo CD manages its own installation from this directory (Application `argocd`
in `gitops/applications/argocd.yaml`, picked up by the app-of-apps).

| file | role |
|---|---|
| `install.yaml` | pristine upstream non-HA manifest, vendored, **never edited by hand** |
| `kustomization.yaml` | version/sha header + every local change as a patch |
| `argocd-cm-patch.yaml` | local accounts, kustomize options, health checks |
| `argocd-rbac-cm-patch.yaml` | RBAC for those accounts |
| `upgrade.sh` | re-vendor a new upstream tag and stamp the header |

## Change placement or resources
Edit the patch in `kustomization.yaml`, then `kubectl diff --server-side -k k8s/argocd`
to preview, commit, push. Argo CD syncs itself (automated, prune on, selfHeal off).

## Upgrade Argo CD
```
k8s/argocd/upgrade.sh v3.3.0
kubectl diff --server-side -k k8s/argocd     # expect image bumps + upstream changes only
git commit -am "argocd: v3.3.0" && git push
```
Argo CD applies its own upgrade; the application-controller restarts last-ish and
the UI blips for a minute.

## Bootstrap on a fresh cluster
```
kubectl create namespace argocd
kubectl apply --server-side -k k8s/argocd
kubectl apply -f gitops/app-of-apps.yaml
```
Server-side apply is required: the CRDs exceed the 256 KiB last-applied annotation limit.

## What is deliberately not in git
`argocd-secret` and `argocd-notifications-secret` data (admin password, server key,
account tokens, TLS), the `argocd-tls` Certificate, `argocd-initial-admin-secret`.
The ingress belongs to the portfolio-orchestration-platform app.
