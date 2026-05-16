# Democratic-CSI NFS Utilization Design

**Date:** 2026-04-05
**Status:** Approved
**Scope:** Put the existing democratic-csi NFS driver (ASUSTOR `asustor-nfs` StorageClass) to work with real workloads, plus add Velero local backups via Garage S3.

## Context

The democratic-csi NFS driver has been installed and running in the K3s cluster since late March 2026, but no PVCs have been created against the `asustor-nfs` StorageClass. Three pods (1 controller + 2 DaemonSet nodes) consume ~71m CPU and ~262Mi memory with zero consumers.

The ASUSTOR AS5402T exports `/mnt/k8s-nfs` (backed by `/dev/vg-ssd/k8s-nfs`, 500G ext4) via NFSv4. The `vg-ssd` volume group is fully allocated across 4 LVs, but `lan-share` (1.52T) is effectively empty (1% used).

## Decisions

- **Approach A (separate PVCs per workload)** chosen over shared PVC with subPath mounts. Follows democratic-csi's `nfs-client` driver model (one PVC = one managed subdirectory at `/mnt/k8s-nfs/v/<pvc-id>/`).
- **Velero uses Garage S3** (external 4-node cluster) rather than NFS. S3 is native to Velero's BSL model, provides cross-device replication via Garage's `replication_factor=2`, and reuses the existing AWS plugin.
- **Backrest keeps config and cache on Synology iSCSI**. Only the local backup repository goes to NFS. Existing SFTP→Synology repo retained as second copy.

## Section 1: LVM Resize on ASUSTOR

One-time manual SSH operation. No K8s or init script changes required.

### Changes

| LV | Current Size | New Size | Delta |
|----|-------------|----------|-------|
| `lan-share` | 1.52T | 756G | -800G freed |
| `k8s-nfs` | 500G | 800G | +300G consumed |
| **VG free** | 0 | **500G** | unallocated |

### Procedure

1. `umount /mnt/lan-share`
2. `e2fsck -f /dev/vg-ssd/lan-share`
3. `resize2fs /dev/vg-ssd/lan-share 756G`
4. `lvreduce -L 756G /dev/vg-ssd/lan-share`
5. `mount /dev/vg-ssd/lan-share /mnt/lan-share`
6. `lvextend -L 800G /dev/vg-ssd/k8s-nfs`
7. `resize2fs /dev/vg-ssd/k8s-nfs` (online, no unmount needed)

### Notes

- Shrinking ext4 requires unmount + fsck first. Growing is online-safe.
- Order matters: resize2fs before lvreduce (shrink), lvextend before resize2fs (grow).
- Democratic-csi sees the larger NFS export transparently — no config changes.
- The `S97lvm-nfs` init script mounts `k8s-nfs` and writes `/etc/exports` on boot. Mount point and export path are unchanged.

## Section 2: Grafana Persistent Storage

Replace Grafana's EmptyDir with a persistent NFS-backed PVC.

### Current State

- Grafana uses EmptyDir for `/var/lib/grafana` (ephemeral)
- ~215Mi currently in use (SQLite DB, plugins, dashboards)
- k8s-app plugin installed via init container on every restart
- Manually created dashboards lost on pod restart
- Liveness probe comment notes "500 SQLite migrations on every startup (EmptyDir storage)"

### Changes

- **New PVC**: 5Gi on `asustor-nfs`, mounted at `/var/lib/grafana`
- **File**: `helm-charts/monitoring/values.yaml` — enable `grafana.persistence`
  - `enabled: true`
  - `storageClassName: asustor-nfs`
  - `size: 5Gi`
- **Init container**: Keep `install-k8s-plugin` but add idempotency check (skip if plugin directory already exists)
- **Helm upgrade**: `helm upgrade prometheus` in monitoring namespace

### What Persists

- Manually created dashboards
- Grafana preferences and starred dashboards
- Plugin installations (no re-download on restart)
- Alert state and annotations
- SQLite database (faster startups — no 500-migration penalty)

### What Stays the Same

- Sidecar-provisioned datasources
- Default dashboards from kube-prometheus-stack
- Catalog plugins (polystat, infinity, treemap) still install via Grafana native mechanism

## Section 3: Backrest Local Backups on NFS

Add a local backup repository on NFS alongside the existing SFTP→Synology remote repo.

### Current State

- Backrest pod in `backrest` namespace, single replica on vmi3115606
- Backup source: `/mnt/iscsi` (hostPath, read-only — iSCSI LUNs on worker)
- Backup destination: `sftp:maxjeffwell@10.0.0.5:/Iron_Wolf/Backups/k3s-iscsi` (Synology)
- Internal state at `/data` → `backrest-data-synology` PVC (2Gi, synology-iscsi)
- Config at `/config` → `backrest-config-synology` PVC (1Gi, synology-iscsi)
- Cache at `/cache` → `backrest-cache-synology` PVC (3Gi, synology-iscsi)

### Changes

- **New PVC**: `backrest-backups-nfs` — 300Gi on `asustor-nfs`, mounted at `/velero-backups`
- **File**: `helm-charts/backrest/values.yaml` — add new volume + volumeMount
- **File**: `helm-charts/backrest/templates/deployment.yaml` — wire up the new volume
- **Backrest config**: Add new local repo in `config.json` targeting `/velero-backups` as a restic repository
- **Backup plans**: Add or modify plans to target the new local repo (in addition to existing SFTP repo)

### Data Migration

- `kubectl cp` contents from `backrest-data-synology` PVC to preserve existing backup history/metadata before switching
- Old `backrest-data-synology` PVC retained as fallback until new repo confirmed working

### What Stays on Synology iSCSI

- `backrest-config-synology` (1Gi) at `/config`
- `backrest-cache-synology` (3Gi) at `/cache`
- `backrest-data-synology` (2Gi) at `/data` — internal state

## Section 4: Velero Local BSL via Garage S3

Add a second Velero BackupStorageLocation backed by the Garage S3 cluster.

### Prerequisite

The in-cluster Garage (currently v1.1.0, single node) must be upgraded to v2.2.0 and joined to the external 4-node Garage cluster. This work is in progress (Mimir data transfer ~50% complete as of 2026-04-05). **This section is blocked until that completes.**

### External Garage Cluster

| Node | Zone | Capacity |
|------|------|----------|
| ASUSTOR AS5402T | nas | 1000G |
| Synology DS423 | nas2 | 1000G |
| AXE-7800 | router | 200G |
| AX86U Pro | router2 | 800G |

- `replication_factor=2` — each object on 2 of 3+ zones
- ~1.5TB effective capacity

### Changes

1. **Create Garage bucket**: `velero` bucket with dedicated access key via `garage bucket create velero` and `garage key create --name velero-key --allow-create-bucket velero`
2. **Doppler secrets**: Store Garage access key as `VELERO_GARAGE_ACCESS_KEY` and `VELERO_GARAGE_SECRET_KEY` in `portfolio/prd`
3. **ExternalSecret**: New `velero-garage-credentials` ExternalSecret in velero namespace, generating a secret in AWS credentials file format (same structure as existing `cloud-credentials`)
4. **Second BSL** in `velero-values.yaml`:
   ```yaml
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
   ```
   The `credential` field binds this BSL to its own secret, separate from the default B2 `cloud-credentials`.
5. **Backup schedules**: Weekly backups target both `default` (B2) and `local` (Garage); dailies stay B2-only

### Why In-Cluster Endpoint

Once the in-cluster Garage joins the external cluster, Velero talks to `garage.monitoring.svc.cluster.local:3900` — no WireGuard hop for the initial S3 request. Garage replicates to other nodes internally.

## NFS Budget

| Workload | PVC Size | Mount Path |
|----------|----------|------------|
| Grafana | 5Gi | `/var/lib/grafana` |
| Backrest local backups | 300Gi | `/velero-backups` |
| **Total** | **305Gi** | |
| **Available** | **~495Gi** | on 800G `k8s-nfs` |

## Scope Boundaries

- In-cluster Garage v2.2.0 upgrade and cluster join: **prerequisite for Section 4, not part of this spec**
- Democratic-csi NFS driver configuration: **no changes needed** — existing Helm release and StorageClass work as-is
- LVM resize: **manual SSH operation**, not automated
- Backrest `config.json` changes: **manual via Backrest UI or kubectl exec**, not Helm-managed
