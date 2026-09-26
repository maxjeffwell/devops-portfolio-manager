# External Secrets Operator (ESO)

**ESO itself** is a plain Helm release (not ArgoCD):

```
helm upgrade --install external-secrets external-secrets/external-secrets \
  -n external-secrets -f k8s/external-secrets/eso-helm-values.yaml
```

`eso-helm-values.yaml` matched the live release values exactly on 2026-09-26
(chart external-secrets-1.2.1). Keep it in sync with any `helm upgrade`.

**Every ExternalSecret and the `doppler-secret-store` ClusterSecretStore** live in
`k8s/platform-external-secrets/`, synced by the `platform-external-secrets` ArgoCD
app. Add new ExternalSecrets there.

This directory used to hold stale duplicates of those objects, an obsolete raw
ESO `install.yaml`, and unused SecretStore templates (AWS/Azure/GCP/Vault/...);
they were removed on 2026-09-26 after verifying none was live or unmanaged.
