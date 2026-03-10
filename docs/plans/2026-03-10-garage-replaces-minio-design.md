# Replace MinIO with Garage as In-Cluster S3 Object Store

**Date:** 2026-03-10
**Status:** Approved

## Goal

Replace MinIO with Garage as the in-cluster S3-compatible object store for Mimir (and future Tempo). Garage is lighter (~50MB RAM vs MinIO's ~600MB), while maintaining production-grade S3 compatibility for Mimir's storage needs.

## Context

- Mimir runs in monolithic mode (single pod) on vmi2951245
- MinIO serves as Mimir's S3 backend — currently using 43GB for `mimir-blocks` with 90-day retention
- Loki was already migrated to Garage on the ASUSTOR NAS; MinIO's `loki-chunks` (2.2GB) are stale
- 13 orphaned PVCs (~32GB) remain from old distributed Mimir deployment
- Grafana Tempo will be implemented next and will also use this Garage instance
- MinIO is a Helm subchart dependency gated by `minio.enabled`

## Architecture

```
Prometheus --> remoteWrite --> Mimir monolithic --> Garage (S3 API :3900) --> PVC (local-path, 80Gi)
                                                        ^
                                              Same node (vmi2951245)
                                              localhost-speed access

Future:
Tempo --> Garage (S3 API :3900) --> same PVC
```

## Bucket Layout & Access Control

| Bucket | Service | Purpose | Expected Size |
|--------|---------|---------|---------------|
| `mimir-blocks` | Mimir | TSDB block storage | ~43GB (90d retention) |
| `mimir-ruler` | Mimir | Recording/alerting rules | KBs |
| `mimir-alertmanager` | Mimir | Alertmanager state & templates | KBs |
| `tempo-traces` | Tempo | Trace block storage | TBD |

**API keys (separate per service):**
- `mimir-service` — read+write on `mimir-blocks`, `mimir-ruler`, `mimir-alertmanager`
- `tempo-service` — read+write on `tempo-traces` (created when Tempo is implemented)

## Garage Configuration

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "garage-0.garage-headless.monitoring.svc.cluster.local:3901"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"

[admin]
api_bind_addr = "[::]:3903"
```

- `rpc_secret` and `admin_token` injected from Doppler via env vars, not hardcoded
- `replication_factor = 1` (single node, no replication needed)
- `db_engine = "sqlite"` (lighter memory footprint than LMDB)

## New Helm Templates

| Template | Purpose |
|----------|---------|
| `garage-configmap.yaml` | `garage.toml` with env var placeholders for secrets |
| `garage-statefulset.yaml` | Single-replica StatefulSet, 80Gi PVC, pinned to vmi2951245 |
| `garage-service.yaml` | ClusterIP exposing port 3900 (S3 API) and 3903 (admin API) |
| `garage-externalsecret.yaml` | Pulls Garage credentials from Doppler |
| `garage-init-job.yaml` | Post-install hook: configure layout, create buckets, set permissions |

## Values.yaml Changes

**New `garage` section:**
```yaml
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

**Mimir endpoint change (after mirror):**
```yaml
mimirMonolithic:
  storage:
    credentialsSecret: garage-mimir-credentials
    s3:
      endpoint: garage.monitoring.svc.cluster.local:3900
```

## Doppler Secrets

| Key | Purpose |
|-----|---------|
| `GARAGE_RPC_SECRET` | Node-to-node RPC authentication (random 32-byte hex) |
| `GARAGE_ADMIN_TOKEN` | Admin API authentication for init job (random 32-byte hex) |
| `GARAGE_MIMIR_ACCESS_KEY_ID` | Mimir S3 access key |
| `GARAGE_MIMIR_SECRET_ACCESS_KEY` | Mimir S3 secret key |
| `GARAGE_TEMPO_ACCESS_KEY_ID` | Tempo S3 access key (added when Tempo is implemented) |
| `GARAGE_TEMPO_SECRET_ACCESS_KEY` | Tempo S3 secret key (added when Tempo is implemented) |

## Migration Plan

### Pre-migration
1. Delete 13 orphaned distributed Mimir directories (~32GB reclaimed)
2. Delete stale `loki-chunks` and `loki-ruler` data from MinIO PVC (~2.2GB reclaimed)
3. Add Garage secrets to Doppler

### Phase 1 — Deploy Garage
4. Add Garage templates to monitoring chart
5. Add `garage` section to values.yaml
6. `helm upgrade` — Garage pod starts alongside MinIO
7. Run init job — configure layout, create buckets, create API key with bucket permissions

### Phase 2 — Mirror & Swap
8. `mc mirror` from MinIO to Garage (mimir-blocks, mimir-ruler, mimir-alertmanager only)
9. Update `mimirMonolithic.storage.s3.endpoint` to Garage
10. `helm upgrade` — Mimir restarts, connects to Garage
11. Verify Mimir is healthy, Grafana dashboards load with historical data

### Phase 3 — Decommission MinIO
12. Set `minio.enabled: false` in values.yaml
13. `helm upgrade` — MinIO pod removed
14. Manually delete orphaned MinIO PVC directory (~45GB reclaimed)
15. Commit and push all changes

**Total disk reclaimed: ~77GB** (32GB orphaned Mimir + 45GB MinIO)

## Resource Impact

| | CPU (actual) | Memory (actual) | PVC |
|---|---|---|---|
| **MinIO (removed)** | -275m | -600Mi | -20Gi (45GB actual) |
| **Garage (added)** | ~10m | ~50Mi | +80Gi |
| **Net change** | **-265m** | **-550Mi** | +60Gi declared, -77GB actual after cleanup |

## Risks & Mitigations

- **S3 compatibility**: Garage covers the S3 subset Mimir uses. Already proven with Loki on ASUSTOR.
- **Less community prior art**: Garage+Mimir is less common than MinIO+Mimir. Mitigated by straightforward S3 API usage and operational familiarity with Garage.
- **Data migration**: Mirror before swap ensures zero gap in historical metrics. Velero backups to B2 provide additional safety net.
- **Init job complexity**: Garage bucket/key setup requires admin API calls, not S3-compatible admin ops. One-time job handles this.

## Future: ASUSTOR NAS Garage Secrets

The ASUSTOR Garage instance has `rpc_secret` and `admin_token` hardcoded in `garage.toml`. These should be moved to a secrets manager in a follow-up task.
