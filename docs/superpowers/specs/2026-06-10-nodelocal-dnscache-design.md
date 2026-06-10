# NodeLocal DNSCache — Design Spec

- **Date:** 2026-06-10
- **Status:** Approved design, pending implementation plan
- **Repos touched:** `devops-portfolio-manager` (Phase 1, Phase 2 jellyfin), `portfolio-orchestration-platform` (Phase 2 embedding-adapter)
- **Cluster:** k3s v1.34.3+k3s1, 4 nodes over a Tailscale/WireGuard WAN overlay

## Problem

Every cluster node's `INTERNAL-IP` is a `100.64.0.x` Tailscale CGNAT address — the
node-to-node fabric *is* a lossy WAN overlay. Pod DNS resolves against the kube-dns
ClusterIP `10.43.0.10`, which load-balances across 3 CoreDNS replicas:

| Node | Role | Location | Runs CoreDNS? |
|------|------|----------|---------------|
| `vmi2951245` (100.64.0.1) | control-plane | cloud | yes |
| `vmi3115606` (100.64.0.2) | worker | cloud | yes |
| `debian-marmoset` (100.64.0.12) | worker (heavy stateful) | home | yes |
| `marmoset` (100.64.0.3) | worker (laptop) | home | **no** |

Two compounding failures result:

1. **glibc UDP conntrack race** (documented cluster-wide): glibc fires parallel A+AAAA
   UDP queries; under load the conntrack entries collide and one reply is dropped,
   producing intermittent 5–10s `getaddrinfo` stalls. This crashloops any glibc pod
   whose health probe resolves a Service name.
2. **Cross-WAN CoreDNS load-balancing:** the Corefile's `loadbalance` plugin + ClusterIP
   spraying means a pod on a home node has a ~2/3 chance every lookup lands on a *cloud*
   CoreDNS across the lossy link. Measured from Jellyfin's node: same-node CoreDNS 0.00s,
   cloud replicas 0.05–2.72s with loss.

Both have so far been patched per-pod (a CoreDNS sidecar on jellyfin; `use-vc`
dnsConfig on embedding-adapter and others). These are point fixes that don't scale and
leave the cluster on multiple incoherent DNS strategies. NodeLocal DNSCache is the
cluster-wide cure that has been deferred across several incident writeups.

## How NodeLocal DNSCache fixes it

A DaemonSet runs a CoreDNS-based cache (`k8s-dns-node-cache`) on every node, bound to a
link-local IP and (in transparent mode) to the kube-dns ClusterIP itself via a dummy
`nodelocaldns` interface plus NOTRACK iptables rules.

- **Cache hits never touch the overlay** — repeat lookups are served from on-node memory,
  killing the cross-WAN round-trip for everything inside the cache TTL.
- **Cache misses forward to CoreDNS over TCP** (`force_tcp`) — a single reliable,
  retransmitting connection instead of two racing UDP datagrams. This eliminates the
  glibc conntrack race even on cold lookups.

## Scope

- **In scope:** Phase 1 (deploy + validate the cache) and Phase 2 (retire the per-pod
  DNS hacks the cache supersedes).
- **Out of scope (deferred):** Phase 3 — making cold `cluster.local` misses node-local.
  After Phase 1, cold misses from home nodes still reach a random CoreDNS (2/3 cloud),
  but now reliably over TCP and cached for 30s, so the *race* is already gone. Full
  locality (a per-node CoreDNS endpoint, incl. the laptop) is a separate future change.

## Approach decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Interception mode | **Transparent** (bind to 10.43.0.10 + link-local, NOTRACK) | Zero pod/kubelet restarts; pure GitOps; reversible. Explicit mode (repoint k3s `--cluster-dns`) would force a cluster-wide rolling pod restart and node-local `/etc` surgery. |
| Deployment vehicle | **Upstream `nodelocaldns.yaml`**, `__PILLAR__` substituted, committed as raw manifests | Matches repo style; keeps the NOTRACK/Corefile details legible given the iptables-nft risk. Rejected: community Helm chart (hides the risk surface). |
| Corefile mode | **Forward-only** (`cluster.local` → `kube-dns-upstream`, no kubernetes plugin) | Standard transparent-mode setup; minimal RBAC. |
| Rollout | **One-node canary, then fleet** | The only real risk (NOTRACK under iptables-nft) is cheap to validate on a single node before fleet-wide. |

## Architecture

### Phase 1 — components (all `kube-system`, sourced from `k8s/nodelocaldns/`)

- **DaemonSet `node-local-dns`**
  - Image `registry.k8s.io/dns/k8s-dns-node-cache` (pinned version, e.g. `1.26.0`).
  - `hostNetwork: true`, `priorityClassName: system-node-critical`, `dnsPolicy: Default`.
  - Tolerations for all taints (must run on every node incl. control-plane).
  - Binds link-local **169.254.20.10** and kube-dns ClusterIP **10.43.0.10** on a dummy
    `nodelocaldns` interface; installs NOTRACK + filter iptables rules via the entrypoint
    args (`-localip 169.254.20.10,10.43.0.10 -setupiptables`).
  - Liveness probe against the cache's health port on the link-local IP.
- **ConfigMap `node-local-dns` (Corefile)** — substituted placeholders:
  - `__PILLAR__LOCAL__DNS__` → `169.254.20.10`
  - `__PILLAR__DNS__DOMAIN__` → `cluster.local`
  - `__PILLAR__DNS__SERVER__` → `10.43.0.10` (kube-dns ClusterIP, for NOTRACK binding)
  - `__PILLAR__CLUSTER__DNS__` → `kube-dns-upstream` ClusterIP (miss-forward target)
  - `__PILLAR__UPSTREAM__SERVERS__` → `/etc/resolv.conf`
  - `cluster.local` and reverse (`in-addr.arpa`, `ip6.arpa`) zones use **`force_tcp`**;
    `cache 30`; `.` zone forwards to the node resolver.
- **Service `kube-dns-upstream`** — ClusterIP, `selector: k8s-app=kube-dns`, ports
  `53/UDP` + `53/TCP`. Stable miss-forward target distinct from the hijacked 10.43.0.10.
- **ServiceAccount `node-local-dns`** (forward-only mode needs no extra ClusterRole).

### Data flow after Phase 1

```
pod ──(resolv.conf 10.43.0.10, unchanged)──► node-local-dns cache (on-node)
                                               ├─ hit ──► served locally (no WAN)
                                               ├─ cluster.local miss ─(force_tcp)─► kube-dns-upstream ─► CoreDNS
                                               └─ external miss ──► node /etc/resolv.conf
```

### Validation gate (before fleet-wide rollout)

Deploy pinned via `nodeAffinity` to **`vmi3115606`** (a cloud node that already runs a
CoreDNS, so a regression is contained). Verify on that node:

1. `nslookup kubernetes.default` and an external name resolve from a pod on that node.
2. `iptables-save | grep -i notrack` shows the NOTRACK rules applied (proves the
   iptables-nft compat shim works).
3. `conntrack -L | grep :53` shows no new UDP DNS conntrack entries originating from that
   node (proves NOTRACK is effective — the race is gone).
4. Repeat-lookup latency drops to ~local; CoreDNS remains reachable as a fallback.

Only after all four pass: remove the `nodeAffinity` pin → DaemonSet rolls to all 4 nodes.

### Phase 2 — retire the redundant per-pod hacks

Sequenced **after Phase 1 is green fleet-wide**, one workload at a time, verifying each
stays healthy before the next:

- **`devops-portfolio-manager` — jellyfin** (`k8s/jellyfin/`):
  - Delete `configmap-coredns-sidecar.yaml`.
  - In `deployment.yaml`: restore `dnsPolicy: ClusterFirst`, remove the
    `jellyfin-coredns-sidecar` container and its startupProbe-gating, remove the
    `dnsPolicy: None` block.
  - Remove the `configmap-coredns-sidecar.yaml` line from `kustomization.yaml`.
- **`portfolio-orchestration-platform` — embedding-adapter**
  (`k8s/deployments/embedding-adapter-deployment.yaml`):
  - Remove the `use-vc` / `single-request-reopen` / `ndots:1` `dnsConfig` (commits
    09fd3d3, 1933a09). Keep the in-cluster FQDN URLs (harmless).
- **Sweep both repos** for any other `use-vc` / custom `dnsConfig` survivors and clear them.

## Rollback

- **Phase 2:** `git revert` the relevant commit; ArgoCD re-syncs the prior pod spec.
- **Phase 1:** `kubectl delete ds node-local-dns -n kube-system` + delete the
  `kube-dns-upstream` Service.
  - **CRITICAL:** deleting the DaemonSet does **not** remove the NOTRACK iptables rules or
    the dummy `nodelocaldns` interface on each node. Left in place they route 10.43.0.10
    to a now-absent listener and **wedge DNS on that node**. Rollback therefore includes a
    per-node cleanup: flush the node-local-dns iptables rules and `ip link del nodelocaldns`
    (run as a one-shot, or document the manual steps). This must be tested as part of the
    canary so the rollback path is known-good before fleet-wide.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| NOTRACK rules don't apply under the iptables-nft backend (Debian 13 / kernel 6.12) | High | Canary gate step 2/3 proves it on one node before fleet-wide. |
| A crashlooping `node-local-dns` pod breaks DNS on its node (it owns 10.43.0.10) | High | `priorityClassName: system-node-critical`, tight liveness probe, pinned stable image; canary validates the steady state. |
| Image pull fails during a WAN flap | Medium | Pin a specific tag; optionally mirror into the cluster registry used elsewhere. |
| Rollback wedges DNS (orphaned iptables/interface) | Medium | Documented per-node cleanup, tested during the canary. |
| Cold `cluster.local` misses from home nodes still cross WAN | Low (accepted) | Now over reliable TCP + cached 30s; full locality is the deferred Phase 3. |

## Success criteria

1. `node-local-dns` Running on all 4 nodes; DNS resolves cluster-wide.
2. No new UDP `:53` conntrack entries from pod traffic (race eliminated).
3. Jellyfin runs with `dnsPolicy: ClusterFirst` and no CoreDNS sidecar, with no playback
   freezes over a representative Live TV session.
4. embedding-adapter (and any other previously-patched glibc pod) stays at 0 restarts
   with stock `dnsConfig`.
5. The cluster is on a single DNS strategy — no remaining per-pod DNS workarounds.

## GitOps integration

- New `k8s/nodelocaldns/` directory (raw manifests).
- New `gitops/applications/nodelocaldns.yaml` ArgoCD Application, registered in
  `gitops/app-of-apps.yaml`.
- Per repo convention, manifest fixes that must go live are committed directly to `main`.
