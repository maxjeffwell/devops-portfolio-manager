# Velero Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Velero to producing restorable, alerted, offsite-replicated backups by fixing the offsite bucket collision, right-sizing what kopia ships to garage, raising starved client/CSI limits, collapsing GitOps drift, and proving alerting + restore.

**Architecture:** GitOps across three planes — Velero **install** (manual Helm `velero` chart 12.0.0, `portfolio-orchestration-platform/k8s/velero-values.yaml`), **schedules/alerts** (manual Helm `prometheus` release = local chart `devops-portfolio-manager/helm-charts/monitoring`), and **offsite + apps** (ArgoCD apps `backups` → `k8s/backups`, `jellyfin` → `k8s/jellyfin`). Each task edits the source-of-truth file, applies via that plane's mechanism, and verifies with a `kubectl`/`velero` command before committing.

**Tech Stack:** Velero 1.18.0 (kopia uploader, EnableCSI), Helm, ArgoCD, Backblaze B2 + Garage S3, CloudNativePG.

**Working branch:** `chore/velero-weekly-offsite-into-git` (continue here; the spec commit `e1de39b` is already on it).

**Conventions used in every task:**
- "POP" = `~/GitHub_Projects/portfolio-orchestration-platform`; "DPM" = `~/GitHub_Projects/devops-portfolio-manager`.
- Read real backup errors in-cluster: `kubectl exec -n velero deploy/velero -c velero -- /velero backup logs <name>` (host DNS can't fetch result blobs).
- No `Co-Authored-By: Claude` trailers (user preference).
- Do NOT touch the user's live manual `vaultwarden-*` test backups.

---

## File Structure

| File | Plane | Change |
|------|-------|--------|
| `POP/helm/prometheus/templates/velero-{schedules,alerts,backup-verify-cronjob}.yaml` | dead code | **Delete** (stale duplicates; not the live release) |
| `DPM/k8s/backups/velero-backblaze-bsl.yaml` | ArgoCD `backups` | **Create** — BSL with `prefix: velero` |
| `POP/k8s/velero-values.yaml` | Helm `velero` | **Modify** — remove `backblaze` BSL entry; add `clientQPS`/`clientBurst` |
| `DPM/helm-charts/monitoring/templates/velero-schedules.yaml` | Helm `prometheus` | **Modify** — add `csiSnapshotTimeout` to each schedule template |
| `DPM/helm-charts/monitoring/values.yaml` | Helm `prometheus` | **Modify** — add `veleroSchedules.csiSnapshotTimeout` |
| `DPM/k8s/jellyfin/deployment.yaml` | ArgoCD `jellyfin` | **Modify** — exclude media/cache volumes from FSB |
| `DPM/helm-charts/monitoring/templates/velero-alerts.yaml` | Helm `prometheus` | **Modify** — add DataUpload-stuck alert |

---

## Task 0: Pre-flight snapshot of current broken state

**Files:** none (evidence capture).

- [ ] **Step 1: Record the baseline so we can prove improvement**

Run:
```bash
velero backup-location get
velero get datauploads 2>/dev/null | awk 'NR==1 || /Failed|Canceled/ {print}' | head -20
kubectl -n velero get schedules
git -C ~/GitHub_Projects/devops-portfolio-manager log --oneline -1
```
Expected (baseline): `backblaze … Unavailable`; multiple `Failed`/`Canceled` DataUploads; 4 schedules; HEAD = `e1de39b` (spec).

- [ ] **Step 2: No commit** (read-only baseline).

---

## Task 1: WS-0 — Delete stale Velero templates (GitOps drift)

**Files:**
- Delete: `POP/helm/prometheus/templates/velero-schedules.yaml`
- Delete: `POP/helm/prometheus/templates/velero-alerts.yaml`
- Delete: `POP/helm/prometheus/templates/velero-backup-verify-cronjob.yaml`

- [ ] **Step 1: Prove these are NOT the live release before deleting**

Run:
```bash
helm -n monitoring get manifest prometheus | grep -c "weekly-backup-local"   # live release
grep -c "weekly-backup-local" ~/GitHub_Projects/portfolio-orchestration-platform/helm/prometheus/templates/velero-schedules.yaml
```
Expected: live release `>= 1`; POP file `0` → confirms POP copy is the stale fork (missing `weekly-backup-local`). If POP shows `>=1`, STOP — provenance is ambiguous, re-verify which chart produces release `prometheus`.

- [ ] **Step 2: Delete the stale files**

Run:
```bash
cd ~/GitHub_Projects/portfolio-orchestration-platform
git rm helm/prometheus/templates/velero-schedules.yaml \
       helm/prometheus/templates/velero-alerts.yaml \
       helm/prometheus/templates/velero-backup-verify-cronjob.yaml
```

- [ ] **Step 3: Verify the chart still templates cleanly (no dangling refs)**

Run: `helm template prometheus ~/GitHub_Projects/portfolio-orchestration-platform/helm/prometheus >/dev/null && echo OK`
Expected: `OK` (no error about the deleted files).

- [ ] **Step 4: Commit** (in POP repo)

```bash
cd ~/GitHub_Projects/portfolio-orchestration-platform
git add -A && git commit -m "Remove stale duplicate Velero templates from prometheus chart

Live schedules/alerts are owned by devops-portfolio-manager/helm-charts/monitoring
(release 'prometheus'). This POP copy was a stale fork missing weekly-backup-local
and was never the deployed source."
```
> Note: POP may need its own branch if on default. Run `git -C ~/GitHub_Projects/portfolio-orchestration-platform branch --show-current` first; if `main`/`master`, `git checkout -b velero-stabilization` before committing.

---

## Task 2: WS-1a — Author the backblaze BSL in the `backups` ArgoCD app (with prefix)

**Files:**
- Create: `DPM/k8s/backups/velero-backblaze-bsl.yaml`

- [ ] **Step 1: Capture the exact live BSL spec to reproduce faithfully**

Run: `kubectl -n velero get backupstoragelocation backblaze -o yaml | grep -A20 "^spec:"`
Expected: shows `bucket: k3s-velero-eljefe-backups`, `s3Url`, `region: us-east-005`, `s3ForcePathStyle: true`, credential `cloud-credentials/cloud`, and **no** `prefix`.

- [ ] **Step 2: Create the governed manifest WITH the prefix**

Create `DPM/k8s/backups/velero-backblaze-bsl.yaml`:
```yaml
# Backblaze B2 offsite BackupStorageLocation.
# Owned by the `backups` ArgoCD app (adopts the previously hand-applied resource
# via server-side apply). The `prefix: velero` scopes Velero to velero/* so the
# co-resident cnpg-vaultwarden/ top-level dir no longer fails BSL validation.
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: backblaze
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: k3s-velero-eljefe-backups
    prefix: velero
  credential:
    name: cloud-credentials
    key: cloud
  config:
    region: us-east-005
    s3ForcePathStyle: "true"
    s3Url: https://s3.us-east-005.backblazeb2.com
```

- [ ] **Step 3: Add it to the `backups` kustomization if one exists**

Run: `ls ~/GitHub_Projects/devops-portfolio-manager/k8s/backups/kustomization.yaml 2>/dev/null && cat ~/GitHub_Projects/devops-portfolio-manager/k8s/backups/kustomization.yaml || echo "no kustomization (ArgoCD applies the dir directly)"`
If a `kustomization.yaml` with an explicit `resources:` list exists, add `- velero-backblaze-bsl.yaml` to it. If not, ArgoCD applies the directory directly — no edit needed.

- [ ] **Step 4: Commit (DPM, on the working branch)**

```bash
cd ~/GitHub_Projects/devops-portfolio-manager
git add k8s/backups/
git commit -m "Govern backblaze BSL in backups ArgoCD app with prefix: velero

Resolves 'invalid top-level directories: [cnpg-vaultwarden]' by scoping Velero to
velero/* within the shared bucket. cnpg-vaultwarden stays put. ArgoCD adopts the
previously hand-applied resource via server-side apply."
```

- [ ] **Step 5: Push and let ArgoCD adopt; confirm ownership BEFORE removing from velero-values (Task 3)**

Run:
```bash
git push
argocd app sync backups 2>/dev/null || echo "trigger sync via UI if CLI unauthenticated"
kubectl -n velero get backupstoragelocation backblaze -o jsonpath='{.metadata.labels}{"\n"}'
```
Expected: BSL now carries ArgoCD labels (`app.kubernetes.io/instance: backups` or `argocd.argoproj.io/instance`). This proves adoption — required before Task 3 removes it from the Helm install (else the Velero chart could delete it).

---

## Task 3: WS-1b + WS-2 — Remove BSL from install; raise clientQPS/Burst

**Files:**
- Modify: `POP/k8s/velero-values.yaml` (remove `backblaze` BSL entry lines; add `clientQPS`/`clientBurst`)

- [ ] **Step 1: Confirm live values match the file before upgrading (drift guard)**

Run:
```bash
helm -n velero get values velero -o yaml > /tmp/velero-live-values.yaml
diff <(grep -E "clientQPS|clientBurst|backblaze|k3s-velero-eljefe" /tmp/velero-live-values.yaml) \
     <(grep -E "clientQPS|clientBurst|backblaze|k3s-velero-eljefe" ~/GitHub_Projects/portfolio-orchestration-platform/k8s/velero-values.yaml) \
  && echo "values in sync"
```
Expected: `values in sync` (live install was deployed from this file). If they differ, reconcile the file to live first.

- [ ] **Step 2: Edit `POP/k8s/velero-values.yaml`** — remove the `backblaze` BSL block and add the limiter keys.

Remove these lines from `configuration.backupStorageLocation` (the second list entry):
```yaml
    - name: backblaze
      provider: aws
      bucket: k3s-velero-eljefe-backups
      config:
        region: us-east-005
        s3ForcePathStyle: true
        s3Url: https://s3.us-east-005.backblazeb2.com
```
Then under `configuration:` (sibling of `defaultVolumesToFsBackup`), add:
```yaml
  # Chart defaults are clientQPS:20 / clientBurst:30 — far too low for ~4871-item
  # backups; the client-go rate limiter saturates and silently skips pod volumes.
  clientQPS: 100
  clientBurst: 200
```

- [ ] **Step 3: Apply the Velero install upgrade**

Run:
```bash
helm upgrade velero vmware-tanzu/velero --version 12.0.0 -n velero \
  -f ~/GitHub_Projects/portfolio-orchestration-platform/k8s/velero-values.yaml --wait
kubectl -n velero rollout status deploy/velero --timeout=120s
```
Expected: rollout succeeds.

- [ ] **Step 4: Verify the new server flags AND that ArgoCD still owns the BSL**

Run:
```bash
kubectl -n velero get deploy velero -o jsonpath='{.spec.template.spec.containers[0].args}' | tr ',' '\n' | grep -E "client-qps|client-burst"
kubectl -n velero get backupstoragelocation backblaze -o jsonpath='{.metadata.labels}{"\n"}'
```
Expected: args contain `--client-qps=100` and `--client-burst=200`; backblaze BSL still present with ArgoCD labels (Helm did NOT delete it because ArgoCD owns it).

- [ ] **Step 5: Verify offsite BSL is now Available**

Run: `velero backup-location get backblaze`
Expected: `PHASE = Available` (the prefix fix took effect). If still `Unavailable`, run `kubectl -n velero get bsl backblaze -o jsonpath='{.status.message}'` and inspect.

- [ ] **Step 6: Commit (POP)**

```bash
cd ~/GitHub_Projects/portfolio-orchestration-platform
git add k8s/velero-values.yaml
git commit -m "Velero install: drop backblaze BSL (now ArgoCD-owned); raise clientQPS/Burst to 100/200

BSL moved to devops-portfolio-manager backups app with prefix: velero.
clientQPS/Burst raised from chart defaults (20/30) to stop rate-limiter pod-volume skips."
```

---

## Task 4: WS-2b — Raise CSISnapshotTimeout on schedules

**Files:**
- Modify: `DPM/helm-charts/monitoring/values.yaml` (add `veleroSchedules.csiSnapshotTimeout`)
- Modify: `DPM/helm-charts/monitoring/templates/velero-schedules.yaml` (reference it in each template)

- [ ] **Step 1: Add the value** — in `DPM/helm-charts/monitoring/values.yaml`, under `veleroSchedules:` (after `namespace: velero`), add:
```yaml
  # Velero default is 10m; storage layer (Mayastor/synology/democratic-csi) needs longer.
  csiSnapshotTimeout: "20m"
```

- [ ] **Step 2: Reference it in the template** — in `DPM/helm-charts/monitoring/templates/velero-schedules.yaml`, add this line inside the `template:` block of EACH of the three schedules (daily-backup, weekly-backup, weekly-backup-local), immediately under `template:`:
```yaml
    csiSnapshotTimeout: {{ .Values.veleroSchedules.csiSnapshotTimeout | default "20m" }}
```

- [ ] **Step 3: Render-check the template**

Run: `helm template prometheus ~/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring -s templates/velero-schedules.yaml | grep -c "csiSnapshotTimeout: 20m"`
Expected: `3` (one per schedule).

- [ ] **Step 4: Apply the prometheus release upgrade**

Run:
```bash
helm upgrade prometheus ~/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring -n monitoring --reuse-values
kubectl -n velero get schedule daily-backup -o jsonpath='{.spec.template.csiSnapshotTimeout}{"\n"}'
```
Expected: `20m`.

- [ ] **Step 5: Commit (DPM)**

```bash
cd ~/GitHub_Projects/devops-portfolio-manager
git add helm-charts/monitoring/values.yaml helm-charts/monitoring/templates/velero-schedules.yaml
git commit -m "Raise CSISnapshotTimeout to 20m on Velero schedules

Storage layer was hitting DeadlineExceeded against the 10m default."
```

---

## Task 5: WS-3a — Exclude Jellyfin media (and cache) from FSB

**Files:**
- Modify: `DPM/k8s/jellyfin/deployment.yaml` (add pod-template annotation)

- [ ] **Step 1: Prove media is currently being FS-backed-up (baseline)**

Run: `kubectl -n jellyfin get pod -l app=jellyfin -o jsonpath='{.items[0].metadata.annotations}{"\n"}' | grep -o "backup.velero.io[^,}]*" || echo "NO exclude annotation -> 2Ti media IS in scope (opt-out model)"`
Expected: `NO exclude annotation …`.

- [ ] **Step 2: Add the exclude annotation** — in `DPM/k8s/jellyfin/deployment.yaml`, change the pod template `metadata` block (currently lines 18-21) from:
```yaml
    metadata:
      labels:
        app: jellyfin
        portfolio: "true"
```
to:
```yaml
    metadata:
      labels:
        app: jellyfin
        portfolio: "true"
      annotations:
        # Opt OUT of kopia FS-backup for replaceable volumes (cluster default is
        # defaultVolumesToFsBackup=true). media-* are 2Ti each; cache is regenerable.
        # KEEP `config` (Mayastor) — irreplaceable library/watch-state metadata.
        backup.velero.io/backup-volumes-excludes: media-movies,media-tvshows,cache
```

- [ ] **Step 3: Commit, push, sync ArgoCD**

```bash
cd ~/GitHub_Projects/devops-portfolio-manager
git add k8s/jellyfin/deployment.yaml
git commit -m "Exclude Jellyfin media+cache from Velero FSB

2Ti media-movies/media-tvshows were being shoved through kopia to garage every
backup (the 302GB Canceled DataUpload), overloading the backend. Keep config
(Mayastor) which holds irreplaceable library/watch-state."
git push
argocd app sync jellyfin 2>/dev/null || echo "trigger sync via UI if CLI unauthenticated"
```

- [ ] **Step 4: Verify the running pod carries the exclude (after Recreate rollout)**

Run: `kubectl -n jellyfin get pod -l app=jellyfin -o jsonpath='{.items[0].metadata.annotations.backup\.velero\.io/backup-volumes-excludes}{"\n"}'`
Expected: `media-movies,media-tvshows,cache`.

---

## Task 6: WS-3b — Stabilize garage backend (conditional runbook)

**Files:** none (operational).

- [ ] **Step 1: Check garage write-quorum health**

Run:
```bash
kubectl -n monitoring get pods -l app.kubernetes.io/name=garage -o wide 2>/dev/null || kubectl -n monitoring get pods | grep garage
kubectl -n monitoring exec garage-0 -- /garage status 2>/dev/null | tail -15 || echo "garage CLI path differs; check pod"
```
Expected: both garage pods `Running`; `garage status` shows all nodes connected, no node failing quorum.

- [ ] **Step 2: If a garage node shows disconnected/FAILED, apply the documented fix**

Per memory `project-velero-backups-failing-asustor-garage-quorum-2026-05-29`: restart the garage pod that shows the peer as FAILED (Garage doesn't auto-reconnect a flapped peer):
```bash
kubectl -n monitoring delete pod <garage-pod-showing-FAILED-peer>
```
If healthy, **skip** — no action.

- [ ] **Step 3: No commit** (operational state, not config).

---

## Task 7: WS-3c — Prove local + offsite data backups actually work

**Files:** none (verification via on-demand backups).

- [ ] **Step 1: Trigger an on-demand daily backup (local/garage path, post-tuning + post-exclude)**

Run:
```bash
velero backup create stabilize-check-daily --from-schedule daily-backup --wait
```
Expected: completes `Completed` (or `PartiallyFailed` with a materially lower error count). Capture: `velero backup describe stabilize-check-daily | grep -E "Phase|Errors|Warnings"`.

- [ ] **Step 2: Confirm no rate-limiter skips and DataUploads/PVBs succeed**

Run:
```bash
kubectl exec -n velero deploy/velero -c velero -- /velero backup logs stabilize-check-daily 2>/dev/null | grep -c "client rate limiter"
kubectl exec -n velero deploy/velero -c velero -- /velero backup logs stabilize-check-daily 2>/dev/null | grep -c "media-movies\|media-tvshows"
```
Expected: `0` rate-limiter messages; `0` jellyfin media volume backups attempted.

- [ ] **Step 3: Trigger an on-demand offsite backup (B2 path)**

Run:
```bash
velero backup create stabilize-check-offsite --from-schedule weekly-offsite --wait
velero backup describe stabilize-check-offsite | grep -E "Phase|Storage Location|Errors"
```
Expected: `Phase: Completed`, `Storage Location: backblaze`, no `FailedValidation`.

- [ ] **Step 4: Restore-test one DB to prove recoverability (the real definition of "working")**

Pick a small DB namespace with data backed up (e.g. a percona-mongodb or a cnpg PG). Restore into a temp namespace:
```bash
velero restore create stabilize-restore-test --from-backup stabilize-check-offsite \
  --include-namespaces <small-db-ns> --namespace-mappings <small-db-ns>:restore-test-velero --wait
velero restore describe stabilize-restore-test | grep -E "Phase|Errors"
kubectl -n restore-test-velero get pods,pvc
```
Expected: `Phase: Completed`; PVCs bound and data present. Then clean up: `kubectl delete ns restore-test-velero`.

- [ ] **Step 5: No commit** (verification). Record results in the PR description.

---

## Task 8: WS-4 — Add DataUpload alert + prove paging reaches Gotify

**Files:**
- Modify: `DPM/helm-charts/monitoring/templates/velero-alerts.yaml` (add one rule)

- [ ] **Step 1: Diagnose why existing alerts never paged (rules already exist)**

Run:
```bash
# Are velero metrics scraped?
kubectl -n monitoring exec deploy/prometheus-kube-prometheus-prometheus 2>/dev/null -c prometheus -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=velero_backup_partial_failure_total' | head -c 400
# Is the alert active in Prometheus?
kubectl -n monitoring exec deploy/prometheus-kube-prometheus-prometheus -c prometheus -- \
  wget -qO- 'http://localhost:9090/api/v1/alerts' 2>/dev/null | grep -o "Velero[A-Za-z]*" | sort -u
# Is alertmanager routing to the gotify bridge?
kubectl -n monitoring logs deploy/alertmanager-gotify-bridge --tail=20 2>/dev/null
```
Expected: identifies the break — metric absent (scrape/ServiceMonitor issue), alert never `firing` (expr/metric mismatch), or gotify-bridge errors (routing). Fix the identified gap (ServiceMonitor for velero, or Alertmanager route to the bridge receiver). Capture the root cause in the PR.

- [ ] **Step 2: Add the genuinely-missing DataUpload-stuck/failed alert** — in `DPM/helm-charts/monitoring/templates/velero-alerts.yaml`, inside `spec.groups[0].rules`, add:
```yaml
    # Alert when volume DATA movement (kopia DataUploads) fails — manifests can
    # succeed while restorable bytes silently fail. This was the 5-day blind spot.
    - alert: VeleroDataUploadFailing
      expr: increase(velero_csi_snapshot_failure_total[24h]) > 0
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "Velero volume-data (DataUpload/CSI) failures detected"
        description: "Kopia DataUploads or CSI snapshots are failing — backups may have no restorable volume data. Check `velero get datauploads`."
        priority: "9"
```
> If `velero_csi_snapshot_failure_total` is not exposed by this Velero version, substitute the verified metric found in Step 1's `/api/v1/query` exploration (e.g. a `velero_csi_snapshot_attempt_total - …_success_total` expression). Do NOT ship an alert on a non-existent metric — confirm the metric exists first via the Prometheus query API.

- [ ] **Step 3: Render-check + apply**

Run:
```bash
helm template prometheus ~/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring -s templates/velero-alerts.yaml | grep -c "VeleroDataUploadFailing"
helm upgrade prometheus ~/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring -n monitoring --reuse-values
kubectl -n monitoring get prometheusrule velero-backup-alerts -o yaml | grep -c "VeleroDataUploadFailing"
```
Expected: template `1`; applied rule `1`.

- [ ] **Step 4: Prove an alert reaches Gotify end-to-end (synthetic)**

Run (fire a harmless test alert straight at Alertmanager):
```bash
kubectl -n monitoring exec deploy/alertmanager-gotify-bridge -- sh -c 'echo bridge-up' 2>/dev/null
# Use amtool or a curl to the alertmanager API to post a test alert, then confirm:
kubectl -n monitoring logs deploy/alertmanager-gotify-bridge --tail=5
```
Expected: the gotify-bridge log shows the test alert forwarded (HTTP 200 to Gotify). Confirm receipt on the Gotify client.

- [ ] **Step 5: Commit (DPM)**

```bash
cd ~/GitHub_Projects/devops-portfolio-manager
git add helm-charts/monitoring/templates/velero-alerts.yaml
git commit -m "Add VeleroDataUploadFailing alert; fix alert→Gotify routing

Existing PartiallyFailed/Unavailable rules never paged (root cause in PR). Adds the
missing volume-data failure alert so the 5-day silent DataUpload blind spot pages."
```

---

## Task 9: Finalize — PR with verification evidence

- [ ] **Step 1: Confirm end state**

Run:
```bash
velero backup-location get
velero get backups | grep stabilize-check
kubectl -n velero get schedule daily-backup -o jsonpath='{.spec.template.csiSnapshotTimeout}{"\n"}'
```
Expected: `backblaze … Available`; both `stabilize-check-*` `Completed`; `20m`.

- [ ] **Step 2: Open PRs** (two repos touched). Use `superpowers:finishing-a-development-branch` to decide merge vs PR. Paste Task 7 + Task 8 verification output into the PR body. DPM branch: `chore/velero-weekly-offsite-into-git`. POP branch: `velero-stabilization` (or as created in Task 1).

---

## Self-Review Notes (filled during planning)
- **Opt-OUT model:** every task assumes `defaultVolumesToFsBackup: true`; WS-3a *excludes* rather than includes. Verified live (4 exclude annotations, 0 include).
- **Sequencing safeguard:** Task 2 (ArgoCD adopts BSL) strictly precedes Task 3 (Helm removes BSL) so the chart can't delete the offsite location mid-handoff. Task 4 verification re-confirms BSL survives the Helm upgrade.
- **No invented metrics:** Task 8 Step 2 explicitly forbids shipping an alert on an unverified metric and routes through the Step 1 metric exploration.
- **Apply planes correct:** velero/prometheus = manual Helm; backups/jellyfin = ArgoCD sync. Each task uses the matching mechanism.
