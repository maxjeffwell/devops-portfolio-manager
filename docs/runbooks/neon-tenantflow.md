# Neon (self-hosted) for tenantflow branching

This is the operational record for the self-hosted Neon deployment that
backs tenantflow's per-tenant database branching. Last incident-driven
rewrite: 2026-05-17.

> **Why this doc exists**: the previous self-hosted Neon installation was
> removed and the reason wasn't documented. When we rebuilt it months
> later, we ended up making the same gap-named decisions all over again.
> If you're considering removing Neon, **add a paragraph at the bottom
> of this file explaining why** before you delete anything.

## TL;DR

- **Where**: KubeBlocks Cluster `tenantflow-neon` in the `neon` namespace.
- **Backed by**: 1× broker, 3× safekeeper (openebs-lvmpv), 1× pageserver
  on Mayastor (NVMe-oF/TCP).
- **Branching API**: HTTP at
  `http://tenantflow-neon-neon-pageserver-headless.neon.svc.cluster.local:9898`.
- **IaC**: `portfolio-orchestration-platform/k8s/databases/`
  - `neon-namespace.yaml`
  - `tenantflow-neon-cluster.yaml`
  - **Not under ArgoCD** — apply manually with `kubectl apply -f` after
    editing.

## Architecture

```
                              ┌─────────────────────────┐
                              │ tenantflow backend (Node)│
                              │  neonService.js          │
                              └────────────┬─────────────┘
                                           │ HTTP /v1/tenant, /v1/timeline
                                           ▼
                              ┌─────────────────────────┐
                              │ pageserver (1 replica)  │
                              │ port 9898 (HTTP API)    │
                              │ port 6400 (compute gRPC)│
                              │ PV: mayastor-1 (25 GiB) │
                              │ NVMe-oF/TCP transport   │
                              └────────────┬────────────┘
                                  ▲ pg_repl      │ layer files
                                  │              ▼
                              ┌─────────────────────────┐
                              │ safekeeper × 3          │
                              │ ports 5454, 7676        │
                              │ PV: openebs-lvmpv 10Gi  │
                              │ (1 on vmi2951245,       │
                              │  2 on debian-marmoset)  │
                              └────────────┬────────────┘
                                           │ discovery
                                           ▼
                              ┌─────────────────────────┐
                              │ storage broker (1)      │
                              │ port 50051 (gRPC)       │
                              │ PV: openebs-lvmpv 5Gi   │
                              └─────────────────────────┘
```

**Compute nodes** are **not** part of the Cluster CR. They're provisioned
per-branch by tenantflow (currently TODO — see "Open gaps" below). Each
compute pod talks to the pageserver and safekeepers via cluster DNS.

## Why these choices

| Choice | Why |
|---|---|
| Self-hosted, not Neon Cloud | The previous Vercel-managed Neon was removed (reason lost). Replaced with KubeBlocks Neon addon, which the cluster already has installed (40d-old `neon` ClusterDefinition). |
| Pageserver on Mayastor (NVMe-oF/TCP) | Pageserver does hot page reads when branches access old LSNs. Mayastor's NVMe-oF transport beats iSCSI on latency. Mayastor's single-replica pool on debian-marmoset (30 GiB) sized to fit a 25 GiB request. |
| Safekeepers on openebs-lvmpv | WAL durability needs a separate failure domain from the pageserver. Local LVM is simple and fast; per-replica PV is required for quorum semantics. |
| `terminationPolicy: Delete` | Initial deployment posture. Flip to `DoNotTerminate` once branches hold real tenant data and accidental deletion would be a real loss. v1 API removed `Halt`. |
| `preferred` (not `required`) safekeeper anti-affinity | `required` deadlocks: existing safekeeper PVCs are node-pinned by openebs-lvmpv, and required anti-affinity then forbids those same nodes. `preferred` lets the scheduler spread when possible and fall back to co-location otherwise. |

## Operating

### Confirm the cluster is healthy

```bash
kubectl get cluster -n neon tenantflow-neon
# expect: STATUS=Running

kubectl get pods -n neon
# expect: broker (1/1), safekeeper-0/1/2 (1/1), pageserver (1/1)

# pageserver health
kubectl exec -n neon tenantflow-neon-neon-pageserver-0 -- \
  curl -sS http://localhost:9898/v1/status
# expect: {"id":1}
```

### Branch lifecycle (the actual API)

```bash
PAGESERVER=http://tenantflow-neon-neon-pageserver-headless.neon.svc.cluster.local:9898

# Create a tenant (returns bare quoted UUID)
TENANT_ID=$(kubectl exec -n neon deploy/some-pod -- \
  curl -sS -X POST -H "Content-Type: application/json" -d '{}' \
  $PAGESERVER/v1/tenant/ | tr -d '"')

# Create the main timeline
kubectl exec -n neon deploy/some-pod -- \
  curl -sS -X POST -H "Content-Type: application/json" \
  -d "{\"tenant_id\":\"$TENANT_ID\",\"pg_version\":14}" \
  $PAGESERVER/v1/tenant/$TENANT_ID/timeline/

# Create a branch (ancestor_timeline_id makes it a branch, not a new timeline)
kubectl exec -n neon deploy/some-pod -- \
  curl -sS -X POST -H "Content-Type: application/json" \
  -d "{\"tenant_id\":\"$TENANT_ID\",\"pg_version\":14,\"ancestor_timeline_id\":\"$MAIN_TIMELINE_ID\"}" \
  $PAGESERVER/v1/tenant/$TENANT_ID/timeline/

# List timelines for a tenant
kubectl exec -n neon deploy/some-pod -- \
  curl -sS $PAGESERVER/v1/tenant/$TENANT_ID/timeline/

# Delete a timeline (branch)
kubectl exec -n neon deploy/some-pod -- \
  curl -sS -X DELETE $PAGESERVER/v1/tenant/$TENANT_ID/timeline/$TIMELINE_ID
```

The tenantflow backend's `neonService.js` wraps all of this and persists
the `tenantName → (tenant_id, timeline_id)` mapping in the
`tenantflow-neon-tenant-map` ConfigMap in the `neon` namespace.

### Inspect the tenant mapping

```bash
kubectl get cm tenantflow-neon-tenant-map -n neon -o yaml
# each .data[<tenantName>] is JSON: {tenantId, timelineId, createdAt}
```

### Fully spread the safekeepers (currently 2 of 3 on debian-marmoset)

The remaining co-location is from the initial deployment — both -0 and
-1's openebs-lvmpv PVs are pinned to debian-marmoset. To migrate one of
them off:

```bash
# Pick one safekeeper to roll (start with the LAST one to lose its data
# last; KubeBlocks rolls high-to-low ordinal automatically)
kubectl delete pvc neon-safekeeper-tenantflow-neon-neon-safekeeper-1 -n neon --grace-period=0 --force
kubectl delete pod tenantflow-neon-neon-safekeeper-1 -n neon --grace-period=0 --force

# KubeBlocks recreates the PVC, scheduler picks a node respecting
# `preferred` anti-affinity (preferring a different node than -0 and -2).
# The new safekeeper resyncs WAL from the existing quorum.

# Wait Ready before doing -0 (otherwise you lose quorum)
kubectl wait pod/tenantflow-neon-neon-safekeeper-1 -n neon --for=condition=Ready --timeout=300s
```

**Don't ever delete more than 1 safekeeper at a time** — losing 2 of 3
breaks quorum and the cluster will be unwritable until one returns.

## Tenantflow integration

The Node.js backend at `k8s-multi-tenant-platform/backend/src/services/neonService.js`
calls the pageserver via:

```js
// On tenant create
const branchInfo = await neonService.createTenantBranch(tenantName);
// branchInfo: { tenantId, timelineId, branchId, branchName,
//               pageserverHost, safekeeperHosts, connectionString: null }

// On tenant delete
await neonService.deleteTenantBranch(tenantName);
```

Required env on the backend pod:

```
PAGESERVER_URL=http://tenantflow-neon-neon-pageserver-headless.neon.svc.cluster.local:9898
NEON_NAMESPACE=neon            # optional, defaults to 'neon'
NEON_PG_VERSION=14             # optional, defaults to 14
```

The backend pod's ServiceAccount needs permission to read/write the
`tenantflow-neon-tenant-map` ConfigMap in the `neon` namespace
(verbs: get, create, update).

## Compute pod provisioning (implemented, gotchas catalogued)

`k8sService.provisionNeonCompute()` creates the four-resource bundle
per branch:

| Resource | Name | Purpose |
|---|---|---|
| Secret | `<computeName>-creds` | 24-byte random plaintext password |
| ConfigMap | `<computeName>-spec` | spec.json with tenant_id, timeline_id, safekeeper list, pageserver connstring, MD5 password hash, PG settings |
| Deployment | `<computeName>` | 1 replica, image `perconalab/neon:pg14-1.0.0`, `runAsUser: 0` |
| Service | `<computeName>` | ClusterIP, port 55432 |

`computeName` convention: `compute-<tenantNamespace>`. So tenant
namespace `tenant-foo` gets compute pod `compute-tenant-foo` exposing
`compute-tenant-foo.neon.svc.cluster.local:55432`.

**Gotchas baked into the implementation** (all discovered during the
2026-05-17 smoketest; if any of these break in the future, the issue
is probably here):

1. **Hash format** — `encrypted_password` in spec.json must be
   `MD5(password + username)`, NOT `MD5(password)` as the addon
   README example suggests. The addon's example is broken; using
   it directly produces an unconnectable role.

2. **Binary paths** — `compute_ctl` lives at
   `/opt/neondatabase-neon/target/release/compute_ctl`, NOT
   `/usr/local/bin/compute_ctl`. Postgres binary is at
   `/opt/neondatabase-neon/pg_install/v14/bin/postgres`. The README
   uses the wrong paths.

3. **Unix socket** — set `unix_socket_directories=''` in spec.json
   settings. Without this, Postgres fails to open
   `/tmp/.s.PGSQL.55432.lock` even though `/tmp` is 1777 — possibly
   an image-specific issue. Skipping unix sockets is fine because
   clients always connect via the K8s Service (TCP).

4. **runAsUser: 0** — required so the wrapper script can chown
   `/data` to `postgres:postgres`. `compute_ctl` then drops to
   the postgres user via `su -` internally for the actual Postgres
   process.

5. **Per-branch passwords** — random 24-byte hex, stored as plain
   text in the per-branch Secret. The compute reads the MD5-hashed
   form from spec.json. Cross-tenant connections fail because each
   tenant has its own password.

### Compute lifecycle calls

In `k8sService.js` near the `createTenantBranch` call site:
```js
const branchInfo = await neonService.createTenantBranch(namespace);
const compute = await this.provisionNeonCompute({
  tenantId: branchInfo.tenantId,
  timelineId: branchInfo.timelineId,
  computeName: `compute-${namespace}`,
});
// compute.connectionString is now a usable Postgres URL
```

In `tenantController.js` during tenant delete:
```js
await k8sService.tearDownNeonCompute({ computeName: `compute-${tenantName}` });
await neonService.deleteTenantBranch(tenantName);
// Order matters: delete compute first (compute_ctl needs the timeline);
// then delete the timeline; then the mapping ConfigMap entry.
```

## Open gaps (a.k.a. TODO list)

1. **HA for pageserver** — currently 1 replica. Pageserver isn't itself
   HA-shaped (it's a single-writer for layer files), but it is the
   biggest SPOF in the system. Either accept this (data is recoverable
   from the PV) or migrate to a layered-blob pattern with S3 backing.

2. **HA for the broker** — 1 replica. Discovery only; safekeepers and
   compute will retry, so a brief broker outage isn't fatal, but worth
   bumping to 2+ once the rest is stable.

3. **Safekeeper full spread** — 2 of 3 still on debian-marmoset. See
   migration steps above.

4. **Mayastor pool expansion** — pageserver PV is 25 GiB inside a 30 GiB
   pool on debian-marmoset. Plenty for early use; we'll need to grow
   the `openebs-vg/mayastor-pool` LV before the pageserver runs out.

5. **Backups** — Velero excludes the `neon` namespace by default. Once
   real data lives here, decide on a backup policy (likely: snapshot
   the pageserver PV via the Mayastor CSI snapshot path, or set up
   layer-file replication to Garage S3).

6. **Authentication** — pageserver HTTP API has no auth in this deploy.
   It's only reachable via in-cluster DNS, so namespace-scoped
   NetworkPolicy enforcement is the security layer. Add a NetworkPolicy
   limiting ingress to the `neon` namespace to specific source pods
   (tenantflow backend, k8s-multi-tenant-platform) before any branch
   holds real PII.

## Related gotchas worth knowing

- **`dm_snapshot` kernel module on debian-marmoset** — required for the
  openebs-lvmpv plugin to create snapshots. Loaded and persisted via
  `/etc/modules-load.d/dm-snapshot.conf` on 2026-05-17. Without it, the
  LVM plugin retry-storms on snapshot creation, slowing legitimate
  lvcreate calls.

- **Old `neon-cluster-*` configmaps in `default` ns** — orphan leftovers
  from the previous installation, cleaned up 2026-05-17 (had to strip
  the `component.kubeblocks.io/finalizer` first because the owning
  Component no longer existed). If they come back, that's a signal
  that the orphan-Component bug isn't fixed in your KubeBlocks version.

- **KubeBlocks v1 API differences from v0.x** —
  - `spec.clusterDefinitionRef` → `spec.clusterDef`
  - `terminationPolicy: Halt` is gone (use `DoNotTerminate` for the
    "protect from deletion" intent)

## Removal procedure

If you're considering removing Neon: **first add a paragraph here
explaining why, then proceed**.

```bash
# Document the decision
$EDITOR docs/runbooks/neon-tenantflow.md   # add a "Removed YYYY-MM-DD because…" section

# Stop new branches from being created
# (Edit tenantflow backend to set NEON_DISABLED=1 or similar gate)

# Drain existing tenant traffic from compute pods (k8s/databases/ side)
# ... per-branch — depends on how compute pods are provisioned

# Tear down the cluster (PVCs go too because terminationPolicy: Delete)
kubectl delete -f portfolio-orchestration-platform/k8s/databases/tenantflow-neon-cluster.yaml

# Tenant mapping ConfigMap (kept for forensics, delete when sure)
kubectl delete cm tenantflow-neon-tenant-map -n neon

# Namespace
kubectl delete ns neon
```
