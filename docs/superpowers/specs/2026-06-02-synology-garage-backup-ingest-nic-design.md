# Dedicate Synology USB NIC (.109) to Garage Backup-Ingest — Design Spec

**Date:** 2026-06-02
**Status:** Approved (design); pending implementation plan
**Branch:** `infra/asustor-garage-rpc-usb-nic` (shared with the sibling ASUSTOR `.149` effort)
**Host of record:** Synology DS423 `boom_boom` (Garage node `c2194d82e4ed754a`, zone `nas2`, 1.4 TB)
**Apply target:** GitOps — new manifests under `k8s/backups/` in this repo, reconciled by the `backups` ArgoCD app. **No NAS-side change** (unlike the ASUSTOR effort, the Synology Garage node config is not touched).

---

## 1. Problem Statement

The Synology DS423 has three relevant interfaces:

| NIC | IP | Bus / driver | Role today | Lifetime traffic |
|-----|----|--------------|-----------|------------------|
| `bond0` (eth0+eth1) | .129 | onboard 1GbE ×2 (LACP) | NFS / iSCSI / SMB / DSM — the hot path | **RX 7.0 TB / TX 1.7 TB** |
| `wg0` | 10.0.0.5 | WireGuard overlay | **Garage `rpc_public_addr` (advertised)** | — |
| **`eth2`** | **.109** | **USB / `r8152` (RTL8156, 2.5 GbE)** | nominal "on-prem NFS PV" convention; effectively idle | **RX 82 GB / TX 43 GB (~1% of bond0)** |

`eth2`/.109 is a spare 2.5 GbE NIC carrying ~1% of `bond0`'s traffic. The goal is to give it a genuine, steady workload as a **dedicated on-prem Garage-backup ingest path**.

**Why ingest, not RPC (the key divergence from the ASUSTOR `.149` effort):** The Synology Garage node advertises `rpc_public_addr = 10.0.0.5:3901` — the **wg0 overlay** address. So *all* inter-node replication to/from the Synology already rides WireGuard, including from LAN peers. The ASUSTOR-style "repoint `rpc_public_addr` to the USB NIC" lever is **unsafe here**: the Synology's wg0 endpoint does not SNAT return traffic and `.109` is not verified reachable from the cloud peers (`vmi2951245`/`vmi3115606`), so advertising `.109` risks stranding the cloud peers and breaking RF=2 quorum for zone `nas2` from the cloud side. (Contrast: the ASUSTOR advertises a LAN address and `.149` was verified OPEN from cloud over wg0.)

The safe lever is therefore the **S3 client ingress path**. Today both Garage BSLs point at `http://garage.monitoring.svc.cluster.local:3900` — an in-cluster ClusterIP that fronts **only the two cloud Garage pods** (`100.64.0.1`, `100.64.0.2`). An on-prem backup from `debian-marmoset` thus round-trips its data to a **cloud** coordinator and replicates back — a cross-internet hop for LAN-resident data. Pointing on-prem backup ingest at the Synology's S3 endpoint on `.109:3900` keeps the coordinator **on-prem** *and* gives `.109` real work.

## 2. Goals / Non-Goals

**Goals:**
- Route on-prem (debian-marmoset-resident) Velero backup ingress through a dedicated on-prem Garage S3 endpoint on `eth2`/.109.
- Do so **additively** — no change to the existing `default`/`local`/`backblaze` BSLs or their schedules (all currently fragile per the Velero stabilization effort), and no change to any Garage node config.
- Give `.109` a substantial recurring workload: a broad daily backup of all debian-marmoset-resident stateful namespaces, minus volumes not worth a coarse FS copy.

**Non-Goals (explicit):**
- Changing the Synology Garage node's `rpc_public_addr` (stays `10.0.0.5:3901`) — inter-node replication and cloud-peer reachability are untouched.
- Changing how the **cloud** node-agents or `backrest` (on cloud `vmi3115606`) reach Garage — they keep using `garage.monitoring.svc:3900`.
- Split-horizon DNS on a shared BSL endpoint (rejected — more moving parts; a dedicated additive BSL is cleaner and reversible).
- Touching the Garage layout, replication factor, zones, or buckets (the new BSL **reuses** the existing `velero-local` bucket + credentials).
- Being the primary backup of record for the databases — the repo's existing **logical** backup jobs (`postgresql-backup`, `mongodb-backup-microservices`, `mongodb-backup-vertex-platform`) remain the consistent DB backups. This `.109` path is a **coarse, whole-namespace secondary DR tier**.

## 3. Architecture & Data Flow

Single lever: a new on-prem-only BSL whose S3 endpoint is `.109`, consumed by a new on-prem-scoped schedule whose PVB data movers run on `debian-marmoset`.

```
Before:  debian-marmoset node-agent ──S3──> garage.monitoring.svc:3900 ──> CLOUD pod (coordinator) ──repl──> back to NAS/on-prem
After:   debian-marmoset node-agent ──S3──> 192.168.50.109:3900 ─────────> Synology (coordinator, on eth2/USB)
                                                                              └─ RF=2 cross-zone replication ──wg0──> other Garage nodes
Unchanged: cloud node-agents / backrest ──> garage.monitoring.svc:3900 (cloud pods)
```

Backup **ingress** (the heavy PUT bodies) lands on `.109`; cross-zone **replication** still rides wg0 — correct, because that is inter-node traffic and outside the scope of the dedicated client NIC. Garage already binds all interfaces (`:::3900` confirmed listening on the Synology), so no NAS-side change is required.

**Peer/path facts (verified 2026-06-02):**
- Only one on-prem Velero node-agent exists: `debian-marmoset`. The other two (`vmi2951245`, `vmi3115606`) are cloud and cannot reach `.109` — they are naturally excluded by node residency.
- The Velero **server** pod runs on `debian-marmoset` → BSL validation and metadata upload to `.109` succeed.
- `debian-marmoset` reaches `.109:3900` over LAN (`http=403` Garage-anonymous-denied, ~0.13 s).

## 4. Components (all additive; `k8s/backups/`, `backups` ArgoCD app)

1. **`BackupStorageLocation` `nas-local`** — mirrors the existing `local` BSL exactly, except:
   - `config.s3Url: http://192.168.50.109:3900`
   - `objectStorage.bucket: velero-local` **+ `prefix: nas-local`** (reuses the existing bucket + grant; the prefix isolates it from `local`, which writes to the bucket root)
   - `credential: { name: velero-garage-credentials, key: cloud }` (same as `default`/`local`)
   - `config: { region: garage, s3ForcePathStyle: "true" }`, `provider: aws`, `accessMode: ReadWrite`, `default: false`

2. **`Schedule` `daily-backup-nas-local`** — modeled on `velero-weekly-offsite.yaml` (allowlist style):
   - `storageLocation: nas-local`, `defaultVolumesToFsBackup: true`, `ttl: 720h`
   - `includedNamespaces`: the debian-marmoset-resident stateful namespaces (final list resolved in plan pre-flight residency check)
   - `resourcePolicy` (ConfigMap ref) implementing the §5 volume opt-out
   - Created paused / or with first run gated until a manual verification backup passes (§6)

3. **Volume opt-out resource policy** — a Velero resource-policies `ConfigMap` referenced by the schedule, `skip`ping volumes by `volumeTypes: [nfs]` (catches NFS-backed media) and/or a capacity threshold (catches large replaceable model blobs). Per-pod `backup.velero.io/backup-volumes-excludes` annotations are the fallback only if the resource policy can't express a case. Exact policy finalized in plan pre-flight after enumerating each volume's type + size.

4. **NetworkPolicy verification/patch** — confirm the velero-ns `node-agent` and `velero` server pods may egress to `192.168.50.109:3900`. The existing `allow-backup-jobs-egress-netpol.yaml` covers the custom backup *jobs*; node-agent/server egress to LAN `.109` must be confirmed and, if velero-ns is default-deny, an explicit egress rule added.

## 5. Volume Policy (Keep vs Exclude)

Broad namespace scope, but FS-data backup is opt-out for volumes that are large+replaceable, circular, or unsafe to restore from a flat copy. Rationale: a Velero FS PVB of a running DB is only crash-consistent (logical backups already cover those), so bulky/replaceable/already-elsewhere volumes are pure cost in this tier.

**Keep (real data worth a coarse copy):**
- `vaultwarden`: `vaultwarden-data`, `cnpg-vaultwarden-1` (highest value — credentials)
- `microservices/mongodb`; `percona-mongodb/*` (intervalai, educationelly, educationelly-graphql)
- `qdrant/storage-qdrant-0`
- `default`: `cnpg-auth-1`, `cnpg-bookmarked-1`, `cnpg-codetalk-1`, `cnpg-lunary-1`
- `monitoring`: `grafana-data`, `gotify-democratic-mp`
- `vertex-platform`: `influxdb-config/data-democratic-mp`, `mongodb-democratic-mp`
- `jellyfin/jellyfin-config-mayastor` (watch state/config — small)

**Exclude from FS-data (resource definition still captured):**
- Replaceable blobs: `jellyfin-media-movies`, `jellyfin-media-tvshows` (NFS-backed, circular, TBs), `triton-models-pvc`, `ovms/ovms-models`, `jellyfin/jellyfin-cache`
- Unsafe-to-FS-restore control plane: `openebs/data-mayastor-etcd-0`
- Ephemeral: `monitoring/alertmanager-…-db`

**Deferred to plan pre-flight (decide after verifying size/contents):**
- `neon/*` (pageserver/safekeeper/broker) — large, own WAL-replication durability; lean exclude bulk
- `cluster-nfs/nfs-backing`, `nfs-provisioners/pvc-cluster-nfs-provisioner-…` — may duplicate per-namespace data or be the sole copy of subdir-provisioned PVCs; trace contents first

## 6. Validation / Success Criteria

- `nas-local` BSL reaches `Available` (validated from the velero server pod on debian-marmoset).
- One manual `velero backup create verify-nas-109-<ts> --storage-location nas-local --include-namespaces <one on-prem ns> --wait` → `Completed`.
- **Traffic moved:** sample Synology `eth2` rx/tx counters (`/sys/class/net/eth2/statistics/*`) before/after the backup — `eth2` climbs substantially under load while `bond0`'s Garage share does not. This is the proof `.109` is doing the work.
- No new `PartiallyFailed` on the existing `default`/`local`/`backblaze` flows attributable to the change.

## 7. Rollback

Fully reversible because additive: `kubectl delete schedule daily-backup-nas-local` + delete the `nas-local` BSL and the resource-policy ConfigMap (or revert the Git commit and let ArgoCD prune). No existing BSL, schedule, NetworkPolicy, or Garage node config is mutated, so there is nothing to restore.

## 8. Risks

| Risk | Mitigation |
|------|------------|
| A cloud-resident PVB lands in the schedule's scope → fails reaching `.109` | Plan pre-flight verifies every in-scope PVC-bearing pod is debian-marmoset-resident; exclude any that are not. node-residency, not just namespace, is the gate. |
| velero-ns default-deny NetworkPolicy blocks node-agent/server egress to `.109` | Verify in pre-flight; add an explicit egress rule alongside `allow-backup-jobs-egress-netpol.yaml` if needed. |
| New schedule adds load to an already-fragile Velero pipeline | `nas-local` is fully isolated (own BSL + prefix + policy); gate first run behind a passing manual verification backup; does not perturb existing flows. |
| Circular NAS→Garage(NAS) media backup bloats the bucket | §5 volume opt-out skips NFS-backed media and large replaceable blobs. |
| Two BSLs share bucket `velero-local` | `local` writes to bucket root, `nas-local` to `velero-local/nas-local/` (prefix) — no overlap; mirrors the `prefix: velero` isolation already used for backblaze. |
| Synology `eth2` is a USB NIC (RTL8156) — possible re-enumeration (cf. ASUSTOR diagnosis) | Garage S3/kopia is reconnect-tolerant; a rare brief blip retries. Capture eth2 link/reset baseline in pre-flight; this path is a secondary tier, not the only backup. |

## 9. Open Items (resolve during implementation)

- Final `includedNamespaces` list after the per-namespace **node-residency** check on debian-marmoset.
- Exact volume opt-out mechanism: resource-policy ConfigMap by `volumeTypes: [nfs]` + capacity threshold vs. targeted pod annotations — chosen after enumerating each in-scope volume's type and size.
- `neon/*` and the NFS-backing PVCs: keep or exclude (see §5 deferred).
- Whether velero-ns is default-deny and a node-agent/server egress rule to `192.168.50.109:3900` is required.
- Confirm the `velero-garage-credentials` key has access to write the `nas-local/` prefix in `velero-local` (same key already writes the bucket root, so expected).
- Synology `eth2` reset/link baseline (driver `r8152`, RTL8156) captured for the record.
