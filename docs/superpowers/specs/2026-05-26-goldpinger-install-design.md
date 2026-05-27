# Goldpinger Install Design

**Date:** 2026-05-26
**Status:** Pending approval
**Scope:** Install Bloomberg's goldpinger in the K3s cluster to detect pod-to-pod connectivity drift across all 4 nodes, with Prometheus alerts, Traefik-exposed UI, and a NetworkPolicy.

## Context

The cluster has had multiple silent-drift networking incidents this month:

- **2026-05-25** — `flannel.1` vanished on vmi2951245 (node stayed Ready), starved CoreDNS replica there → ESO → CSS InvalidProviderConfig cascade. See [[flannel-dns-eso-cascade-2026-05-25]]. Took ~30min to root-cause via manual `ip link` checks per node.
- **2026-05-25** — Chronic ~hourly Tailscale micro-blips on vmi3115606 causing API timeouts for ~5 pods. See [[vmi3115606-chronic-api-microblips-2026-05-25]].
- **2026-05-21** — AXE-7800 Garage zone unreachable for 3 days, ICMP fine, TCP/3901 silently dropping due to MTU. See [[axe-vmi-wg-bypass-fix-2026-05-25]].

Common failure mode: pod-to-pod path breaks at L3/L4 while node liveness probes (which use the kubelet→API path, not pod network) keep reporting healthy. There is no continuous probe of the pod-network mesh today; failures are detected only when an application is downstream of the broken path.

Goldpinger runs a full N×N ping mesh between DaemonSet pods, exposes metrics + a topology graph, and surfaces both directional and bidirectional reachability problems within ~30s of onset.

## Decisions

- **Direct manifests over Helm** — Goldpinger is a single DaemonSet + Service + RBAC bundle. Wrapping it in an in-repo chart (the NPD pattern) adds files without enabling per-environment overrides we need. One ArgoCD Application pointing at `k8s/goldpinger/`.
- **Image pin: `bloomberg/goldpinger:v3.11.2`** — Latest upstream release (2026-04-23). Renovate/dependabot not configured for this path yet; future bumps are manual.
- **Tolerate marmoset's GPU `NoSchedule` taint** — Without this, marmoset is a blind spot. Marmoset hosts the only host-level tritonserver and 4× NVIDIA GPUs ([[marmoset-gpu-consumers-2026-05-25]]); we want visibility into its pod-network path. Actual taint key is `workload=gpu` (verified at execution time, see [[marmoset-gpu-taint-key]]), not `nvidia.com/gpu`.
- **`hostNetwork: false`** — Goldpinger must use the pod network, since that's the network we're trying to monitor. (Using hostNetwork would defeat the purpose and miss flannel/CNI failures.)
- **PrometheusRule alerts** — Wired to existing kube-prom stack. Three rules: unreachable peer, slow peer, DNS failure (see Section 4).
- **Traefik ingress for UI** — `goldpinger.el-jefe.me` via the same pattern as `prometheus.el-jefe.me` / `jellyfin-k8s.el-jefe.me`: standard `networking.k8s.io/v1` Ingress, `letsencrypt-prod` cluster issuer, `kube-system-crowdsec-bouncer@kubernetescrd` middleware, TLS secret `goldpinger-tls`. Read-only UI, no destructive actions.
- **NetworkPolicy** — Restrict ingress to `:8080` to Prometheus + Traefik. Egress: allow ALL (goldpinger MUST be able to reach every other goldpinger pod on every node, plus DNS — the whole point of the tool).

## Section 1: Architecture

```
                    ┌─ goldpinger pod (marmoset) ─┐
                    │                             │
   ┌────────────────┼─────────────────────────────┼────────────────┐
   │                ▼                             ▼                │
   │ goldpinger (debian-marmoset)  ◀───ping───▶  goldpinger (vmi2951245)
   │         ▲                                    ▲                │
   │         └──────────────ping─────────────────┘                 │
   │                            ▼                                  │
   │                  goldpinger (vmi3115606)                      │
   └───────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
            Prometheus    Traefik UI    Alertmanager
            (scrape)      (graph)       (rules fire)
```

Each pod pings every peer over the pod network every `--ping-period` (default 5s). Two metrics families:
- `goldpinger_peers_response_time_s99` — per-peer p99 latency
- `goldpinger_nodes_health_total{status="unhealthy"}` — count of unreachable peers, per source pod

## Section 2: File Layout

Mirrors the NPD pattern minus the helm-chart side.

```
devops-portfolio-manager/
├── k8s/
│   └── goldpinger/
│       ├── namespace.yaml
│       ├── rbac.yaml                  # ServiceAccount, ClusterRole (pods:list)
│       ├── daemonset.yaml             # tolerations, hostNetwork=false
│       ├── service.yaml               # ClusterIP, port 8080
│       ├── servicemonitor.yaml        # for kube-prom
│       ├── prometheusrule.yaml        # 3 alerts
│       ├── ingress.yaml               # Traefik IngressRoute
│       └── networkpolicy.yaml         # ingress restriction
└── gitops/
    └── applications/
        └── goldpinger.yaml            # single ArgoCD Application
```

## Section 3: DaemonSet specifics

- **Replicas:** 1 per node × 4 nodes = 4 pods
- **Resources:** `requests: {cpu: 50m, memory: 32Mi}`, `limits: {cpu: 200m, memory: 128Mi}` (upstream defaults)
- **Tolerations:**
  - `workload=gpu:NoSchedule` — for marmoset (see [[marmoset-gpu-taint-key]]); NOT `nvidia.com/gpu`
  - `node-role.kubernetes.io/control-plane:NoSchedule` — forward-compat for vmi2951245 (currently only `PreferNoSchedule`, harmless no-op)
  - `node.kubernetes.io/not-ready:NoExecute` for 30s, `node.kubernetes.io/unreachable:NoExecute` for 30s — keep pod alive briefly during transient node issues so it can observe its own degradation
- **Args:** `--ping-period 5s --check-timeout 1s --check-all-timeout 5s --pod-ip-override $(POD_IP)`
- **Env:** `HOSTNAME`, `POD_IP` (downward API), `HOST` (`0.0.0.0`)
- **Ports:** `containerPort: 8080` named `http`
- **Probes:** `httpGet /healthz :8080` both liveness + readiness

## Section 4: Prometheus alerts

| Alert | Expression | For | Severity |
|---|---|---|---|
| `GoldpingerPeerUnreachable` | `goldpinger_nodes_health_total{status="unhealthy"} > 0` | 2m | warning |
| `GoldpingerPeerUnreachableProlonged` | same | 10m | critical |
| `GoldpingerPeerSlow` | `histogram_quantile(0.99, sum by (le, source_node, destination_node) (rate(goldpinger_peers_response_time_s_bucket[5m]))) > 0.1` | 5m | warning |
| `GoldpingerDNSFailure` | `rate(goldpinger_dns_resolution_failures_total[5m]) > 0` | 2m | warning |

All four route through existing Alertmanager → Gotify (per current cluster-health-alerts.yaml pattern).

## Section 5: Ingress

Mirrors the `jellyfin-k8s.el-jefe.me` pattern (standard `networking.k8s.io/v1` Ingress, not Traefik CRD IngressRoute):

- Host: `goldpinger.el-jefe.me`
- IngressClass: `traefik`
- TLS: cert-manager `letsencrypt-prod` cluster issuer → `goldpinger-tls` secret
- Middlewares: `kube-system-crowdsec-bouncer@kubernetescrd` (matches Prometheus + Jellyfin)
- Backend: `goldpinger` Service, port 80 → container port 8080
- UI lives at `/` (same port as `/metrics` and `/healthz`)

## Section 6: NetworkPolicy

```yaml
ingress:
  - from:
      - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: monitoring}}
      - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
    ports: [{port: 8080, protocol: TCP}]
egress: []  # allow all — must reach every pod IP cluster-wide
policyTypes: [Ingress]
```

Egress is intentionally unrestricted: goldpinger's purpose is N×N pod-IP ping plus DNS. Restricting egress would defeat the tool.

## Section 7: ArgoCD Application

Single Application (no chart/resources split since there's no Helm):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: goldpinger
  namespace: argocd
  labels: {app: goldpinger, infrastructure: "true"}
  finalizers: [resources-finalizer.argocd.argoproj.io]
spec:
  project: default
  source:
    repoURL: https://github.com/maxjeffwell/devops-portfolio-manager.git
    targetRevision: main
    path: k8s/goldpinger
  destination:
    server: https://kubernetes.default.svc
    namespace: goldpinger
  syncPolicy:
    automated: {prune: true, selfHeal: true, allowEmpty: false}
    syncOptions: [CreateNamespace=false]
    retry: {limit: 5, backoff: {duration: 5s, factor: 2, maxDuration: 3m}}
```

## Out of scope

- **GPU pod path monitoring** — Goldpinger pings pod-network IPs but does not exercise GPU-specific paths.
- **Cross-cluster pings** — Single-cluster only; the AXE-7800 / Garage WG mesh issues seen in [[axe-vmi-wg-bypass-fix-2026-05-25]] live outside K8s and won't be observed.
- **Auto-remediation** — Goldpinger detects, [[flannel-watchdog-2026-05-25]] remediates. No new automation here.
- **Renovate config** — Image pin updates remain manual until the repo gets a Renovate config; goldpinger releases ~quarterly so the maintenance cost is small.

## Risks

| Risk | Mitigation |
|---|---|
| 4×N=16 ping flows could be noisy on the WG mesh between control-plane nodes | Default `--ping-period 5s` is fine for 4 nodes (12 unidirectional flows, <1pps). Tune up only if noise observed. |
| False positives during legitimate node drain | Tolerations include `NoExecute` 30s grace; alerts use `for: 2m` minimum |
| UI exposes node IPs / pod IPs publicly if ingress auth misconfigured | Reuse the same middleware chain as Prometheus, which already has the right auth |
| Marmoset GPU node could be co-scheduled with goldpinger during high-pressure GPU workload | Pod is 50m/32Mi — negligible. No GPU resource request, so no GPU contention. |
