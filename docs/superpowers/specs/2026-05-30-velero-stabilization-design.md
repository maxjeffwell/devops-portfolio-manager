# Velero Stabilization — Design Spec

**Date:** 2026-05-30
**Status:** Approved (design); pending implementation plan
**Branch:** `chore/velero-weekly-offsite-into-git` (integrates with commit `b4c15d5`)
**Canonical repos:**
- Velero **install** (Deployment, server tuning, local garage BSLs `default`/`local`): `portfolio-orchestration-platform/k8s/velero-values.yaml`
- Velero **schedules/alerts** (daily/weekly/weekly-local): `devops-portfolio-manager/helm-charts/monitoring` (Helm release `prometheus`, chart `monitoring-1.0.0`)
- Velero **offsite** (weekly-offsite schedule **+ the `backblaze` BSL**): `devops-portfolio-manager/k8s/backups/` (ArgoCD `backups` app, server-side-apply adoption) — offsite schedule and offsite storage location are owned together by concern.

---

## 1. Problem Statement

Velero has had zero clean `Completed` scheduled backups for weeks. Triage on 2026-05-30 found this is **chronic and multi-tiered**, not the single garage-quorum incident recorded on 2026-05-29. Distinct, independently-caused failures:

| Sev | Symptom | Root cause (evidence) |
|-----|---------|------------------------|
| 🔴 SEV-1 | Volume **data** backups failing 5+ days | kopia DataUploads to garage `Failed`/`Canceled` (incl. one 302 GB vol at 4 GB done). Garage S3 backend instability (quorum flaps / USB-SSD CRC / loopback-NFS — see memory). Manifests back up (4871/4871) but **bytes do not**. |
| 🔴 SEV-1 | Offsite (backblaze) tier `Unavailable` | BSL validation rejects bucket: `invalid top-level directories: [cnpg-vaultwarden]`. A cnpg `ObjectStore/vaultwarden-b2` (created ~4h before triage) writes to `s3://k3s-velero-eljefe-backups/cnpg-vaultwarden` — same bucket as the prefix-less backblaze BSL. |
| 🟠 SEV-2 | Non-deterministic pod-volume skips | client-go rate-limiter exhaustion: `Skip pod volume … client rate limiter Wait returned an error: context deadline exceeded`. Velero `--client-qps`/`--client-burst` at defaults vs. a 4871-item backup. |
| 🟠 SEV-2 | ~29 CSI snapshot failures/run | `Failed to create snapshot … DeadlineExceeded` against the 10-min `CSISnapshotTimeout`. |
| 🟡 SEV-3 | GitOps drift | `velero-schedules/alerts` templates duplicated in **both** `portfolio-orchestration-platform/helm/prometheus/` (stale; missing `weekly-backup-local`) and the canonical `devops-portfolio-manager/helm-charts/monitoring/`. |
| 🟡 SEV-3 | Failures not paging | All findings surfaced manually. `velero-backup-alerts` (2 rules) loaded + `alertmanager-gotify-bridge` running, but likely only alerts on `Failed`, not `PartiallyFailed`/BSL-`Unavailable`/stuck DataUploads. |

**Reframe:** "4871/4871 items backed up" measures *manifests*; restorable *volume data* travels a separate CSI-snapshot + node-agent/kopia path that is the actual SEV-1 failure. A backup is only "working" once a **restore-test** proves it.

## 2. Goals / Non-Goals

**Goals:** restorable volume data (local + offsite), offsite tier `Available`, deterministic volume coverage, single source of truth per management plane, alerting that pages on real failure, ≥1 proven restore.

**Non-Goals (explicit):**
- Migrating the Velero data target **off garage** — decision is to keep garage and stabilize it.
- `snapshotMoveData` for offsite — **not needed**: `weekly-offsite` already ships volume data to B2 via `defaultVolumesToFsBackup: true` + includedNamespaces allowlist. Fixing the BSL (WS-1) resurrects this path.
- Touching the user's live manual `vaultwarden-*` test backups.
- Merging the two intentional management planes (denylist Helm schedules vs. allowlist ArgoCD offsite schedule) — they are deliberately separate.

## 3. Workstreams

Sequence: **WS-0 first** (so later edits target the right files), then independent quick wins (WS-1, WS-2), then the keystone (WS-3), then verification (WS-4).

### WS-0 — GitOps consolidation
- Delete the stale Velero templates under `portfolio-orchestration-platform/helm/prometheus/templates/` (`velero-schedules.yaml`, `velero-alerts.yaml`, `velero-backup-verify-cronjob.yaml`).
- Confirm `helm/prometheus` is not the live `prometheus` release before deleting (live release templates = the `devops-portfolio-manager/helm-charts/monitoring` set, proven by `weekly-backup-local` presence).
- Document the three-plane ownership map (install / helm-schedules / argo-offsite) in the monitoring chart README.

### WS-1 — Offsite unblock (shared bucket, add prefix)
- **Relocate the `backblaze` BSL into the `backups` ArgoCD app:** author a `BackupStorageLocation` manifest under `devops-portfolio-manager/k8s/backups/` (alongside `velero-weekly-offsite.yaml`) carrying `objectStorage.prefix: velero`. Remove the `backblaze` entry from `portfolio-orchestration-platform/k8s/velero-values.yaml` (install keeps only the local garage `default`/`local` BSLs). The live resource is currently hand-`kubectl apply`-ed and label-less; ArgoCD server-side-apply adopts and reconciles it (same adoption pattern as the offsite Schedule).
- cnpg `vaultwarden-b2` stays in the same bucket, untouched. No migration: existing root-level offsite backups are all `Failed`/expiring, nothing to preserve.
- **Acceptance:** `velero backup-location get backblaze` → `Available`; next `weekly-offsite` run not `FailedValidation`; ArgoCD `backups` app `Synced`/`Healthy` and owning the BSL.

### WS-2 — Server tuning
- Set Velero server `--client-qps` / `--client-burst` above defaults (start **100 / 200** — opened higher than a minimal bump given the ~4,871-item backups; still headroom below extreme values) via `velero-values.yaml` (`configuration`/`extraArgs` per chart schema); apply to node-agent if it exhibits the same limiter waits.
- Raise `CSISnapshotTimeout` (10m → 20m) on the schedules' templates; from the failing snapshot UUIDs, identify which CSI driver (Mayastor / synology / democratic-csi) times out and note tuning follow-up.
- **Acceptance:** a backup run with zero `client rate limiter` skips; CSI `DeadlineExceeded` count drops materially.

### WS-3 — Data tier (keystone)
- **3a Right-size FSB scope (CORRECTED — opt-OUT model):** This cluster runs `configuration.defaultVolumesToFsBackup: true`, so **every** pod volume is kopia-FS-backed-up unless it carries a `backup.velero.io/backup-volumes-excludes` annotation. Current excludes: backrest, redis, percona-mongodb, and **garage's `data` (monitoring)** — so the garage-into-garage case is *already* handled (no action needed; my earlier "self-dependency" reading was a grep that matched the `-excludes` annotation). The real overload: **Jellyfin's two 2 Ti media PVCs have NO exclude → kopia tries to back up terabytes of replaceable media to garage every run** (the 302 GB Canceled DataUpload). Action: add `backup.velero.io/backup-volumes-excludes: media-movies,media-tvshows,cache` to the Jellyfin pod template (keep `config` on Mayastor — irreplaceable watch-state/metadata), and audit other large replaceable PVCs (model caches: triton/llm/ollama) for exclusion. Net effect: kopia only ships irreplaceable data, so garage can actually keep up.
- **3b Stabilize garage:** apply the documented garage runbook (restart the FAILED garage pod to restore write quorum; watch for ASUSTOR-node flaps). Re-run a backup and confirm DataUploads/PodVolumeBackups reach `Completed`.
- **3c Offsite data (already designed):** once WS-1 makes the BSL `Available`, verify `weekly-offsite` FSB→B2 actually ships data for its allowlist; restore-test one DB from the B2 copy.
- **Acceptance:** a daily backup with all FSB volumes `Completed`; one successful B2-sourced restore.

### WS-4 — Alerting + restore proof
- Extend `velero-backup-alerts` (canonical monitoring chart) to fire on: backup `PartiallyFailed`, BSL `Unavailable`, and `DataUpload`/`PodVolumeBackup` failed-or-stuck.
- Fire a synthetic alert; confirm it reaches Gotify via `alertmanager-gotify-bridge`.
- Schedule/automate a periodic restore-test (the existing `*-restore-test` jobs under `k8s/backups/` are the pattern).
- **Acceptance:** induced failure pages within one scrape interval; restore-test job green.

## 4. Risks
- **BSL prefix re-roots offsite** → existing root backups undiscovered. Mitigated: offsite history is all failed/expiring (no value lost).
- **BSL ownership handoff** → live `backblaze` BSL is hand-applied/label-less; ArgoCD must *adopt* (server-side apply) it, not create a duplicate. Verify ArgoCD owns it and the `velero-values.yaml` removal doesn't trigger the Velero chart to delete it during the transition (sequence: add to `backups` app + sync, confirm adoption, then remove from `velero-values.yaml`).
- **Garage instability is environmental** (USB-SSD/ASUSTOR) → stabilization may be mitigation, not permanent cure; WS-4 alerting is the safety net for recurrence.

## 5. Open Items for the Plan
1. Exact Velero Helm chart key for client QPS/burst (chart schema check).

## 6. Resolved Decisions (2026-05-30 review)
- **Offsite BSL home:** lives in the `backups` ArgoCD app (with the offsite Schedule), not `velero-values.yaml`.
- **garage-into-garage FSB:** already excluded (no action) — intent "don't back up garage into garage" is satisfied by the existing `backup-volumes-excludes: data` on the garage StatefulSet. The actionable equivalent of "right-size scope" is excluding **Jellyfin media** (2 Ti × 2) + model caches, the true kopia/garage overload.
- **Limiter opening values:** `--client-qps 100` / `--client-burst 200`.
- **Offsite data mechanism:** existing `weekly-offsite` FSB allowlist (no `snapshotMoveData`).
- **Data target:** keep garage, stabilize (no migration off it).
