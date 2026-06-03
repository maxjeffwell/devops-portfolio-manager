# Dedicate Synology USB NIC (.109) to Garage Backup-Ingest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route on-prem (debian-marmoset-resident) Velero backup ingress through a dedicated on-prem Garage S3 endpoint on the Synology USB NIC `eth2`/.109, via a new additive BSL + schedule, without touching any existing BSL/schedule or the Synology Garage node config.

**Architecture:** Add a `nas-local` BackupStorageLocation whose `s3Url` is `http://192.168.50.109:3900` (reusing the `velero-local` bucket with a `nas-local` prefix and the existing `velero-garage-credentials`), plus a broad daily Schedule scoped to debian-marmoset-resident stateful namespaces. A Velero volume resource-policy (skip NFS + `csi-s3`) plus namespace drops (`ovms`, `openebs`) plus one jellyfin pod annotation keep large/replaceable/circular volumes out of the coarse FS backup. All objects are GitOps-managed under `k8s/backups/` (the `backups` ArgoCD app) and `k8s/jellyfin/`.

**Tech Stack:** Velero v1.16 (Helm chart `velero-12.0.0`), Garage v2.2.0 (S3), Kubernetes (k3s), ArgoCD (`backups` app = plain-directory source, auto-includes new YAML), kopia FS-backup via node-agent DaemonSet, WireGuard/Tailscale overlay.

**Runner legend:**
- `[agent]` — runnable from this session via `kubectl` on marmoset, `git` in the repo, or non-root SSH to nodes.
- No `[user-sudo]` steps: unlike the ASUSTOR effort, this plan changes **no NAS-side config** — only Git manifests + Velero CRs.

**Reference values (captured 2026-06-02):**
- Synology Garage node `c2194d82e4ed754a` (`boom_boom`), zone `nas2`, advertises `10.0.0.5:3901` — **unchanged by this plan**.
- Synology `eth2`/.109: 2.5 GbE USB, driver `r8152` (RTL8156). `bond0`/.129 is the hot path.
- Only on-prem node-agent: `debian-marmoset`. Velero **server** pod also on `debian-marmoset`. Cloud node-agents (`vmi2951245`/`vmi3115606`) + `backrest` (cloud) are out of scope by residency.
- Existing `local` BSL: provider `aws`, bucket `velero-local` (no prefix), cred `{name: velero-garage-credentials, key: cloud}`, config `{region: garage, s3ForcePathStyle: "true", s3Url: http://garage.monitoring.svc.cluster.local:3900}`.
- velero namespace has **no** NetworkPolicies (not default-deny).
- Exclude volume types: `jellyfin-media-movies` (NFS `.149`, 2Ti), `jellyfin-media-tvshows` (NFS `.133`, 2Ti), `triton-models-pvc` (sc `csi-s3`, 50Gi), `ovms/ovms-models` (sole PVC in ns), `openebs/data-mayastor-etcd-0` (sole PVC in ns), `jellyfin/jellyfin-cache` (sc `openebs-lvmpv`, vol name `cache`), `monitoring/alertmanager-…-db` (sc `local-path`, 2Gi — accepted, see Task 4).
- jellyfin pod volume names: `config`, `cache`, `media-movies`, `media-tvshows`.

---

## Task 1: Pre-flight baseline, reachability, residency, version gate

Capture proof-of-before state and verify all preconditions. Nothing is changed.

**Files:** writes a local capture `/home/maxjeffwell/synology-nas-local-baseline.txt`, then commits a copy under `docs/superpowers/plans/artifacts/`.

- [ ] **Step 1: Capture Garage cluster view (Synology node unchanged target)** `[agent]`

Run:
```bash
GPOD=$(kubectl get pods -n monitoring -o name | grep garage | head -1)
kubectl exec -n monitoring "${GPOD##*/}" -c garage -- /garage status \
  | tee /home/maxjeffwell/synology-nas-local-baseline.txt
```
Expected: a `==== HEALTHY NODES ====` table; node `c2194d82e4ed754a` (`boom_boom`) shown at `10.0.0.5:3901`, zone `nas2`. Record that this address must remain `10.0.0.5:3901` after the change (this plan must NOT move it).

- [ ] **Step 2: Capture Synology eth2 + bond0 byte counters + eth2 link baseline** `[agent]`

Run:
```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 maxjeffwell@192.168.50.109 '
date
echo "eth2 rx=$(cat /sys/class/net/eth2/statistics/rx_bytes) tx=$(cat /sys/class/net/eth2/statistics/tx_bytes)"
echo "bond0 rx=$(cat /sys/class/net/bond0/statistics/rx_bytes) tx=$(cat /sys/class/net/bond0/statistics/tx_bytes)"
ethtool eth2 2>/dev/null | grep -E "Speed|Link detected"
echo "eth2-resets(disconnect): $(dmesg 2>/dev/null | grep -c "USB disconnect")"
' | tee -a /home/maxjeffwell/synology-nas-local-baseline.txt
```
Expected: `eth2` Speed `2500Mb/s`, `Link detected: yes`. Record the rx/tx counters — Task 8 compares against them. A non-zero `USB disconnect` count is fine (baseline only).

- [ ] **Step 3: Verify the Velero server + node-agent path to .109:3900** `[agent]`

Run (the velero server pod is on debian-marmoset; test from the host it shares — pod has no shell):
```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 maxjeffwell@192.168.50.152 \
  'curl -s -o /dev/null -w "host->.109:3900 http=%{http_code} t=%{time_total}s\n" --max-time 5 http://192.168.50.109:3900/'
```
Expected: `http=403` (Garage anonymous-denied = S3 alive). If timeout/UNREACHABLE, **stop** — resolve LAN reachability before proceeding.

- [ ] **Step 4: Node-residency gate — assert in-scope stateful pods are on debian-marmoset** `[agent]`

Run (lists any PVC-bearing pod NOT on debian-marmoset across candidate namespaces):
```bash
for ns in default microservices percona-mongodb neon qdrant vaultwarden monitoring vertex-platform jellyfin cluster-nfs nfs-provisioners; do
  kubectl get pods -n "$ns" -o json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin)
for p in d["items"]:
    node=p["spec"].get("nodeName","")
    has_pvc=any("persistentVolumeClaim" in v for v in p["spec"].get("volumes",[]))
    if has_pvc and node!="debian-marmoset":
        print(f"OFF-NODE: {p[\"metadata\"][\"namespace\"]}/{p[\"metadata\"][\"name\"]} on {node}")
'
done; echo "residency scan done"
```
Expected: only `residency scan done` (no `OFF-NODE:` lines). Any `OFF-NODE:` namespace must be **removed** from the Task 6 `includedNamespaces` (its PVB would run on a node that cannot reach .109).

- [ ] **Step 5: Confirm velero ns has no blocking NetworkPolicy + Velero version supports volume policy `skip`** `[agent]`

Run:
```bash
kubectl get networkpolicy -n velero
kubectl get deploy -n velero velero -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```
Expected: `No resources found` (egress to .109 unrestricted) and a Velero image `>= v1.14` (volume-policy `skip` action + `nfs`/`storageClass` conditions). If a netpol exists, add an egress allow for the node-agent/server to `192.168.50.109/32:3900` before Task 7.

- [ ] **Step 6: Commit the baseline artifact** `[agent]`

Run:
```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
mkdir -p docs/superpowers/plans/artifacts
cp /home/maxjeffwell/synology-nas-local-baseline.txt docs/superpowers/plans/artifacts/2026-06-02-synology-nas-local-baseline.txt
git add docs/superpowers/plans/artifacts/2026-06-02-synology-nas-local-baseline.txt
git commit -m "chore: capture Synology .109 nas-local baseline before BSL/schedule add"
```
Expected: commit succeeds.

---

## Task 2: Resolve deferred scope decisions (neon, NFS-backing)

Decide keep/exclude for the two namespaces the spec deferred, using real size/contents.

**Files:** none (read-only); records the decision in this plan's Task 6 namespace list.

- [ ] **Step 1: Inspect neon + NFS-backing volume sizes and roles** `[agent]`

Run:
```bash
for pvc in neon/neon-pageserver-tenantflow-neon-neon-pageserver-0 \
           neon/neon-safekeeper-tenantflow-neon-neon-safekeeper-0 \
           cluster-nfs/nfs-backing \
           nfs-provisioners/pvc-cluster-nfs-provisioner-nfs-subdir-external-provisioner; do
  ns=${pvc%/*}; name=${pvc#*/}
  pv=$(kubectl get pvc -n "$ns" "$name" -o jsonpath='{.spec.volumeName}' 2>/dev/null)
  cap=$(kubectl get pvc -n "$ns" "$name" -o jsonpath='{.status.capacity.storage}' 2>/dev/null)
  sc=$(kubectl get pvc -n "$ns" "$name" -o jsonpath='{.spec.storageClassName}' 2>/dev/null)
  echo "$pvc -> cap=$cap sc=$sc pv=$pv"
done
```
Expected: capacities + storage classes for each. Decision rule:
- **neon/***: if total > ~20Gi OR safekeeper count ≥ 2 (WAL already replicated) → **exclude** the `neon` namespace from Task 6 scope (its own durability covers it; FS PVB is large + crash-inconsistent). If small and single-instance → keep.
- **cluster-nfs/nfs-backing** + **nfs-provisioners/***: if these are the *backing store* for subdir-provisioned PVCs already covered by their own namespaces → **exclude** both namespaces (avoid double-coverage). If they hold otherwise-unbacked data → keep.

- [ ] **Step 2: Record the decision inline** `[agent]`

Edit this file's Task 6 `includedNamespaces` block to reflect the Step 1 decision (add or remove `neon`, `cluster-nfs`, `nfs-provisioners`). No commit yet — Task 6 commits the schedule that embeds the final list.

Expected: Task 6's namespace list is now final and matches the residency gate (Task 1 Step 4).

> **RESOLVED 2026-06-02 (controller):** Task 1's residency gate revealed 6 of the 11 originally-considered namespaces are *mixed* (have cloud-resident stateful pods that cannot reach `.109`). User chose **clean on-node namespaces only**. Decisions:
> - **`neon` — EXCLUDE** (mixed: `safekeeper-2`/`neon-cluster-*` on cloud VPS; also has its own WAL-replication durability).
> - **`nfs-provisioners` — EXCLUDE** (mixed: provisioner pods on `vmi2951245`).
> - **`cluster-nfs` — INCLUDE.** `nfs-backing` is a **250Gi iSCSI volume** (`iscsi-local` SC, ASUSTOR LUN) mounted by the `nfs-server` pod on debian-marmoset; it is the aggregate backing store for all `cluster-nfs`-provisioned PVCs. Fully on-node (PVB succeeds), not circular (iSCSI source → Garage), not duplicative in this tier (those PVCs aren't otherwise in scope), and the largest item — giving `.109` a substantial steady workload. Crash-consistent/coarse copy, acceptable for a secondary tier.
> - **Also dropped** (never in the narrowed scope): `default`, `microservices`, `percona-mongodb`, `monitoring`. Their databases remain covered by the existing logical backup jobs (`postgresql-backup`, `mongodb-backup-*`). This makes the spec's `ovms`/`openebs` namespace-drops and the `alertmanager-db` straggler **moot** (those namespaces aren't included). The `csi-s3` skip rule in Task 4 becomes inert-but-harmless (its only target, `triton-models` in `default`, is out of scope).
>
> **FINAL SCOPE:** `qdrant`, `vaultwarden`, `vertex-platform`, `jellyfin`, `cluster-nfs`.

---

## Task 3: Create the `nas-local` BackupStorageLocation manifest

**Files:**
- Create: `k8s/backups/velero-nas-local-bsl.yaml`

- [ ] **Step 1: Write the BSL manifest** `[agent]`

Create `k8s/backups/velero-nas-local-bsl.yaml`:
```yaml
# On-prem Garage backup-ingest BackupStorageLocation.
# S3 endpoint is the Synology USB NIC eth2/.109 (Garage node c2194d82, zone nas2),
# giving on-prem (debian-marmoset) backups a dedicated 2.5GbE ingress path instead of
# round-tripping to the cloud Garage pods via the in-cluster ClusterIP. Reuses the
# existing velero-local bucket (prefix nas-local/) and velero-garage-credentials.
# Does NOT touch the Synology Garage rpc_public_addr (stays 10.0.0.5:3901).
# Owned by the `backups` ArgoCD app.
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: nas-local
  namespace: velero
spec:
  provider: aws
  default: false
  accessMode: ReadWrite
  objectStorage:
    bucket: velero-local
    prefix: nas-local
  credential:
    name: velero-garage-credentials
    key: cloud
  config:
    region: garage
    s3ForcePathStyle: "true"
    s3Url: http://192.168.50.109:3900
```

- [ ] **Step 2: Validate YAML locally** `[agent]`

Run:
```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
kubectl apply --dry-run=client -f k8s/backups/velero-nas-local-bsl.yaml
```
Expected: `backupstoragelocation.velero.io/nas-local created (dry run)`.

- [ ] **Step 3: Commit** `[agent]`

Run:
```bash
git add k8s/backups/velero-nas-local-bsl.yaml
git commit -m "feat(backups): add nas-local BSL → Garage S3 on Synology .109"
```
Expected: commit succeeds.

---

## Task 4: Create the volume opt-out resource policy

Skip the bulk/circular volumes centrally (NFS media + `csi-s3` models). Small SC-colliding stragglers are handled in Task 5 (jellyfin-cache) and consciously accepted (`alertmanager-db`, 2Gi local-path — collides with vaultwarden-data at same SC+size, not worth a cross-repo annotation).

**Files:**
- Create: `k8s/backups/velero-nas-local-volumepolicy.yaml`

- [ ] **Step 1: Write the resource-policy ConfigMap** `[agent]`

Create `k8s/backups/velero-nas-local-volumepolicy.yaml`:
```yaml
# Velero volume resource-policy for the nas-local coarse backup tier.
# Skips large/replaceable/circular volumes so .109 carries data worth protecting,
# not NAS-to-NAS echo. First-match-wins.
#   - nfs:            jellyfin-media-movies/tvshows (2Ti each, NFS-backed by the ASUSTOR)
#   - csi-s3:         triton-models-pvc (50Gi, re-stageable from S3)
# Small stragglers (jellyfin-cache, alertmanager-db) are NOT covered here because their
# storageClass collides with keep-volumes; jellyfin-cache is excluded via pod annotation
# (Task 5); alertmanager-db (2Gi) is accepted.
apiVersion: v1
kind: ConfigMap
metadata:
  name: nas-local-volume-policy
  namespace: velero
data:
  policy.yaml: |
    version: v1
    volumePolicies:
    - conditions:
        nfs: {}
      action:
        type: skip
    - conditions:
        storageClass:
        - csi-s3
      action:
        type: skip
```

- [ ] **Step 2: Validate YAML locally** `[agent]`

Run:
```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
kubectl apply --dry-run=client -f k8s/backups/velero-nas-local-volumepolicy.yaml
```
Expected: `configmap/nas-local-volume-policy created (dry run)`.

- [ ] **Step 3: Commit** `[agent]`

Run:
```bash
git add k8s/backups/velero-nas-local-volumepolicy.yaml
git commit -m "feat(backups): nas-local volume policy — skip NFS media + csi-s3 models"
```
Expected: commit succeeds.

---

## Task 5: Exclude jellyfin-cache via pod annotation

`jellyfin-cache` (sc `openebs-lvmpv`, 10Gi) collides with `grafana-data` on storageClass, so it can't be skipped centrally. jellyfin is in this repo — annotate its pod. Also belt-and-suspenders excludes the media volumes by name (the NFS policy already covers them).

**Files:**
- Modify: `k8s/jellyfin/deployment.yaml` (pod template `metadata.annotations`)

- [ ] **Step 1: Read the current pod template annotations** `[agent]`

Run:
```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
grep -n "template:\|annotations:\|spec:" k8s/jellyfin/deployment.yaml | head
```
Expected: locate `spec.template.metadata` (add an `annotations:` block there if absent).

- [ ] **Step 2: Add the backup-volumes-excludes annotation** `[agent]`

In `k8s/jellyfin/deployment.yaml`, under `spec.template.metadata.annotations:`, add:
```yaml
        backup.velero.io/backup-volumes-excludes: cache,media-movies,media-tvshows
```
(The volume names — `cache`, `media-movies`, `media-tvshows` — are the pod `volumes[].name`, confirmed live. Keep `config` backed up.)

- [ ] **Step 3: Validate the manifest renders** `[agent]`

Run:
```bash
kubectl apply --dry-run=client -f k8s/jellyfin/deployment.yaml >/dev/null && echo OK
```
Expected: `OK`.

- [ ] **Step 4: Commit** `[agent]`

Run:
```bash
git add k8s/jellyfin/deployment.yaml
git commit -m "chore(jellyfin): exclude cache+media volumes from velero fs-backup"
```
Expected: commit succeeds.

---

## Task 6: Create the `daily-backup-nas-local` Schedule (initially paused)

Clean on-node scope only (Task 2 resolution), FS-backup on, resource-policy referenced, paused until the manual verification backup (Task 8) passes.

**Files:**
- Create: `k8s/backups/velero-daily-nas-local-schedule.yaml`

- [ ] **Step 1: Write the Schedule manifest** `[agent]`

Create `k8s/backups/velero-daily-nas-local-schedule.yaml` (namespace list is the FINAL scope from Task 2 — only fully-debian-marmoset-resident namespaces, so every PVB succeeds; mixed namespaces with cloud-resident pods are deliberately excluded):
```yaml
# Daily on-prem coarse-DR backup → nas-local BSL (Garage S3 on Synology .109).
# Scope: ONLY fully-debian-marmoset-resident namespaces (residency-gated in plan Task 1;
# scope narrowed in Task 2 after the gate found 6 mixed namespaces with cloud-resident
# pods that cannot reach .109). Volume opt-outs via nas-local-volume-policy (NFS media)
# + jellyfin pod annotation (cache). Databases (cnpg/mongodb in the excluded mixed
# namespaces) stay covered by the existing logical backup jobs.
# Starts paused; enabled in plan Task 9 after a manual verification backup passes.
# Owned by the `backups` ArgoCD app.
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-backup-nas-local
  namespace: velero
spec:
  schedule: "30 2 * * *"
  paused: true
  skipImmediately: true
  useOwnerReferencesInBackup: false
  template:
    storageLocation: nas-local
    defaultVolumesToFsBackup: true
    ttl: 720h
    resourcePolicy:
      refType: configmap
      name: nas-local-volume-policy
    includedNamespaces:
      - qdrant
      - vaultwarden
      - vertex-platform
      - jellyfin
      - cluster-nfs
```

- [ ] **Step 2: Validate YAML locally** `[agent]`

Run:
```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
kubectl apply --dry-run=client -f k8s/backups/velero-daily-nas-local-schedule.yaml
```
Expected: `schedule.velero.io/daily-backup-nas-local created (dry run)`.

- [ ] **Step 3: Commit** `[agent]`

Run:
```bash
git add k8s/backups/velero-daily-nas-local-schedule.yaml
git commit -m "feat(backups): daily-backup-nas-local schedule (paused) via Synology .109"
```
Expected: commit succeeds.

---

## Task 7: Push, sync ArgoCD, verify BSL Available

**Files:** none.

- [ ] **Step 1: Push the branch** `[agent]`

Run:
```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git push -u origin infra/asustor-garage-rpc-usb-nic
```
Expected: push succeeds. (If the `backups` app tracks `main`, open/merge a PR first or temporarily point the app at this branch per your normal flow; confirm before syncing.)

- [ ] **Step 2: Sync the `backups` ArgoCD app** `[agent]`

Run:
```bash
kubectl get application -n argocd backups -o jsonpath='{.spec.syncPolicy}{"\n"}'   # auto vs manual
argocd app sync backups 2>/dev/null || kubectl -n argocd annotate app backups argocd.argoproj.io/refresh=hard --overwrite
```
Expected: app reaches `Synced`; the three new objects (`nas-local` BSL, `nas-local-volume-policy` CM, `daily-backup-nas-local` Schedule) appear.

- [ ] **Step 3: Verify the BSL validates as Available** `[agent]`

Run:
```bash
kubectl get bsl -n velero nas-local -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,LASTVALID:.status.lastValidationTime'
```
Expected: `PHASE = Available` (validated from the velero server pod on debian-marmoset reaching .109). If `Unavailable`, check `kubectl describe bsl -n velero nas-local` — most likely the credential key or the .109 reachability; do not proceed to Task 8 until Available.

---

## Task 8: Manual verification backup + traffic proof

Prove one backup writes through .109 and that bytes actually traverse `eth2`.

**Files:** none.

- [ ] **Step 1: Snapshot eth2 counters immediately before** `[agent]`

Run:
```bash
ssh -o BatchMode=yes maxjeffwell@192.168.50.109 \
  'echo "PRE rx=$(cat /sys/class/net/eth2/statistics/rx_bytes) tx=$(cat /sys/class/net/eth2/statistics/tx_bytes) $(date)"'
```
Expected: a PRE rx/tx line. Note the rx value (ingress is what should climb).

- [ ] **Step 2: Run a scoped verification backup to nas-local** `[agent]`

Run (vaultwarden = small, debian-marmoset-resident, real data):
```bash
kubectl exec -n velero deploy/velero -c velero -- /velero backup create verify-nas-109-$(date +%H%M%S) \
  --storage-location nas-local --include-namespaces vaultwarden --default-volumes-to-fs-backup --wait
```
Expected: backup phase `Completed` (not PartiallyFailed). If it fails, read logs: `kubectl exec -n velero deploy/velero -c velero -- /velero backup logs <name>`.

- [ ] **Step 3: Confirm eth2 ingress climbed** `[agent]`

Run:
```bash
ssh -o BatchMode=yes maxjeffwell@192.168.50.109 \
  'echo "POST rx=$(cat /sys/class/net/eth2/statistics/rx_bytes) tx=$(cat /sys/class/net/eth2/statistics/tx_bytes) $(date)"'
```
Expected: POST `rx` exceeds PRE `rx` by roughly the vaultwarden data size (tens of MB) — the proof `.109` carried the backup ingress. If rx did not move, the data took another path (e.g. BSL endpoint not actually .109) — investigate before enabling the schedule.

- [ ] **Step 4: Confirm objects landed under the nas-local prefix** `[agent]`

Run:
```bash
GPOD=$(kubectl get pods -n monitoring -o name | grep garage | head -1)
kubectl exec -n monitoring "${GPOD##*/}" -c garage -- /garage bucket info velero-local 2>/dev/null | head
kubectl get backup -n velero -o custom-columns='NAME:.metadata.name,BSL:.spec.storageLocation,PHASE:.status.phase' | grep verify-nas-109
```
Expected: the `verify-nas-109-*` backup shows `BSL=nas-local PHASE=Completed`; bucket shows non-zero objects.

---

## Task 9: Enable the schedule + regression check

**Files:**
- Modify: `k8s/backups/velero-daily-nas-local-schedule.yaml`

- [ ] **Step 1: Unpause the schedule in Git** `[agent]`

In `k8s/backups/velero-daily-nas-local-schedule.yaml`, change:
```yaml
  paused: true
```
to:
```yaml
  paused: false
```
(Leave `skipImmediately: true` so it waits for the next cron tick rather than firing on apply.)

- [ ] **Step 2: Commit + sync** `[agent]`

Run:
```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add k8s/backups/velero-daily-nas-local-schedule.yaml
git commit -m "feat(backups): enable daily-backup-nas-local after verification"
git push
argocd app sync backups 2>/dev/null || kubectl -n argocd annotate app backups argocd.argoproj.io/refresh=hard --overwrite
kubectl get schedule -n velero daily-backup-nas-local -o jsonpath='{.spec.paused}{"\n"}'
```
Expected: `false` (enabled).

- [ ] **Step 3: Trigger one full scheduled-scope run + verify** `[agent]`

Run:
```bash
kubectl exec -n velero deploy/velero -c velero -- /velero backup create nas-local-firstrun-$(date +%H%M) \
  --from-schedule daily-backup-nas-local --wait
kubectl get backup -n velero nas-local-firstrun-* -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,ERRORS:.status.errors,WARN:.status.warnings'
```
Expected: `Completed` (or `PartiallyFailed` only with warnings unrelated to .109 reachability — inspect any errors). Confirm the NFS media + csi-s3 volumes were skipped: `kubectl exec -n velero deploy/velero -c velero -- /velero backup describe nas-local-firstrun-* --details | grep -iE "skipped|fs-backup"`.

- [ ] **Step 4: Regression check — existing flows unaffected** `[agent]`

Run:
```bash
kubectl get bsl -n velero -o custom-columns='NAME:.metadata.name,PHASE:.status.phase'
kubectl get backup -n velero --sort-by=.metadata.creationTimestamp | tail -6
```
Expected: `default`/`local`/`backblaze` BSLs still `Available`; no *new* failure mode introduced on their backups attributable to this change (pre-existing PartiallyFailed are tracked by the Velero stabilization effort, not regressions here).

---

## Task 10: Record outcome + memory

**Files:**
- Modify: `docs/superpowers/specs/2026-06-02-synology-garage-backup-ingest-nic-design.md` (resolve Open Items)

- [ ] **Step 1: Resolve the spec's Open Items** `[agent]`

Append to the spec's §9 the resolved facts: final `includedNamespaces` list, the neon / NFS-backing keep-or-exclude decision (Task 2), confirmation velero ns is not default-deny, and the `alertmanager-db` acceptance rationale. Then:
```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add docs/superpowers/specs/2026-06-02-synology-garage-backup-ingest-nic-design.md
git commit -m "docs: record resolved open items for Synology .109 backup-ingest"
git push
```
Expected: commit + push succeed.

- [ ] **Step 2: Write a memory entry** `[agent]`

Add a `project` memory capturing: `nas-local` BSL → Garage S3 on Synology `.109`, the `velero-local`/`nas-local` prefix, the volume opt-out (NFS media + csi-s3 + ovms/openebs ns drops + jellyfin-cache annotation + alertmanager-db accepted), and that the Synology Garage `rpc_public_addr` was intentionally **left** at `10.0.0.5` (wg0) — unlike the ASUSTOR `.149` RPC repoint — because the Synology wg0 doesn't SNAT to cloud peers. Link `[[project-velero-stabilization-2026-05-30]]`. Add the one-line pointer to `MEMORY.md`.

Expected: memory file written + MEMORY.md updated.

---

## Rollback (any time)

All additive — delete the objects (or revert the commits and let ArgoCD prune):
```bash
kubectl delete schedule -n velero daily-backup-nas-local
kubectl delete bsl -n velero nas-local
kubectl delete configmap -n velero nas-local-volume-policy
# jellyfin annotation revert (optional): git revert the Task 5 commit
```
No existing BSL, schedule, NetworkPolicy, or Garage node config was changed, so there is nothing else to restore. The Synology Garage node remains at `10.0.0.5:3901` throughout.
