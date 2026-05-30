# Vaultwarden Deployment — Design

**Date:** 2026-05-29
**Status:** Approved (design), pending spec review
**Repo:** `devops-portfolio-manager`
**Branch:** `feat/vaultwarden`

## Goal

Run a self-hosted Vaultwarden (Bitwarden-compatible password manager) on the cluster
as the primary instance for multiple invited users, reachable over the public internet,
with a hardened security posture, continuous point-in-time DB recovery, and an
independent off-cluster break-glass copy. Existing vault data on the ASUSTOR NAS is
migrated in so nothing is lost.

## Decisions (settled during brainstorming)

| Area | Decision | Rationale |
|------|----------|-----------|
| Node | Pin app pod to **vmi2951245** | Most memory-request headroom; `node-agent` runs there (backup-capable); a Traefik replica already co-located. Control-plane taint is soft (`PreferNoSchedule`), already overridden by 56 pods. |
| App storage | `local-path` PVC at `/data`, RWO, pinned to vmi2951245 | Holds `rsa_key.pem`, attachments, icon cache, sends. SC is `WaitForFirstConsumer` + `Retain`; pinning makes placement deterministic and data survives PVC deletion. |
| Database | **Dedicated CNPG cluster `cnpg-vaultwarden`, 2 instances (HA)** | Vault DB survives a vmi2951245 outage; clones the proven CNPG pattern; isolated failure/backup domain. |
| DB backup | **Barman Cloud Plugin → Backblaze B2** (base + WAL) for continuous PITR; optional VolumeSnapshot for fast local restore | Operator is CNPG 1.29 where inline `barmanObjectStore` is deprecated; the plugin is the supported path. B2 is reliable + offsite; vault WAL volume is tiny. |
| `/data` backup | Velero **File-System Backup** (kopia) — automatic | `--default-volumes-to-fs-backup` enabled cluster-wide; node-agent on vmi2951245 captures the PVC. Wildcard `daily/weekly` → Garage; **add `vaultwarden` to `weekly-offsite`** → B2. |
| Migration | **One-time import of ASUSTOR `db.sqlite3` → CNPG**, carry over `rsa_key.pem` + attachments | ASUSTOR holds the real 2.86 MB vault; K8s must start populated. Carrying `rsa_key` keeps existing client sessions valid. |
| ASUSTOR role | **Independent break-glass copy** (not a live standby) | Bitwarden clients cache offline, so instant failover is low-value; the NAS's worth is *failure-mode independence* from the cluster. |
| Exposure | Public **Traefik** ingress `vaultwarden.el-jefe.me`, TLS via `letsencrypt-prod` | `DOMAIN` set accordingly; WebSocket on; HTTPS mandatory (WebCrypto secure-context). |
| Signups | **Invitation-only**: `SIGNUPS_ALLOWED=false` + `INVITATIONS_ALLOWED=true` | Unlimited users, no open internet registration; admin invites via `/admin`. SMTP optional. |
| Secrets | ESO **ExternalSecret** from Doppler | `ADMIN_TOKEN` (argon2-PHC) + optional SMTP; never committed plaintext. |
| Hardening | CrowdSec bouncer middleware + default-deny NetworkPolicy | Most sensitive public service; bouncer ties into the existing Loki→CrowdSec chain. |
| GitOps | Raw manifests under `k8s/vaultwarden/` + ArgoCD `Application` | Mirrors the `jellyfin` layout; ESO `ignoreDifferences` in the Application. |

## Architecture

```
Internet ── DNS vaultwarden.el-jefe.me → ServiceLB (100.64.x) → Traefik ─[CrowdSec mw]─┐
                                                                                        ▼
                                                  Service vaultwarden (ClusterIP :80)
                                                                                        ▼
                              Vaultwarden Pod (1 replica, Recreate)  ── pinned vmi2951245
                                ├─ /data → local-path PVC (rsa_key, attachments, cache)
                                └─ DATABASE_URL → cnpg-vaultwarden-rw:5432
                                                     ▼
                              CNPG cnpg-vaultwarden (2 instances, HA, anti-affinity)
                                ├─ streaming replication + auto-failover
                                ├─ storage: democratic-synology-iscsi-mp
                                └─ Barman Cloud Plugin → Backblaze B2  (base + WAL = PITR)

  Backups (3 independent tracks)
    1. DB     → Barman Cloud Plugin → B2          (continuous PITR, offsite)
    2. /data  → Velero FSB → Garage + B2          (daily + weekly offsite)
    3. Whole  → periodic export → ASUSTOR NFS     (off-cluster, separate failure domain)
                 + dormant ASUSTOR Vaultwarden app (static break-glass spare)
```

## Components

### 0. Prerequisite — Barman Cloud Plugin
Install the CNPG **Barman Cloud Plugin** (`plugin-barman-cloud`) cluster-wide (its
Deployment + `ObjectStore` CRD). Managed as its own ArgoCD app or helm release.
Required because CNPG 1.29 deprecates inline `barmanObjectStore`.

### 1. Namespace
`vaultwarden` — dedicated. CNPG operator (`cnpg-system`) is cluster-scoped.

### 2. CNPG cluster `cnpg-vaultwarden`
- `instances: 2`, image `ghcr.io/cloudnative-pg/postgresql:17` (matches existing clusters).
- `storage.storageClass: democratic-synology-iscsi-mp`, `size: 5Gi`.
- `affinity.enablePodAntiAffinity: true`, `topologyKey: kubernetes.io/hostname` → two
  instances on **different nodes**.
- Async streaming replication + CNPG automatic failover (synchronous intentionally off
  — with 2 instances it would stall writes when the replica is down).
- Bootstrap creates database + owner role; credentials in `cnpg-vaultwarden-app` secret.
- `.spec.plugins`: reference the Barman Cloud `ObjectStore` for archiving.

### 3. ObjectStore + DB backup (Barman Cloud Plugin → B2)
- `ObjectStore` resource: endpoint `https://s3.us-east-005.backblazeb2.com`,
  region `us-east-005`, bucket/prefix e.g. `k3s-velero-eljefe-backups/cnpg-vaultwarden/`,
  S3 credentials from an ESO-delivered secret (B2 application key).
- WAL archiving continuous; `wal.compression: gzip`; retention policy (e.g. 30d).
- `ScheduledBackup` (daily) base backup via the plugin.
- *Optional:* a second `ScheduledBackup` with `method: volumeSnapshot`
  (`democratic-csi-mp-snapclass`) for fast local restores.

### 4. Vaultwarden Deployment
- 1 replica, `strategy: Recreate`. `nodeSelector: kubernetes.io/hostname: vmi2951245`.
- Image `vaultwarden/server:<pinned-tag>-alpine` — tag + digest verified vs Docker Hub.
- Volume `/data` ← local-path PVC. initContainer waits for `cnpg-vaultwarden-rw:5432`.
- Probes on `/alive`. securityContext: `allowPrivilegeEscalation: false`, drop ALL caps.
- Resources: req `cpu 50m / mem 64Mi`, lim `cpu 250m / mem 256Mi`.

#### Environment
| Var | Value | Note |
|-----|-------|------|
| `DOMAIN` | `https://vaultwarden.el-jefe.me` | WebAuthn/attachments |
| `DATABASE_URL` | from `cnpg-vaultwarden-app` secret `uri` key | Fallback: compose from `username`/`password` |
| `SIGNUPS_ALLOWED` | `false` | Invitation-only |
| `INVITATIONS_ALLOWED` | `true` | Admin invites via `/admin` |
| `ADMIN_TOKEN` | ExternalSecret (argon2-PHC) | Gates `/admin` |
| `ENABLE_WEBSOCKET` | `true` | Live sync |
| `SHOW_PASSWORD_HINT` | `false` | No public hint leak |
| `SMTP_*` | ExternalSecret, empty default | Optional |

### 5. Service / Ingress / ExternalSecret / NetworkPolicy
- **Service:** ClusterIP :80 → container 80.
- **Ingress:** Traefik, `vaultwarden.el-jefe.me`, `letsencrypt-prod` TLS, CrowdSec bouncer
  Middleware via `traefik.ingress.kubernetes.io/router.middlewares`.
- **ExternalSecret:** ESO → Doppler → Secret `vaultwarden-secrets` (`ADMIN_TOKEN`,
  optional `SMTP_*`); admin token stored pre-hashed (argon2 PHC).
- **NetworkPolicy (default-deny):** ingress from Traefik to `:80`; egress DNS `:53`,
  Postgres to `cnpg-vaultwarden` `:5432`, optional SMTP; CNPG instances allow
  replication + operator + app `:5432`.

### 6. ArgoCD Application `gitops/applications/vaultwarden.yaml`
- `path: k8s/vaultwarden`, `destination.namespace: vaultwarden`, ESO `ignoreDifferences`
  block (matches `jellyfin.yaml`), automated sync (prune + selfHeal), `CreateNamespace`,
  `ServerSideApply`.
- **Sync waves:** `ObjectStore` + CNPG `Cluster` + `ExternalSecret` (wave 0) before the
  Vaultwarden `Deployment` (wave 1).

### 7. Velero offsite inclusion
One-line edit to `weekly-offsite` (`k8s/backups`): add `vaultwarden` to
`includedNamespaces` so the `/data` copy reaches B2. Wildcard schedules already cover
Garage.

## Migration (one-time runbook — detail in implementation plan)
1. Sync `cnpg-vaultwarden` first; let Vaultwarden start once against empty Postgres so
   diesel migrations create the schema, then stop it.
2. Load ASUSTOR `db.sqlite3` data into Postgres (e.g. `pgloader`, data-only, reconciling
   `__diesel_schema_migrations`).
3. Copy ASUSTOR `bw-data/rsa_key.pem` + `attachments/` + `sends/` into the K8s `/data` PVC
   (keeps existing client sessions valid; preserves attachments).
4. Start Vaultwarden; verify login + a known vault item + an attachment.
5. Lower the ASUSTOR app to dormant break-glass (installed, stopped).

## Break-glass copy on ASUSTOR
- The existing ASUSTOR Vaultwarden (SQLite) is **left installed but stopped** — a static,
  fully-independent recovery path (separate host/Docker/SQLite/storage). It already holds
  a full pre-migration copy.
- A periodic **export CronJob** writes a current logical copy to an ASUSTOR **NFS** share:
  CNPG `pg_dump` of the vault DB + a copy of `/data`. This is the off-cluster, separate-
  failure-domain third backup track. (Optional manual refresh of the dormant app from this
  export if a fresher break-glass is wanted.)

## Backup & Recovery model (three tracks)
| Asset | Mechanism | Restore granularity | Failure-domain |
|-------|-----------|---------------------|----------------|
| Vault DB | Barman Cloud Plugin → B2 (base + WAL) | **Continuous PITR** | Offsite cloud |
| `/data` | Velero FSB → Garage + B2 | Daily + weekly offsite | Cluster + offsite |
| Whole vault | Export CronJob → ASUSTOR NFS + dormant app | Per-export (manual failover) | Off-cluster NAS |

**Proof step (post-deploy):** on-demand Velero backup of the namespace reaches
`Completed` with `/data` listed; on-demand CNPG plugin backup + WAL visible in B2; a
test-restore of the CNPG cluster into a throwaway namespace loads the schema; the ASUSTOR
export job produces a non-empty dump.

## Risks & considerations
1. **Barman Cloud Plugin is a new cluster component** to install/operate (vs the
   deprecated inline path we declined). One-time setup cost.
2. **WAL archiving can fill `pg_wal`** if B2 is unreachable long enough; low risk for a
   low-write vault, but monitor archiving health. WAN drops (Spectrum) only delay async
   archiving.
3. **Synology iSCSI dependency** for the DB (networked; some flap/corruption history).
   Mitigated by 2-instance replication + B2 PITR.
4. **Migration `rsa_key` choice:** carrying ASUSTOR's key keeps sessions valid; the
   dormant ASUSTOR app keeps its *own* key, so a break-glass failover re-prompts logins
   (acceptable).
5. **Break-glass is cold** — as fresh as its last export; failover loses recent changes.
   Accepted given offline client caches.
6. **Velero backups currently empty** (Garage outage fixed 2026-05-29) — the proof step
   confirms FSB works again.
7. **Confirm at implementation:** CrowdSec middleware name, Doppler ClusterSecretStore
   name, B2 application-key for CNPG, CNPG `uri`-key availability, ASUSTOR container name
   + current run state.

## Out of scope
- Active-active / shared-DB warm standby (explicitly declined).
- Organizations/collections policy beyond defaults.
- SMTP provider selection (wired but optional).
- Migrating or re-architecting the other CNPG clusters.
