# In-Cluster Garage v2.2.0 Upgrade + Cluster Join

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the in-cluster Garage from v1.1.0 (single node, replication_factor=1) to v2.2.0 and join the external 4-node Garage cluster, unifying all S3 storage under one replicated cluster.

**Architecture:** Wipe and rebuild. Scale down consumers (Mimir, Tempo, Pyroscope), delete Garage data, upgrade image + config, join cluster, re-create buckets/keys, update Doppler secrets, scale consumers back up. A NodePort service exposes RPC port 3901 so external Garage nodes can reach the in-cluster node.

**Tech Stack:** Garage v2.2.0, Helm (monitoring chart), Doppler/ExternalSecrets, NodePort networking.

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `helm-charts/monitoring/templates/garage-configmap.yaml` | replication_factor=2, rpc_public_addr to NodePort, bootstrap_peers |
| Modify | `helm-charts/monitoring/templates/garage-service.yaml` | Add NodePort service for RPC |
| Modify | `helm-charts/monitoring/values.yaml` | Image tag v2.2.0, add pyroscope-profiles bucket |
| No change | `helm-charts/monitoring/templates/garage-statefulset.yaml` | Image comes from values, no template changes needed |
| No change | `helm-charts/monitoring/templates/garage-externalsecret.yaml` | Doppler key names unchanged |

---

## Task 1: Scale Down Consumers

**Context:** Stop Mimir, Tempo, and Pyroscope from writing to S3 during the upgrade.

- [ ] **Step 1: Scale down all Garage consumers**

```bash
kubectl scale statefulset mimir-monolithic -n monitoring --replicas=0
kubectl scale statefulset tempo-monolithic -n monitoring --replicas=0
kubectl scale statefulset pyroscope -n monitoring --replicas=0
```

- [ ] **Step 2: Verify all consumer pods are gone**

```bash
kubectl get pods -n monitoring | grep -E 'mimir|tempo-monolithic|pyroscope'
```

Expected: No pods matching those names.

---

## Task 2: Wipe Garage Data and Delete PVC

**Context:** v1.1.0 → v2.2.0 is a major version jump. The data format is incompatible. Mimir data is already on the external cluster. Tempo and Pyroscope data will re-accumulate.

- [ ] **Step 1: Scale down Garage StatefulSet**

```bash
kubectl scale statefulset garage -n monitoring --replicas=0
```

- [ ] **Step 2: Delete the Garage data PVC**

```bash
kubectl delete pvc data-garage-0 -n monitoring
```

- [ ] **Step 3: Verify PVC is deleted**

```bash
kubectl get pvc -n monitoring | grep garage
```

Expected: No `data-garage-0` PVC.

---

## Task 3: Update Doppler Secrets

**Context:** The in-cluster Garage needs the cluster-wide `rpc_secret` and a unified admin token. The Doppler key names stay the same (`GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`) but values change. After the upgrade, new access keys will be created and Doppler updated again.

- [ ] **Step 1: Update GARAGE_RPC_SECRET in Doppler**

In Doppler dashboard, `portfolio/prd`:
- `GARAGE_RPC_SECRET` → `cc150913736065610044a58feceac3cf1b5a23f2702b42055edf3214959a2e41` (cluster-wide value)

- [ ] **Step 2: Update GARAGE_ADMIN_TOKEN in Doppler**

Use the ASUSTOR admin token (same cluster):
- `GARAGE_ADMIN_TOKEN` → `85c841...` (value of `ASUSTOR_GARAGE_ADMIN_TOKEN` in Doppler)

Or use a new shared token. The external cluster has two admin tokens:
- ASUSTOR/Synology: `85c841...` (`ASUSTOR_GARAGE_ADMIN_TOKEN`)
- AXE-7800/AX86U Pro: `b92272...` (`GARAGE_ADMIN_TOKEN` — this is already the current Doppler key!)

Pick one. The ASUSTOR token is used by more nodes. Update if needed.

- [ ] **Step 3: Force ExternalSecret refresh**

```bash
kubectl annotate externalsecret garage-external-secret -n monitoring force-sync=$(date +%s) --overwrite
```

- [ ] **Step 4: Verify secret updated**

```bash
kubectl get secret garage-credentials -n monitoring -o jsonpath='{.data.rpcSecret}' | base64 -d
```

Expected: Should show `cc150913...` (the cluster-wide RPC secret).

---

## Task 4: Update Helm Chart Templates

**Context:** Three files need editing: configmap (new config), service (add NodePort), values (image tag).

**Files:**
- Modify: `helm-charts/monitoring/templates/garage-configmap.yaml`
- Modify: `helm-charts/monitoring/templates/garage-service.yaml`
- Modify: `helm-charts/monitoring/values.yaml`

- [ ] **Step 1: Update garage-configmap.yaml**

Replace the full `garage.toml` content in the ConfigMap template:

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
    replication_factor = 2

    rpc_bind_addr = "[::]:3901"
    rpc_public_addr = "10.0.0.1:30901"
    rpc_secret = "__RPC_SECRET__"

    bootstrap_peers = ["10.0.0.4:3901"]

    [s3_api]
    s3_region = "garage"
    api_bind_addr = "[::]:3900"

    [admin]
    api_bind_addr = "[::]:3903"
    admin_token = "__ADMIN_TOKEN__"
{{- end }}
```

Key changes from v1.1.0 config:
- `replication_factor`: 1 → 2
- `rpc_public_addr`: headless DNS → `10.0.0.1:30901` (control plane WireGuard IP + NodePort)
- Added `bootstrap_peers` to auto-connect to ASUSTOR on startup

- [ ] **Step 2: Add NodePort service to garage-service.yaml**

Append a third Service at the end of the file (before the `{{- end }}`):

```yaml
---
apiVersion: v1
kind: Service
metadata:
  name: garage-rpc-nodeport
  namespace: {{ .Release.Namespace }}
  labels:
    app.kubernetes.io/name: garage
    app.kubernetes.io/component: object-storage
spec:
  type: NodePort
  ports:
    - name: rpc
      port: 3901
      targetPort: rpc
      nodePort: 30901
      protocol: TCP
  selector:
    app.kubernetes.io/name: garage
    app.kubernetes.io/component: object-storage
```

- [ ] **Step 3: Update values.yaml — image tag**

Change the Garage image tag:

```yaml
  image:
    repository: dxflrs/garage
    tag: "v2.2.0"
```

- [ ] **Step 4: Update values.yaml — add pyroscope bucket to list**

```yaml
  buckets:
    - mimir-blocks
    - mimir-ruler
    - mimir-alertmanager
    - tempo-traces
    - pyroscope-profiles
    - velero
```

(This list is informational — buckets are created manually via CLI, not by Helm.)

- [ ] **Step 5: Dry-run Helm template**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring
helm template prometheus . --debug 2>&1 | grep -A 20 'garage.toml'
```

Expected: Shows `replication_factor = 2`, `rpc_public_addr = "10.0.0.1:30901"`, `bootstrap_peers`.

---

## Task 5: Helm Upgrade

- [ ] **Step 1: Deploy the upgrade**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring
helm upgrade prometheus . \
  -n monitoring \
  --set kube-prometheus-stack.grafana.adminPassword="$(kubectl get secret -n monitoring prometheus-grafana -o jsonpath='{.data.admin-password}' | base64 -d)" \
  -f values.yaml
```

- [ ] **Step 2: Verify Garage pod starts with v2.2.0**

```bash
kubectl get pods -n monitoring -l app.kubernetes.io/name=garage
kubectl logs garage-0 -n monitoring -c garage --tail=10
```

Expected: Pod running, logs show Garage v2.2.0 startup.

- [ ] **Step 3: Verify NodePort service exists**

```bash
kubectl get svc garage-rpc-nodeport -n monitoring
```

Expected: NodePort service on port 30901.

---

## Task 6: Join Cluster and Assign Layout

**Context:** The in-cluster Garage is now running v2.2.0 with the cluster-wide RPC secret. It needs to connect to peers and be assigned a layout.

- [ ] **Step 1: Get the in-cluster node ID**

```bash
kubectl exec -n monitoring garage-0 -c garage -- /garage node id
```

Save the output — it's the node ID for layout assignment.

Note: If `garage` binary is at a different path, try `/garage` or check with `kubectl exec -n monitoring garage-0 -c garage -- ls /`.

- [ ] **Step 2: Connect to ASUSTOR peer**

The `bootstrap_peers` config should auto-connect. Verify:

```bash
kubectl exec -n monitoring garage-0 -c garage -- /garage status
```

Expected: Shows multiple nodes in the HEALTHY NODES list (ASUSTOR, Synology, routers, plus itself).

If not connected, manually connect:

```bash
kubectl exec -n monitoring garage-0 -c garage -- /garage node connect 332f5e30f99d2a88372f3f0937d2bfe9af679f329ead6f42c0d213b084897e65@10.0.0.4:3901
```

(ASUSTOR node ID from memory doc)

- [ ] **Step 3: Assign layout to the in-cluster node**

```bash
# Replace <NODE_ID> with the ID from Step 1
kubectl exec -n monitoring garage-0 -c garage -- /garage layout assign <NODE_ID> --zone k8s --capacity 80G
```

- [ ] **Step 4: Apply layout**

```bash
kubectl exec -n monitoring garage-0 -c garage -- /garage layout apply --version 1
```

Note: The `--version` flag should match the next layout version. Check with `garage layout show` first.

- [ ] **Step 5: Verify cluster status**

```bash
kubectl exec -n monitoring garage-0 -c garage -- /garage status
```

Expected: 5 nodes, all HEALTHY, layout applied.

---

## Task 7: Create Buckets and Keys

**Context:** All old buckets were wiped. Re-create them plus the new `velero` bucket. Create dedicated access keys per consumer.

- [ ] **Step 1: Create all buckets**

```bash
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket create mimir-blocks
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket create mimir-ruler
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket create mimir-alertmanager
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket create tempo-traces
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket create pyroscope-profiles
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket create velero
```

- [ ] **Step 2: Create access keys**

```bash
kubectl exec -n monitoring garage-0 -c garage -- /garage key create --name mimir-service
kubectl exec -n monitoring garage-0 -c garage -- /garage key create --name tempo-key
kubectl exec -n monitoring garage-0 -c garage -- /garage key create --name pyroscope-key
kubectl exec -n monitoring garage-0 -c garage -- /garage key create --name velero-key
```

Save ALL output — each key shows `GK...` (access key ID) and the secret key.

- [ ] **Step 3: Grant bucket permissions**

```bash
# Mimir — needs all 3 buckets
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket allow --read --write --owner mimir-blocks --key mimir-service
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket allow --read --write --owner mimir-ruler --key mimir-service
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket allow --read --write --owner mimir-alertmanager --key mimir-service

# Tempo
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket allow --read --write --owner tempo-traces --key tempo-key

# Pyroscope
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket allow --read --write --owner pyroscope-profiles --key pyroscope-key

# Velero
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket allow --read --write --owner velero --key velero-key
```

- [ ] **Step 4: Verify buckets and keys**

```bash
kubectl exec -n monitoring garage-0 -c garage -- /garage bucket list
kubectl exec -n monitoring garage-0 -c garage -- /garage key list
```

Expected: 6 buckets, 4 keys.

---

## Task 8: Update Doppler with New Access Keys

**Context:** The old Garage access keys no longer exist. Update Doppler with the new key IDs and secrets from Task 7.

- [ ] **Step 1: Update Mimir credentials in Doppler**

In Doppler `portfolio/prd`:
- `GARAGE_MIMIR_ACCESS_KEY_ID` → new `GK...` from mimir-service key
- `GARAGE_MIMIR_SECRET_ACCESS_KEY` → new secret from mimir-service key

- [ ] **Step 2: Update Tempo credentials in Doppler**

- `GARAGE_TEMPO_ACCESS_KEY_ID` → new `GK...` from tempo-key
- `GARAGE_TEMPO_SECRET_ACCESS_KEY` → new secret from tempo-key

- [ ] **Step 3: Update Pyroscope credentials in Doppler**

- `GARAGE_PYROSCOPE_ACCESS_KEY_ID` → new `GK...` from pyroscope-key
- `GARAGE_PYROSCOPE_SECRET_ACCESS_KEY` → new secret from pyroscope-key

- [ ] **Step 4: Add Velero Garage credentials in Doppler**

- `VELERO_GARAGE_ACCESS_KEY` → new `GK...` from velero-key
- `VELERO_GARAGE_SECRET_KEY` → new secret from velero-key

- [ ] **Step 5: Force all ExternalSecrets to refresh**

```bash
for es in garage-external-secret garage-mimir-external-secret tempo-external-secret pyroscope-external-secret; do
  kubectl annotate externalsecret $es -n monitoring force-sync=$(date +%s) --overwrite
done
```

- [ ] **Step 6: Verify secrets are synced**

```bash
kubectl get externalsecrets -n monitoring | grep -E 'garage|tempo|pyroscope'
```

Expected: All show `SecretSynced` status.

---

## Task 9: Scale Consumers Back Up

- [ ] **Step 1: Scale up Mimir, Tempo, Pyroscope**

```bash
kubectl scale statefulset mimir-monolithic -n monitoring --replicas=1
kubectl scale statefulset tempo-monolithic -n monitoring --replicas=1
kubectl scale statefulset pyroscope -n monitoring --replicas=1
```

- [ ] **Step 2: Wait for all pods to be ready**

```bash
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=mimir -n monitoring --timeout=300s
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=tempo -n monitoring --timeout=300s
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=pyroscope -n monitoring --timeout=300s
```

- [ ] **Step 3: Verify S3 connectivity**

Check Mimir logs for successful S3 operations:

```bash
kubectl logs mimir-monolithic-0 -n monitoring --tail=20 | grep -i 's3\|bucket\|garage'
```

Check Tempo logs:

```bash
kubectl logs tempo-monolithic-0 -n monitoring --tail=20 | grep -i 's3\|bucket\|garage'
```

Expected: No S3 errors, normal operation logs.

---

## Task 10: Commit and Verify

- [ ] **Step 1: Commit chart changes**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add helm-charts/monitoring/templates/garage-configmap.yaml \
        helm-charts/monitoring/templates/garage-service.yaml \
        helm-charts/monitoring/values.yaml
git commit -m "Upgrade in-cluster Garage to v2.2.0 and join external cluster

- Image dxflrs/garage v1.1.0 → v2.2.0
- replication_factor 1 → 2, zone 'k8s'
- NodePort 30901 for external cluster RPC connectivity
- bootstrap_peers to ASUSTOR for auto-join
- Buckets: mimir-blocks, mimir-ruler, mimir-alertmanager, tempo-traces,
  pyroscope-profiles, velero"
```

- [ ] **Step 2: Push**

```bash
git pull --rebase origin main && git push origin main
```

- [ ] **Step 3: Verify cluster health from external node**

SSH to ASUSTOR and check cluster status:

```bash
docker exec garage /garage status
```

Expected: 5 nodes, all HEALTHY, including the `k8s` zone node.

- [ ] **Step 4: Update memory docs**

Update project_garage_cluster.md to add the in-cluster node to the topology table and note the upgrade date.
