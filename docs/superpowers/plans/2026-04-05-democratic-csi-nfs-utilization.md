# Democratic-CSI NFS Utilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the existing democratic-csi NFS driver to work with Grafana persistent storage and Backrest local backups, plus add a Velero local BSL via the Garage S3 cluster.

**Architecture:** Three independent workstreams: (1) LVM resize on ASUSTOR to grow `k8s-nfs` from 500G to 800G, (2) Helm chart changes for Grafana persistence and Backrest NFS volume, (3) Velero second BSL via Garage S3. Sections 1-3 can proceed independently. Section 4 (Velero) is blocked on the in-cluster Garage v2.2.0 upgrade completing.

**Tech Stack:** LVM/ext4 (ASUSTOR), Helm/kube-prometheus-stack (Grafana), Helm/custom chart (Backrest), Velero with AWS plugin, Garage S3, Doppler/ExternalSecrets.

**Spec:** `docs/superpowers/specs/2026-04-05-democratic-csi-nfs-utilization-design.md`

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `helm-charts/monitoring/values.yaml` | Enable Grafana persistence on `asustor-nfs` |
| Modify | `helm-charts/backrest/values.yaml` | Add `backups` persistence entry for NFS volume |
| Modify | `helm-charts/backrest/templates/deployment.yaml` | Wire up the new `backups` volume + volumeMount |
| Modify | `k8s/velero-values.yaml` (in portfolio-orchestration-platform) | Add second BSL for Garage S3 |
| Modify | `helm-charts/monitoring/templates/velero-schedules.yaml` | Add `storageLocation` to weekly schedule |
| Modify | `helm-charts/monitoring/values.yaml` (veleroSchedules section) | Add weekly-local schedule config |
| Create | `k8s/external-secrets/velero-garage-credentials-external-secret.yaml` (in portfolio-orchestration-platform) | Garage S3 credentials for Velero |

---

## Task 1: LVM Resize on ASUSTOR

**Context:** The ASUSTOR `vg-ssd` VG is fully allocated. `lan-share` (1.52T) is 1% used. We shrink it to 756G and grow `k8s-nfs` from 500G to 800G, leaving 500G unallocated.

**Target:** ASUSTOR NAS via SSH (not K8s manifests)

- [ ] **Step 1: SSH to ASUSTOR and verify current state**

```bash
ssh maxjeffwell@10.0.0.4
sudo lvs vg-ssd
df -h /mnt/lan-share /mnt/k8s-nfs
```

Expected: `lan-share` at 1.52T with ~1% used, `k8s-nfs` at 500G.

- [ ] **Step 2: Unmount lan-share**

```bash
sudo umount /mnt/lan-share
```

Verify no processes using it first: `sudo lsof /mnt/lan-share`

- [ ] **Step 3: Check and shrink lan-share filesystem**

```bash
sudo e2fsck -f /dev/vg-ssd/lan-share
sudo resize2fs /dev/vg-ssd/lan-share 756G
```

Expected: `e2fsck` reports clean. `resize2fs` completes without error.

- [ ] **Step 4: Shrink lan-share LV**

```bash
sudo lvreduce -L 756G /dev/vg-ssd/lan-share
```

Confirm with `y` when prompted. This is safe because the filesystem was already shrunk in Step 3.

- [ ] **Step 5: Remount lan-share**

```bash
sudo mount /dev/vg-ssd/lan-share /mnt/lan-share
df -h /mnt/lan-share
```

Expected: Shows ~756G total.

- [ ] **Step 6: Grow k8s-nfs LV**

```bash
sudo lvextend -L 800G /dev/vg-ssd/k8s-nfs
```

- [ ] **Step 7: Grow k8s-nfs filesystem (online)**

```bash
sudo resize2fs /dev/vg-ssd/k8s-nfs
df -h /mnt/k8s-nfs
```

Expected: Shows ~800G total. No unmount needed — ext4 supports online grow.

- [ ] **Step 8: Verify VG free space**

```bash
sudo vgdisplay vg-ssd | grep Free
```

Expected: ~500G free.

- [ ] **Step 9: Verify NFS export still works from a K8s node**

From the control plane node (not the ASUSTOR):

```bash
ssh maxjeffwell@10.0.0.1 'showmount -e 192.168.50.142'
```

Expected: `/mnt/k8s-nfs` is listed in exports.

---

## Task 2: Grafana Persistent Storage

**Context:** Grafana uses EmptyDir (`storage` volume) for `/var/lib/grafana`. The kube-prometheus-stack subchart has a `grafana.persistence` key that switches from EmptyDir to PVC. Current usage is ~215Mi.

**Files:**
- Modify: `helm-charts/monitoring/values.yaml:210-254` (grafana section)

- [ ] **Step 1: Add persistence config to Grafana values**

In `helm-charts/monitoring/values.yaml`, add the `persistence` block inside the `grafana:` section, after line 212 (`adminPassword: "REPLACE_AT_DEPLOY_TIME"`):

```yaml
    persistence:
      enabled: true
      storageClassName: asustor-nfs
      size: 5Gi
```

- [ ] **Step 2: Add idempotency check to the init container**

Replace the init container command (lines 238-245) so it skips the download if the plugin already exists:

```yaml
    extraInitContainers:
      - name: install-k8s-plugin
        image: busybox:1.36
        command:
          - /bin/sh
          - -c
          - |
            if [ -d /var/lib/grafana/plugins/tiithansen-grafana-k8s-app/dist ]; then
              echo "k8s-app plugin already installed, skipping"
              exit 0
            fi
            wget -O /tmp/k8s-app.zip https://github.com/tiithansen/grafana-k8s-app/releases/download/v0.11.2/grafana-k8s-app-v0.11.2.zip &&
            mkdir -p /var/lib/grafana/plugins/tiithansen-grafana-k8s-app &&
            unzip -o /tmp/k8s-app.zip -d /var/lib/grafana/plugins/tiithansen-grafana-k8s-app &&
            rm /tmp/k8s-app.zip
        volumeMounts:
          - name: storage
            mountPath: /var/lib/grafana
        resources:
          requests:
            cpu: 10m
            memory: 32Mi
          limits:
            memory: 64Mi
```

- [ ] **Step 3: Update liveness probe comment**

Replace the comment at line 310-311:

```yaml
    # Liveness probe tuning — Grafana startup may take several minutes on first
    # init (SQLite migrations). Subsequent starts with persistent storage are faster.
```

- [ ] **Step 4: Dry-run the Helm template**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring
helm template prometheus . --debug 2>&1 | grep -A 10 'grafana.*persistence\|storageClassName.*asustor'
```

Expected: The Grafana StatefulSet (or Deployment with PVC) shows `storageClassName: asustor-nfs` and `storage: 5Gi`.

- [ ] **Step 5: Helm upgrade (monitoring namespace)**

```bash
helm upgrade prometheus /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring \
  -n monitoring \
  --set kube-prometheus-stack.grafana.adminPassword="$(kubectl get secret -n monitoring prometheus-grafana -o jsonpath='{.data.admin-password}' | base64 -d)" \
  --reuse-values
```

- [ ] **Step 6: Verify PVC created and Grafana running**

```bash
kubectl get pvc -n monitoring | grep grafana
kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana
```

Expected: A new PVC bound on `asustor-nfs`, Grafana pod running.

- [ ] **Step 7: Verify Grafana UI loads**

```bash
curl -sSo /dev/null -w '%{http_code}' https://grafana.el-jefe.me/api/health
```

Expected: `200`

- [ ] **Step 8: Commit**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add helm-charts/monitoring/values.yaml
git commit -m "feat(grafana): enable persistent storage on asustor-nfs

Switch Grafana from EmptyDir to 5Gi PVC on asustor-nfs StorageClass.
Dashboards, plugins, and SQLite DB now persist across pod restarts.
Init container skips plugin download if already installed."
```

---

## Task 3: Backrest NFS Volume for Local Backups

**Context:** Backrest currently backs up `/mnt/iscsi` to SFTP on the Synology. We add a new 300Gi NFS-backed PVC at `/velero-backups` for a local backup repository. The deployment template uses `values.persistence.*` to wire volumes.

**Files:**
- Modify: `helm-charts/backrest/values.yaml:51-69`
- Modify: `helm-charts/backrest/templates/deployment.yaml:59-113`

- [ ] **Step 1: Add backups persistence entry to values.yaml**

In `helm-charts/backrest/values.yaml`, add a new `backups` entry after the `cache` block (after line 69):

```yaml
  backups:
    enabled: true
    size: 300Gi
    storageClass: asustor-nfs
    mountPath: /velero-backups
```

- [ ] **Step 2: Add volumeMount to deployment template**

In `helm-charts/backrest/templates/deployment.yaml`, add after the cache volumeMount (after line 71):

```yaml
            {{- if .Values.persistence.backups.enabled }}
            - name: backups
              mountPath: {{ .Values.persistence.backups.mountPath }}
            {{- end }}
```

- [ ] **Step 3: Add volume to deployment template**

In `helm-charts/backrest/templates/deployment.yaml`, add after the cache volume (after line 99):

```yaml
        {{- if .Values.persistence.backups.enabled }}
        - name: backups
          persistentVolumeClaim:
            claimName: {{ .Values.persistence.backups.existingClaim | default (printf "%s-backups" .Release.Name) }}
        {{- end }}
```

- [ ] **Step 4: Dry-run the Helm template**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/backrest
helm template backrest . --debug 2>&1 | grep -B 2 -A 5 'velero-backups\|backups'
```

Expected: Shows `mountPath: /velero-backups` and a PVC named `backrest-backups` with `storageClassName: asustor-nfs`.

- [ ] **Step 5: Helm upgrade to create the PVC**

```bash
helm upgrade backrest /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/backrest \
  -n backrest \
  --reuse-values
```

- [ ] **Step 6: Verify PVC created and bound**

```bash
kubectl get pvc -n backrest | grep backups
```

Expected: `backrest-backups` PVC, 300Gi, bound on `asustor-nfs`.

- [ ] **Step 7: Migrate existing backup data**

Scale down Backrest, copy data from old PVC to new PVC using a temporary pod:

```bash
# Scale down backrest
kubectl scale deployment backrest -n backrest --replicas=0

# Create a temporary pod that mounts both PVCs
kubectl run data-migrator -n backrest --image=busybox:1.36 --restart=Never \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "migrator",
        "image": "busybox:1.36",
        "command": ["sleep", "3600"],
        "volumeMounts": [
          {"name": "old-data", "mountPath": "/old"},
          {"name": "new-data", "mountPath": "/new"}
        ]
      }],
      "volumes": [
        {"name": "old-data", "persistentVolumeClaim": {"claimName": "backrest-data-synology"}},
        {"name": "new-data", "persistentVolumeClaim": {"claimName": "backrest-backups"}}
      ],
      "nodeSelector": {"kubernetes.io/hostname": "vmi3115606"}
    }
  }'

# Wait for pod to be running
kubectl wait --for=condition=Ready pod/data-migrator -n backrest --timeout=120s

# Copy data
kubectl exec -n backrest data-migrator -- sh -c 'cp -av /old/* /new/ 2>&1'

# Verify
kubectl exec -n backrest data-migrator -- sh -c 'ls -la /new/'

# Cleanup
kubectl delete pod data-migrator -n backrest
```

- [ ] **Step 8: Scale Backrest back up and verify**

```bash
kubectl scale deployment backrest -n backrest --replicas=1
kubectl wait --for=condition=Ready pod -l app=backrest -n backrest --timeout=120s
```

Verify Backrest UI is accessible and shows existing backup history.

- [ ] **Step 9: Configure local repo in Backrest**

Open the Backrest UI and add a new repo:
- **ID**: `local-nfs`
- **URI**: `/velero-backups` (local path)
- **Password**: Generate and save securely

Then create or modify backup plans to target both `iscsi-synology` (existing SFTP) and `local-nfs` (new local).

This step is manual via the Backrest web UI — the config is stored in `/config/config.json` on the `backrest-config-synology` PVC.

- [ ] **Step 10: Run a test backup to the local-nfs repo**

Trigger a manual backup in the Backrest UI targeting the `local-nfs` repo. Verify it completes successfully and data appears in `/velero-backups`.

```bash
kubectl exec -n backrest deploy/backrest -- ls -la /velero-backups/
```

Expected: Restic repository structure (config, data, index, keys, locks, snapshots directories).

- [ ] **Step 11: Commit**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add helm-charts/backrest/values.yaml helm-charts/backrest/templates/deployment.yaml
git commit -m "feat(backrest): add 300Gi NFS volume for local backup repository

Add backups persistence entry on asustor-nfs StorageClass mounted at
/velero-backups. Existing SFTP→Synology repo retained as second copy.
Config and cache remain on Synology iSCSI."
```

---

## Task 4: Velero Local BSL via Garage S3 (BLOCKED)

**Prerequisite:** In-cluster Garage must be upgraded to v2.2.0 and joined to the external 4-node Garage cluster. Mimir data transfer is ~50% complete as of 2026-04-05. **Do not start this task until that work completes.**

**Files:**
- Create: `portfolio-orchestration-platform/k8s/external-secrets/velero-garage-credentials-external-secret.yaml`
- Modify: `portfolio-orchestration-platform/k8s/velero-values.yaml`
- Modify: `devops-portfolio-manager/helm-charts/monitoring/templates/velero-schedules.yaml`
- Modify: `devops-portfolio-manager/helm-charts/monitoring/values.yaml` (veleroSchedules section)

- [ ] **Step 1: Create Garage bucket and access key**

From any node that can reach the Garage admin API (e.g., ASUSTOR):

```bash
# SSH to ASUSTOR
ssh maxjeffwell@10.0.0.4

# Create the bucket
docker exec garage /garage bucket create velero

# Create a dedicated access key
docker exec garage /garage key create --name velero-key

# Grant access
docker exec garage /garage bucket allow --read --write --owner velero --key velero-key
```

Save the access key ID (`GK...`) and secret key from the output.

- [ ] **Step 2: Add credentials to Doppler**

In the Doppler dashboard, `portfolio/prd` project:
- `VELERO_GARAGE_ACCESS_KEY` → the `GK...` access key ID
- `VELERO_GARAGE_SECRET_KEY` → the secret key

- [ ] **Step 3: Create ExternalSecret for Velero Garage credentials**

Create `portfolio-orchestration-platform/k8s/external-secrets/velero-garage-credentials-external-secret.yaml`:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: velero-garage-credentials-external-secret
  namespace: velero
spec:
  data:
  - remoteRef:
      key: VELERO_GARAGE_ACCESS_KEY
    secretKey: accessKeyID
  - remoteRef:
      key: VELERO_GARAGE_SECRET_KEY
    secretKey: secretAccessKey
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: doppler-secret-store
  target:
    creationPolicy: Owner
    deletionPolicy: Retain
    name: velero-garage-credentials
    template:
      data:
        cloud: '[default]

          aws_access_key_id={{ .accessKeyID }}

          aws_secret_access_key={{ .secretAccessKey }}

          '
      engineVersion: v2
      mergePolicy: Replace
```

- [ ] **Step 4: Apply the ExternalSecret**

```bash
kubectl apply -f /home/maxjeffwell/GitHub_Projects/portfolio-orchestration-platform/k8s/external-secrets/velero-garage-credentials-external-secret.yaml
```

Verify:

```bash
kubectl get externalsecret -n velero velero-garage-credentials-external-secret
kubectl get secret -n velero velero-garage-credentials
```

Expected: ExternalSecret status `SecretSynced`, secret exists.

- [ ] **Step 5: Add second BSL to velero-values.yaml**

In `portfolio-orchestration-platform/k8s/velero-values.yaml`, modify the `backupStorageLocation` array (line 2-10):

```yaml
configuration:
  backupStorageLocation:
    - name: default
      provider: aws
      bucket: Marmoset
      prefix: velero
      config:
        region: us-east-005
        s3ForcePathStyle: true
        s3Url: https://s3.us-east-005.backblazeb2.com
    - name: local
      provider: aws
      bucket: velero
      credential:
        name: velero-garage-credentials
        key: cloud
      config:
        region: garage
        s3ForcePathStyle: true
        s3Url: http://garage.monitoring.svc.cluster.local:3900
  defaultVolumesToFsBackup: true
```

- [ ] **Step 6: Helm upgrade Velero**

```bash
helm upgrade velero vmware-tanzu/velero \
  -n velero \
  -f /home/maxjeffwell/GitHub_Projects/portfolio-orchestration-platform/k8s/velero-values.yaml
```

- [ ] **Step 7: Verify both BSLs are available**

```bash
kubectl get backupstoragelocations.velero.io -n velero
```

Expected: Two BSLs (`default` and `local`), both with phase `Available`.

- [ ] **Step 8: Add weekly-local schedule to monitoring values**

In `devops-portfolio-manager/helm-charts/monitoring/values.yaml`, add a new schedule after the existing weekly config (after line 12):

```yaml
  weeklyLocal:
    schedule: "0 3 * * 0"
    ttl: 720h0m0s
    storageLocation: local
```

- [ ] **Step 9: Add weekly-local Schedule template**

In `devops-portfolio-manager/helm-charts/monitoring/templates/velero-schedules.yaml`, add after the existing weekly schedule (before the `{{- end }}`):

```yaml
---
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: weekly-backup-local
  namespace: {{ .Values.veleroSchedules.namespace | default "velero" }}
spec:
  schedule: {{ .Values.veleroSchedules.weeklyLocal.schedule | quote }}
  storageLocation: {{ .Values.veleroSchedules.weeklyLocal.storageLocation }}
  template:
    excludedNamespaces:
      {{- toYaml .Values.veleroSchedules.excludedNamespaces | nindent 6 }}
    ttl: {{ .Values.veleroSchedules.weeklyLocal.ttl }}
```

- [ ] **Step 10: Helm upgrade monitoring chart**

```bash
helm upgrade prometheus /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring \
  -n monitoring \
  --set kube-prometheus-stack.grafana.adminPassword="$(kubectl get secret -n monitoring prometheus-grafana -o jsonpath='{.data.admin-password}' | base64 -d)" \
  --reuse-values
```

- [ ] **Step 11: Verify the new schedule exists**

```bash
kubectl get schedules.velero.io -n velero
```

Expected: Three schedules: `daily-backup`, `weekly-backup`, `weekly-backup-local`.

- [ ] **Step 12: Run a manual backup to the local BSL**

```bash
velero backup create test-local-backup --storage-location local --ttl 1h
velero backup describe test-local-backup --details
```

Expected: Backup completes successfully against the Garage S3 endpoint.

- [ ] **Step 13: Verify data landed in Garage**

```bash
# From ASUSTOR or any node with garage CLI access
docker exec garage /garage bucket info velero
```

Expected: Shows objects and bytes stored in the `velero` bucket.

- [ ] **Step 14: Clean up test backup**

```bash
velero backup delete test-local-backup --confirm
```

- [ ] **Step 15: Commit all changes**

```bash
cd /home/maxjeffwell/GitHub_Projects/portfolio-orchestration-platform
git add k8s/velero-values.yaml k8s/external-secrets/velero-garage-credentials-external-secret.yaml
git commit -m "feat(velero): add local BSL backed by Garage S3 cluster

Second BackupStorageLocation 'local' points at in-cluster Garage
(post v2.2.0 upgrade). Weekly backups now target both B2 and local
Garage for fast restores + off-site DR."

cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add helm-charts/monitoring/values.yaml helm-charts/monitoring/templates/velero-schedules.yaml
git commit -m "feat(velero): add weekly-backup-local schedule targeting Garage BSL

New weekly schedule writes to the local Garage S3 BSL alongside
the existing B2 weekly and daily schedules."
```

---

## Task 5: Verification and Cleanup

**Context:** After Tasks 1-3 are complete (Task 4 is deferred), verify the full NFS stack is working and clean up.

- [ ] **Step 1: Verify democratic-csi is serving real PVCs**

```bash
kubectl get pvc --all-namespaces | grep asustor-nfs
```

Expected: Two PVCs bound — Grafana (5Gi) and Backrest backups (300Gi).

- [ ] **Step 2: Verify NFS usage on ASUSTOR**

```bash
ssh maxjeffwell@10.0.0.4 'df -h /mnt/k8s-nfs'
```

Expected: Shows usage reflecting the PVC data.

- [ ] **Step 3: Check democratic-csi subdirectories**

```bash
ssh maxjeffwell@10.0.0.4 'ls -la /mnt/k8s-nfs/v/'
```

Expected: Two subdirectories matching PVC IDs.

- [ ] **Step 4: Confirm Grafana dashboards persist across restart**

Create a test dashboard in Grafana UI, then restart the pod:

```bash
kubectl rollout restart deployment prometheus-grafana -n monitoring
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=grafana -n monitoring --timeout=300s
```

Verify the test dashboard still exists after restart.

- [ ] **Step 5: Confirm Backrest local backup is intact after restart**

```bash
kubectl rollout restart deployment backrest -n backrest
kubectl wait --for=condition=Ready pod -l app=backrest -n backrest --timeout=120s
```

Verify backup history and local-nfs repo are visible in Backrest UI.

- [ ] **Step 6: Update LVM memory doc**

Update `/home/maxjeffwell/.claude/projects/-home-maxjeffwell/memory/project_iscsi_luns.md` to reflect:
- `lan-share` now 756G (was 1.52T)
- `k8s-nfs` now 800G (was 500G)
- ~500G free in VG
- VG no longer "fully allocated"
