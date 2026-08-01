# csi-driver-smb Integration Design

**Date:** 2026-08-01
**Status:** Approved, ready for implementation planning

## Goal

Add SMB as a second file protocol to the k3s cluster via `csi-driver-smb`, backed by the
ASUSTOR AS5402T. Three motivations, all of which the design must serve:

1. **Dynamic RWX storage** — a StorageClass that provisions a subdirectory per PVC, comparable
   to the existing `cluster-nfs` subdir provisioner.
2. **Interop** — the same share is reachable identically from pods and from Windows clients.
3. **Redundancy for NFS** — an independent file protocol on an independent box, so an NFS-side
   failure (Ganesha, rpcbind, provisioner leader election) does not take down file storage.

Static PVs pointing at pre-existing shares are explicitly out of scope.

## Environment as verified 2026-08-01

**Cluster:** k3s v1.34.3, four nodes.

| Node | Role | Location | `cifs.ko` | Host `mount.cifs` | Taints |
|---|---|---|---|---|---|
| `vmi2951245` | control-plane | Contabo VPS | yes | no | `control-plane:PreferNoSchedule` |
| `vmi3115606` | worker | Contabo VPS | yes | no | none |
| `marmoset` | GPU | LAN | yes | yes | `workload=gpu:NoSchedule` |
| `debian-marmoset` | worker | LAN | yes | yes | none |

Host `mount.cifs` is **not** a prerequisite. The driver performs the mount inside its own node
container, which ships `cifs-utils`; only the host kernel module matters, since containers share
the host kernel. All four nodes have it.

**Overlay:** Tailscale `100.64.0.0/24` (replaced the former WireGuard `10.0.0.0/24`, which is
dead — `10.0.0.4:445` is unreachable). A Tailscale subnet router advertises `192.168.50.0/24`,
so the Contabo nodes reach `192.168.50.142`, `.149`, and `100.64.0.5` on port 445 directly.

**ASUSTOR AS5402T — corrected network state.** The LACP bond has been dissolved. Three
independent NICs:

| Interface | Address | Notes |
|---|---|---|
| `eth0` | 192.168.50.142 | 2.5G |
| `eth1` | 192.168.50.133 | 2.5G (was a bond0 alias in earlier notes) |
| `eth2` | 192.168.50.149 | 5G USB (r8157), BBR-tuned |

`smb.conf` now reads `interfaces = eth0 eth1 eth2` (the line appears twice with identical
values — harmless, last wins). This supersedes the previously recorded `interfaces = bond0 eth2`
fix and is correct for the current bond-less topology. `server multi channel support = yes` is
present. `bind interfaces only` is unset, so `smbd` listens on `0.0.0.0:445`; the `interfaces`
line governs only which NICs are advertised to multichannel clients, not what accepts
connections.

**Volumes:** `/volume1` 3.6T HDD (2.2T free), `/volume2` 950G SSD (544G free, shared with the
iSCSI LUN store `.@iscsi`).

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Backing server | ASUSTOR AS5402T | Not a cluster node, so no loopback-SMB deadlock risk. Leaves Synology as iSCSI-only, which is what makes this genuine redundancy rather than concentrated risk. |
| Address | `192.168.50.149` (eth2, 5G), cluster-wide | Fastest path. LAN nodes reach it natively; VPS nodes via the Tailscale subnet router. Single StorageClass, no node affinity to maintain. |
| Provisioning root | New share `k8s-smb` on `/volume1` | 2.2T headroom, no contention with the iSCSI LUN store on `/volume2`, and PV subdirectories stay separate from human-facing shares. |
| SMB identity | Existing `maxjeffwell` account | Consistent with the one-credential-everywhere approach already in place across both NAS boxes and `debian-marmoset`. |
| Install method | Two ArgoCD Applications | Matches the existing `node-problem-detector` pattern; keeps upstream chart upgrades independent of local configuration. |
| Chart version | `csi-driver-smb` v1.20.3 | Current release. Compatible with k8s 1.34. |

## Architecture

### Component 1 — Driver installation

`gitops/applications/csi-driver-smb.yaml`, a multi-source ArgoCD Application:

- Source A: chart `csi-driver-smb` v1.20.3 from
  `https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/master/charts`
- Source B: this repo at `main`, `ref: values`, supplying
  `$values/helm-charts/csi-driver-smb/values-override.yaml`
- Destination namespace: `kube-system`
- `syncPolicy.automated` with `prune: true`, `selfHeal: true`, `CreateNamespace=false`

Chart defaults are correct for this cluster and need no toleration overrides:
`linux.tolerations` defaults to `- operator: Exists`, so the node DaemonSet lands on `marmoset`
despite its `workload=gpu:NoSchedule` taint, and the controller already tolerates control-plane
taints. The values override is limited to resource requests/limits and
`feature.enableGetVolumeStats: true` so PV usage is scrapeable by the existing Mimir stack.

A second Application, `csi-driver-smb-resources`, is defined in the same file (as
`node-problem-detector.yaml` does) with `path: k8s/csi-driver-smb`, carrying the ExternalSecret
and StorageClass described below. Same destination namespace and sync policy.

### Component 2 — Credential

An ExternalSecret in `kube-system` against the existing `doppler-secret-store`
ClusterSecretStore, producing Secret `smbcreds` with exactly the keys `username` and `password`.

Requires two new keys in Doppler `portfolio/prd`: `ASUSTOR_SMB_USERNAME` and
`ASUSTOR_SMB_PASSWORD`, set to the existing `maxjeffwell` SMB credential.

One Secret in one namespace serves every consuming namespace, because the StorageClass names the
secret's namespace explicitly. That single Secret is the blast radius: any workload able to
create a PVC against this class obtains a mount with whatever the `maxjeffwell` account can
reach on the ASUSTOR — which is every share on the box. This is an accepted trade-off, not an
oversight.

### Component 3 — StorageClass

`k8s/csi-driver-smb/storageclass.yaml`:

- `provisioner: smb.csi.k8s.io`
- `parameters.source: //192.168.50.149/k8s-smb`
- `csi.storage.k8s.io/provisioner-secret-name: smbcreds`, namespace `kube-system` — its presence
  is what enables dynamic subdirectory-per-PV behaviour
- `csi.storage.k8s.io/node-stage-secret-name: smbcreds`, namespace `kube-system`
- `reclaimPolicy: Retain` — matches every other StorageClass in this cluster except the Mayastor
  ones
- `volumeBindingMode: Immediate`
- `allowVolumeExpansion: true`
- `mountOptions:` — authored by the operator, see below

### Component 4 — ASUSTOR preparation (manual)

Performed in the ADM GUI, consistent with the established preference for GUI-driven changes on
this box:

1. Create shared folder `k8s-smb` on `/volume1`.
2. Grant `maxjeffwell` read/write; no other users.
3. Verify by hand-mounting `//192.168.50.149/k8s-smb` from `marmoset` before pointing the
   cluster at it.

No `smb.conf` edits are required. The share must exist before the StorageClass is applied, or
provisioning fails with `NT_STATUS_BAD_NETWORK_NAME`.

## mountOptions — operator-authored

The `mountOptions` list is deliberately left for the operator to write, because it encodes three
real trade-offs rather than a single obvious default:

- **Inode safety.** The upstream chart's own values file annotates `noserverino` as *required to
  prevent data corruption*. SMB servers can return duplicate inode numbers across a share; a
  client that caches them will alias distinct files onto each other. On a multi-writer RWX share
  this is a correctness question, not a tuning one.
- **Cache mode.** `cache=strict` is faster but assumes this client is the only writer —
  untrue by construction, since interop with Windows clients is an explicit goal. `cache=none`
  is safe and slow.
- **Identity.** SMB has no server-side uid mapping equivalent to NFS. Every file presents as
  whatever `uid=`/`gid=`/`file_mode=`/`dir_mode=` say at mount time, cluster-wide, for every
  pod using the class regardless of its `securityContext`.
- **Multichannel.** The Linux client only uses it when the mount asks
  (`multichannel,max_channels=N`); it never negotiates implicitly. The server will advertise all
  three NICs. On LAN nodes this is a real throughput gain. On the two Contabo nodes all three
  advertised paths funnel through the single Tailscale subnet-router tunnel, so extra channels
  add overhead without bandwidth and introduce two more paths that break if the router node
  drops.

The scaffold will carry this context inline with a TODO at the insertion point.

## Verification

1. Apply a test PVC against `smb-asustor` and a pod that writes a file.
2. Confirm the subdirectory appeared under `/volume1/k8s-smb` on the ASUSTOR, named for the PV.
3. `kubectl exec -n kube-system <csi-smb-node-pod> -c smb -- mount | grep cifs` — the mount is
   visible inside the node container, not necessarily on the host.
4. On the consuming node, `grep -iE "channel|Speed" /proc/fs/cifs/DebugData` to confirm the
   negotiated channel count matches intent.
5. Delete the test PVC; with `reclaimPolicy: Retain` the PV and its data must survive.

## Risks

**`.149` is a single point of failure.** It is one 5G USB NIC (r8157) with a documented history
of driver and offload problems. If `eth2` drops, every SMB PV stalls. Critically, `source` is
copied into each PV's `volumeAttributes` at provision time and is **immutable per-PV** — editing
the StorageClass later does not migrate existing volumes to `.142`. Recovering from a permanent
`eth2` loss means recreating PVs, the same immutable-PV problem encountered during earlier PVC
migrations.

**ADM regenerates `smb.conf`.** An ADM update or GUI SMB-settings save can wipe
`server multi channel support = yes` or rewrite the `interfaces` line. Mounts continue working;
multichannel silently degrades to one channel. Invisible without checking `DebugData`, so a
throughput regression should send you to `smb.conf` first.

**The ASUSTOR is a known moving target.** Its docker-restart cron already drops containers on
every reboot. `smbd` is unrelated to that cron, but the box should not be assumed stable across
reboots.

**Blast radius of the shared credential.** Documented under Component 2 and accepted.

## Out of scope

- Static PVs onto existing shares (Movies, TV Shows, Media, Calibre).
- Migrating any existing NFS or iSCSI workload onto SMB.
- A second StorageClass on `.142`/`.133` or over Tailscale.
- Changes to the ASUSTOR's `smb.conf`, network configuration, or existing shares.
