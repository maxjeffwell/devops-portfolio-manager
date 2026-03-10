# Replace MinIO with Garage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace MinIO with Garage as the in-cluster S3 object store for Mimir, mirror existing data, then decommission MinIO.

**Architecture:** Deploy Garage as a single-replica StatefulSet alongside Mimir on vmi2951245. Both services run in the monitoring namespace. Garage exposes S3 API on port 3900. Credentials come from Doppler via ExternalSecret. A post-install init job configures the Garage layout, creates buckets, and sets up per-service API keys.

**Tech Stack:** Garage v1.1.0, Helm templates (Go templating), ExternalSecrets + Doppler, mc (MinIO client) for data migration

**Design doc:** `docs/plans/2026-03-10-garage-replaces-minio-design.md`

---

### Task 1: Clean Up Orphaned Distributed Mimir Storage

**Context:** 13 orphaned directories from old distributed Mimir deployment are consuming ~32GB on vmi2951245. No Kubernetes PVC objects reference them.

**Step 1: SSH to control plane and verify directories are orphaned**

```bash
ssh maxjeffwell@86.48.29.183
sudo kubectl get pvc -n monitoring | grep -E 'mimir-(ingester|store-gateway|compactor|kafka)'
# Expected: no results (exit code 1)
```

**Step 2: Delete orphaned directories**

```bash
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-1a082f25-1d46-469a-930c-547c448624fd_monitoring_storage-prometheus-mimir-ingester-0
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-29538d2a-b251-43e7-82d1-6bd0ec8d32c1_monitoring_storage-prometheus-mimir-store-gateway-0
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-2ce48a69-2da0-48c3-be2b-601f63ccc935_monitoring_kafka-data-prometheus-mimir-kafka-0
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-69e96ee0-d487-45e2-b98f-c2c8d58b8c1d_monitoring_storage-prometheus-mimir-alertmanager-0
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-7c1e07ad-9a06-404f-b86d-e3baca1ee690_monitoring_storage-prometheus-mimir-ingester-0
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-8279e930-c214-4ffd-a7d6-7116dd3d8f80_monitoring_kafka-data-prometheus-mimir-kafka-0
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-84f10d44-d3ea-467e-bf5e-8519e9fe81d1_monitoring_storage-prometheus-mimir-compactor-0
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-860dbb74-2982-40bf-a64a-92ab92f4a459_monitoring_storage-prometheus-mimir-compactor-0
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-afa52639-51c3-471c-9b07-219c2eff3583_monitoring_kafka-data-prometheus-mimir-kafka-0
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-bc2a0641-8a77-49ea-8308-c5fddde1d9f4_monitoring_storage-prometheus-mimir-ingester-0
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-c571f340-59de-448e-94a6-3c401f288b94_monitoring_storage-prometheus-mimir-compactor-0
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-e4f1cde1-ffdd-4888-8eff-d1d7e580db28_monitoring_storage-prometheus-mimir-store-gateway-0
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-f4cd0ef6-167d-4d8e-adfc-060694150b13_monitoring_storage-prometheus-mimir-store-gateway-0
```

**Step 3: Verify disk reclaimed**

```bash
df -h /
# Expected: ~32GB more free than before (~265GB free)
```

---

### Task 2: Delete Stale Loki Data from MinIO

**Context:** MinIO still has 2.2GB of `loki-chunks` data from before Loki was moved to the ASUSTOR NAS.

**Step 1: Delete stale Loki data**

```bash
ssh maxjeffwell@86.48.29.183
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-451e2431-ee91-4f56-bb7d-48c863f40a78_monitoring_prometheus-minio/loki-chunks/*
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-451e2431-ee91-4f56-bb7d-48c863f40a78_monitoring_prometheus-minio/loki-ruler/*
```

**Step 2: Verify**

```bash
sudo du -sh /var/lib/rancher/k3s/storage/pvc-451e2431-ee91-4f56-bb7d-48c863f40a78_monitoring_prometheus-minio/
# Expected: ~43GB (down from ~45GB)
```

---

### Task 3: Add Garage Secrets to Doppler

**Context:** Garage needs 4 secrets for the initial deployment. The Mimir access key ID and secret will be generated during Garage init (Task 8), but we need placeholder values in Doppler first so the ExternalSecret can sync. The RPC secret and admin token can be generated now.

**Step 1: Generate RPC secret and admin token**

```bash
openssl rand -hex 32  # GARAGE_RPC_SECRET
openssl rand -hex 32  # GARAGE_ADMIN_TOKEN
```

**Step 2: Add secrets to Doppler**

Add these 4 keys to the Doppler project (same project as other monitoring secrets):
- `GARAGE_RPC_SECRET` — value from step 1
- `GARAGE_ADMIN_TOKEN` — value from step 1
- `GARAGE_MIMIR_ACCESS_KEY_ID` — temporary placeholder (e.g. `placeholder`), will be updated in Task 8
- `GARAGE_MIMIR_SECRET_ACCESS_KEY` — temporary placeholder, will be updated in Task 8

**Step 3: Verify ExternalSecret can see the keys**

```bash
sudo kubectl get externalsecrets -n monitoring
# Verify no sync errors after Garage ExternalSecret is deployed in Task 7
```

---

### Task 4: Create Garage ConfigMap Template

**Files:**
- Create: `helm-charts/monitoring/templates/garage-configmap.yaml`

**Step 1: Create the ConfigMap template**

```yaml
{{- if .Values.garage.enabled }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: garage-config
  namespace: {{ .Release.Namespace }}
  labels:
    app.kubernetes.io/name: garage
    app.kubernetes.io/component: object-storage
data:
  garage.toml: |
    metadata_dir = "/var/lib/garage/meta"
    data_dir = "/var/lib/garage/data"
    db_engine = "sqlite"
    replication_factor = 1

    rpc_bind_addr = "[::]:3901"
    rpc_public_addr = "garage-0.garage-headless.{{ .Release.Namespace }}.svc.cluster.local:3901"
    rpc_secret = "__RPC_SECRET__"

    [s3_api]
    s3_region = "garage"
    api_bind_addr = "[::]:3900"

    [admin]
    api_bind_addr = "[::]:3903"
    admin_token = "__ADMIN_TOKEN__"
{{- end }}
```

Note: The `__RPC_SECRET__` and `__ADMIN_TOKEN__` placeholders are replaced at container startup via an init script that reads from the mounted secret. See Task 5 for the entrypoint wrapper.

**Step 2: Verify template renders**

```bash
cd helm-charts/monitoring && helm template . --show-only templates/garage-configmap.yaml
```

---

### Task 5: Create Garage StatefulSet Template

**Files:**
- Create: `helm-charts/monitoring/templates/garage-statefulset.yaml`

**Step 1: Create the StatefulSet template**

The StatefulSet uses an init container to inject secrets into `garage.toml` (Garage reads config from file, not env vars). The init container copies the ConfigMap toml, substitutes secret placeholders, and writes the final config to an emptyDir shared with the main container.

```yaml
{{- if .Values.garage.enabled }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: garage
  namespace: {{ .Release.Namespace }}
  labels:
    app.kubernetes.io/name: garage
    app.kubernetes.io/component: object-storage
spec:
  serviceName: garage-headless
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: garage
      app.kubernetes.io/component: object-storage
  template:
    metadata:
      labels:
        app.kubernetes.io/name: garage
        app.kubernetes.io/component: object-storage
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/garage-configmap.yaml") . | sha256sum }}
    spec:
      {{- with .Values.garage.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      initContainers:
        - name: inject-secrets
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              cp /etc/garage-template/garage.toml /etc/garage/garage.toml
              sed -i "s|__RPC_SECRET__|${GARAGE_RPC_SECRET}|g" /etc/garage/garage.toml
              sed -i "s|__ADMIN_TOKEN__|${GARAGE_ADMIN_TOKEN}|g" /etc/garage/garage.toml
          env:
            - name: GARAGE_RPC_SECRET
              valueFrom:
                secretKeyRef:
                  name: garage-credentials
                  key: rpcSecret
            - name: GARAGE_ADMIN_TOKEN
              valueFrom:
                secretKeyRef:
                  name: garage-credentials
                  key: adminToken
          volumeMounts:
            - name: config-template
              mountPath: /etc/garage-template
            - name: config
              mountPath: /etc/garage
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              memory: 32Mi
      containers:
        - name: garage
          image: "{{ .Values.garage.image.repository }}:{{ .Values.garage.image.tag }}"
          args:
            - server
          ports:
            - name: s3-api
              containerPort: 3900
              protocol: TCP
            - name: rpc
              containerPort: 3901
              protocol: TCP
            - name: admin
              containerPort: 3903
              protocol: TCP
          env:
            - name: RUST_LOG
              value: garage=info
          readinessProbe:
            httpGet:
              path: /health
              port: admin
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: admin
            initialDelaySeconds: 30
            periodSeconds: 30
            timeoutSeconds: 5
          startupProbe:
            httpGet:
              path: /health
              port: admin
            failureThreshold: 18
            periodSeconds: 10
          resources:
            {{- toYaml .Values.garage.resources | nindent 12 }}
          volumeMounts:
            - name: config
              mountPath: /etc/garage
            - name: data
              mountPath: /var/lib/garage
      volumes:
        - name: config-template
          configMap:
            name: garage-config
        - name: config
          emptyDir: {}
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: {{ .Values.garage.persistence.storageClass }}
        resources:
          requests:
            storage: {{ .Values.garage.persistence.size }}
{{- end }}
```

**Step 2: Verify template renders**

```bash
helm template . --show-only templates/garage-statefulset.yaml
```

---

### Task 6: Create Garage Service Template

**Files:**
- Create: `helm-charts/monitoring/templates/garage-service.yaml`

**Step 1: Create the Service template**

```yaml
{{- if .Values.garage.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: garage
  namespace: {{ .Release.Namespace }}
  labels:
    app.kubernetes.io/name: garage
    app.kubernetes.io/component: object-storage
spec:
  type: ClusterIP
  ports:
    - name: s3-api
      port: 3900
      targetPort: s3-api
      protocol: TCP
    - name: admin
      port: 3903
      targetPort: admin
      protocol: TCP
  selector:
    app.kubernetes.io/name: garage
    app.kubernetes.io/component: object-storage
---
apiVersion: v1
kind: Service
metadata:
  name: garage-headless
  namespace: {{ .Release.Namespace }}
  labels:
    app.kubernetes.io/name: garage
    app.kubernetes.io/component: object-storage
spec:
  type: ClusterIP
  clusterIP: None
  ports:
    - name: s3-api
      port: 3900
      targetPort: s3-api
      protocol: TCP
    - name: rpc
      port: 3901
      targetPort: rpc
      protocol: TCP
    - name: admin
      port: 3903
      targetPort: admin
      protocol: TCP
  selector:
    app.kubernetes.io/name: garage
    app.kubernetes.io/component: object-storage
{{- end }}
```

**Step 2: Verify template renders**

```bash
helm template . --show-only templates/garage-service.yaml
```

---

### Task 7: Create Garage ExternalSecret Template

**Files:**
- Create: `helm-charts/monitoring/templates/garage-externalsecret.yaml`

**Context:** This creates two secrets:
1. `garage-credentials` — RPC secret + admin token (used by Garage itself)
2. `garage-mimir-credentials` — S3 access key ID + secret (used by Mimir's envFrom)

**Step 1: Create the ExternalSecret template**

```yaml
{{- if .Values.garage.enabled }}
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: garage-external-secret
  namespace: {{ .Release.Namespace }}
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: doppler-secret-store
    kind: ClusterSecretStore
  target:
    name: garage-credentials
    creationPolicy: Owner
  data:
    - secretKey: rpcSecret
      remoteRef:
        key: GARAGE_RPC_SECRET
    - secretKey: adminToken
      remoteRef:
        key: GARAGE_ADMIN_TOKEN
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: garage-mimir-external-secret
  namespace: {{ .Release.Namespace }}
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: doppler-secret-store
    kind: ClusterSecretStore
  target:
    name: garage-mimir-credentials
    creationPolicy: Owner
  data:
    - secretKey: accessKeyId
      remoteRef:
        key: GARAGE_MIMIR_ACCESS_KEY_ID
    - secretKey: secretAccessKey
      remoteRef:
        key: GARAGE_MIMIR_SECRET_ACCESS_KEY
{{- end }}
```

**Step 2: Verify template renders**

```bash
helm template . --show-only templates/garage-externalsecret.yaml
```

---

### Task 8: Add Garage Values to values.yaml

**Files:**
- Modify: `helm-charts/monitoring/values.yaml`

**Step 1: Add `garage` section after the `minio` section (~line 409)**

```yaml
# Garage - Lightweight S3-compatible object storage (replaces MinIO)
garage:
  enabled: true
  image:
    repository: dxflrs/garage
    tag: "v1.1.0"
  nodeSelector:
    kubernetes.io/hostname: vmi2951245
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      memory: 512Mi
  persistence:
    storageClass: local-path
    size: 80Gi
  buckets:
    - mimir-blocks
    - mimir-ruler
    - mimir-alertmanager
    - tempo-traces
```

**Step 2: Verify full chart renders**

```bash
helm template . > /dev/null
# Expected: no errors
```

**Step 3: Commit all Garage templates and values**

```bash
git add helm-charts/monitoring/templates/garage-*.yaml helm-charts/monitoring/values.yaml
git commit -m "feat(monitoring): add Garage S3 object store templates

Deploy Garage as lightweight MinIO replacement for Mimir block storage.
Includes StatefulSet, ConfigMap, Service, ExternalSecret templates.
Garage runs alongside MinIO during migration period."
```

---

### Task 9: Deploy Garage via Helm Upgrade

**Context:** The monitoring chart is deployed manually via `helm upgrade` from the VPS filesystem, not ArgoCD. Files must be SCP'd to the VPS first.

**Step 1: SCP updated chart to VPS**

```bash
# From marmoset (local machine)
scp -r /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring maxjeffwell@86.48.29.183:~/monitoring-chart-staging/
```

**Step 2: Run helm upgrade from VPS**

```bash
ssh maxjeffwell@86.48.29.183
cd ~/monitoring-chart-staging/monitoring
sudo helm upgrade prometheus . -n monitoring --reuse-values -f values.yaml --no-hooks
```

Note: `--no-hooks` avoids MinIO's `makeBucketJob` post-upgrade hook which can race with MinIO restarts.

**Step 3: Verify Garage pod starts**

```bash
sudo kubectl get pods -n monitoring | grep garage
# Expected: garage-0  1/1  Running
sudo kubectl logs garage-0 -n monitoring -c garage --tail 20
# Expected: "Garage server running" or similar startup message
```

---

### Task 10: Initialize Garage (Layout, Buckets, API Key)

**Context:** Garage requires manual initialization after first deployment: assign node to layout, create buckets, create API keys, and assign bucket permissions. This is done by exec'ing into the Garage pod.

**Step 1: Get node ID and assign layout**

```bash
ssh maxjeffwell@86.48.29.183
sudo kubectl exec -n monitoring garage-0 -- /garage status
# Note the node ID (64-char hex, first few chars suffice)

# Assign layout with full capacity (use first 6+ chars of node ID)
sudo kubectl exec -n monitoring garage-0 -- /garage layout assign -z dc1 -c 80GB <NODE_ID_PREFIX>
sudo kubectl exec -n monitoring garage-0 -- /garage layout apply --version 1
```

**Step 2: Create buckets**

```bash
sudo kubectl exec -n monitoring garage-0 -- /garage bucket create mimir-blocks
sudo kubectl exec -n monitoring garage-0 -- /garage bucket create mimir-ruler
sudo kubectl exec -n monitoring garage-0 -- /garage bucket create mimir-alertmanager
sudo kubectl exec -n monitoring garage-0 -- /garage bucket create tempo-traces
```

**Step 3: Create Mimir API key and assign permissions**

```bash
sudo kubectl exec -n monitoring garage-0 -- /garage key create mimir-service
# Output will show: Key ID (GK...) and Secret Key
# SAVE BOTH VALUES — needed for Doppler

sudo kubectl exec -n monitoring garage-0 -- /garage bucket allow --read --write mimir-blocks --key mimir-service
sudo kubectl exec -n monitoring garage-0 -- /garage bucket allow --read --write mimir-ruler --key mimir-service
sudo kubectl exec -n monitoring garage-0 -- /garage bucket allow --read --write mimir-alertmanager --key mimir-service
```

**Step 4: Update Doppler with real API key values**

Replace the placeholder values in Doppler:
- `GARAGE_MIMIR_ACCESS_KEY_ID` → the `Key ID` from step 3 (starts with `GK`)
- `GARAGE_MIMIR_SECRET_ACCESS_KEY` → the `Secret Key` from step 3

**Step 5: Force ExternalSecret refresh**

```bash
sudo kubectl annotate externalsecret garage-mimir-external-secret -n monitoring force-sync=$(date +%s) --overwrite
# Wait for sync
sudo kubectl get secret garage-mimir-credentials -n monitoring -o jsonpath='{.data.accessKeyId}' | base64 -d
# Expected: the GK... key ID from step 3
```

**Step 6: Verify S3 access**

```bash
# Quick test using curl to Garage's S3 API (list buckets)
sudo kubectl exec -n monitoring garage-0 -- /garage bucket list
# Expected: all 4 buckets listed
```

---

### Task 11: Mirror Data from MinIO to Garage

**Context:** Use `mc` (MinIO client) to copy mimir-blocks (~43GB), mimir-ruler, and mimir-alertmanager from MinIO to Garage. Run from a temporary pod with access to both services.

**Step 1: Launch a temporary mc pod**

```bash
ssh maxjeffwell@86.48.29.183
sudo kubectl run mc-mirror --rm -it --restart=Never -n monitoring \
  --image=minio/mc:latest \
  --overrides='{
    "spec": {
      "nodeSelector": {"kubernetes.io/hostname": "vmi2951245"},
      "containers": [{
        "name": "mc-mirror",
        "image": "minio/mc:latest",
        "command": ["sleep", "3600"],
        "resources": {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"memory": "256Mi"}}
      }]
    }
  }' -- sleep 3600
```

**Step 2: Configure mc aliases (from another terminal)**

```bash
# Get MinIO credentials
MINIO_USER=$(sudo kubectl get secret minio-credentials -n monitoring -o jsonpath='{.data.rootUser}' | base64 -d)
MINIO_PASS=$(sudo kubectl get secret minio-credentials -n monitoring -o jsonpath='{.data.rootPassword}' | base64 -d)

# Get Garage credentials
GARAGE_KEY=$(sudo kubectl get secret garage-mimir-credentials -n monitoring -o jsonpath='{.data.accessKeyId}' | base64 -d)
GARAGE_SECRET=$(sudo kubectl get secret garage-mimir-credentials -n monitoring -o jsonpath='{.data.secretAccessKey}' | base64 -d)

# Configure aliases inside mc pod
sudo kubectl exec -n monitoring mc-mirror -- mc alias set minio http://prometheus-minio.monitoring.svc.cluster.local:9000 "$MINIO_USER" "$MINIO_PASS"
sudo kubectl exec -n monitoring mc-mirror -- mc alias set garage http://garage.monitoring.svc.cluster.local:3900 "$GARAGE_KEY" "$GARAGE_SECRET" --api S3v4
```

**Step 3: Mirror buckets**

```bash
# Mirror mimir-blocks (largest, ~43GB — will take time)
sudo kubectl exec -n monitoring mc-mirror -- mc mirror --preserve minio/mimir-blocks garage/mimir-blocks

# Mirror mimir-ruler (tiny)
sudo kubectl exec -n monitoring mc-mirror -- mc mirror --preserve minio/mimir-ruler garage/mimir-ruler

# Mirror mimir-alertmanager (tiny)
sudo kubectl exec -n monitoring mc-mirror -- mc mirror --preserve minio/mimir-alertmanager garage/mimir-alertmanager
```

**Step 4: Verify mirror**

```bash
sudo kubectl exec -n monitoring mc-mirror -- mc ls garage/mimir-blocks/ --summarize
# Compare object count and total size with:
sudo kubectl exec -n monitoring mc-mirror -- mc ls minio/mimir-blocks/ --summarize
```

**Step 5: Clean up mc pod**

```bash
sudo kubectl delete pod mc-mirror -n monitoring
```

---

### Task 12: Swap Mimir Endpoint to Garage

**Files:**
- Modify: `helm-charts/monitoring/templates/mimir-monolithic-configmap.yaml:23-25`
- Modify: `helm-charts/monitoring/values.yaml:637-641`

**Step 1: Update values.yaml — change Mimir's S3 endpoint and credentials secret**

Change the `mimirMonolithic.storage` section:

```yaml
  storage:
    credentialsSecret: garage-mimir-credentials
    s3:
      endpoint: garage.monitoring.svc.cluster.local:3900
      insecure: true
```

**Step 2: Update mimir-monolithic-configmap.yaml — update env var names**

The current configmap uses `${rootUser}` and `${rootPassword}` (MinIO secret key names). Update to match the new Garage secret key names:

```yaml
    common:
      storage:
        backend: s3
        s3:
          endpoint: {{ .Values.mimirMonolithic.storage.s3.endpoint }}
          access_key_id: ${accessKeyId}
          secret_access_key: ${secretAccessKey}
          insecure: {{ .Values.mimirMonolithic.storage.s3.insecure }}
```

**Step 3: Verify template renders**

```bash
cd helm-charts/monitoring
helm template . --show-only templates/mimir-monolithic-configmap.yaml
# Verify endpoint is garage, env vars are accessKeyId/secretAccessKey
```

**Step 4: SCP and helm upgrade**

```bash
scp -r /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring maxjeffwell@86.48.29.183:~/monitoring-chart-staging/
ssh maxjeffwell@86.48.29.183
cd ~/monitoring-chart-staging/monitoring
sudo helm upgrade prometheus . -n monitoring --reuse-values -f values.yaml --no-hooks
```

**Step 5: Verify Mimir restarts and connects to Garage**

```bash
sudo kubectl rollout status statefulset/mimir-monolithic -n monitoring --timeout=120s
sudo kubectl logs mimir-monolithic-0 -n monitoring --tail 30
# Expected: no S3 connection errors, "mimir started" message
```

**Step 6: Verify Grafana dashboards**

Open Grafana and check dashboards that query historical data. Verify data continuity — no gaps from the migration.

**Step 7: Commit**

```bash
git add helm-charts/monitoring/templates/mimir-monolithic-configmap.yaml helm-charts/monitoring/values.yaml
git commit -m "feat(monitoring): switch Mimir from MinIO to Garage S3 backend

Update Mimir storage endpoint to Garage and credential references
to use Garage-specific ExternalSecret (garage-mimir-credentials)."
```

---

### Task 13: Disable MinIO

**Files:**
- Modify: `helm-charts/monitoring/values.yaml:356`

**Step 1: Disable MinIO in values.yaml**

```yaml
# MinIO - DISABLED (replaced by Garage)
minio:
  enabled: false
```

**Step 2: SCP and helm upgrade**

```bash
scp -r /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring maxjeffwell@86.48.29.183:~/monitoring-chart-staging/
ssh maxjeffwell@86.48.29.183
cd ~/monitoring-chart-staging/monitoring
sudo helm upgrade prometheus . -n monitoring --reuse-values -f values.yaml --set minio.enabled=false --no-hooks
```

Note: `--set minio.enabled=false` explicitly overrides in case Helm release secrets retain the old `enabled: true` value (the subchart condition pitfall from MEMORY.md).

**Step 3: Verify MinIO pod is gone**

```bash
sudo kubectl get pods -n monitoring | grep minio
# Expected: no results
sudo kubectl get pods -n monitoring | grep garage
# Expected: garage-0  1/1  Running
sudo kubectl logs mimir-monolithic-0 -n monitoring --tail 10
# Expected: still healthy, no errors
```

**Step 4: Commit**

```bash
git add helm-charts/monitoring/values.yaml
git commit -m "feat(monitoring): disable MinIO subchart

Garage is now the sole S3 backend for Mimir. MinIO pod removed."
```

---

### Task 14: Clean Up MinIO PVC and Push

**Step 1: Delete orphaned MinIO PVC directory**

```bash
ssh maxjeffwell@86.48.29.183
# Verify MinIO PVC is not bound to anything
sudo kubectl get pvc -n monitoring | grep minio
# If PVC object still exists, delete it:
sudo kubectl delete pvc prometheus-minio -n monitoring

# Delete on-disk data
sudo rm -rf /var/lib/rancher/k3s/storage/pvc-451e2431-ee91-4f56-bb7d-48c863f40a78_monitoring_prometheus-minio
```

**Step 2: Verify final disk state**

```bash
df -h /
# Expected: ~77GB more free than before migration started
sudo kubectl get pods -n monitoring | grep -E 'garage|mimir'
# Expected: garage-0 Running, mimir-monolithic-0 Running, no minio
```

**Step 3: Push all commits**

```bash
git push origin main
```

**Step 4: Final verification**

- Grafana dashboards load with full historical data
- Prometheus remote write to Mimir is working (check for recent metrics)
- Garage pod is stable (no restarts)
- No MinIO resources remain in the cluster

---

## Rollback Plan

If Mimir fails to connect to Garage at any point:

1. Revert `mimirMonolithic.storage` in values.yaml back to MinIO endpoint and `minio-credentials`
2. Revert `mimir-monolithic-configmap.yaml` env vars back to `${rootUser}` / `${rootPassword}`
3. `helm upgrade` — Mimir reconnects to MinIO (still running during Phase 2)
4. Investigate Garage logs: `kubectl logs garage-0 -n monitoring`

If MinIO is already disabled (Phase 3):
1. Re-enable `minio.enabled: true`
2. `helm upgrade` — MinIO pod restarts
3. Revert Mimir endpoint back to MinIO
4. MinIO data is still on disk (unless Task 14 already deleted it — in that case, restore from Velero backup)
