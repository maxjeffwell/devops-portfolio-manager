# NodeLocal DNSCache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy NodeLocal DNSCache cluster-wide in transparent mode to eliminate the glibc UDP conntrack race and cross-WAN CoreDNS round-trips, then retire the redundant per-pod DNS workarounds it supersedes.

**Architecture:** A `node-local-dns` DaemonSet runs a CoreDNS-based cache on every k3s node, bound to link-local `169.254.20.10` and the kube-dns ClusterIP `10.43.0.10` via NOTRACK iptables rules. Pods keep resolving against `10.43.0.10` (no pod changes) but are transparently served on-node; cache misses forward to CoreDNS over **TCP** (`force_tcp`). Rolled out canary-first (one node) before fleet-wide, all via GitOps/ArgoCD.

**Tech Stack:** k3s v1.34.3, ArgoCD (app-of-apps), `registry.k8s.io/dns/k8s-dns-node-cache`, CoreDNS, iptables-nft.

**Spec:** `docs/superpowers/specs/2026-06-10-nodelocal-dnscache-design.md`

---

## File Structure

**Repo `devops-portfolio-manager` (branch `main`):**

| Path | Action | Responsibility |
|------|--------|----------------|
| `k8s/nodelocaldns/serviceaccount.yaml` | create | SA for the DaemonSet |
| `k8s/nodelocaldns/service-kube-dns-upstream.yaml` | create | `kube-dns-upstream` ClusterIP — stable miss-forward target |
| `k8s/nodelocaldns/configmap.yaml` | create | Corefile (zones, `force_tcp`, cache, binds) |
| `k8s/nodelocaldns/daemonset.yaml` | create | the cache agent; canary `nodeAffinity` pin removed in Task 4 |
| `k8s/nodelocaldns/ROLLBACK.md` | create | per-node teardown runbook (orphaned iptables/iface) |
| `gitops/applications/nodelocaldns.yaml` | create | ArgoCD Application; app-of-apps auto-discovers it |
| `k8s/jellyfin/deployment.yaml` | modify | drop `dnsPolicy: None`/`dnsConfig`, the `dns-cache` sidecar, the `coredns-config` volume |
| `k8s/jellyfin/kustomization.yaml` | modify | drop `configmap-coredns-sidecar.yaml` |
| `k8s/jellyfin/configmap-coredns-sidecar.yaml` | delete | sidecar Corefile, no longer used |
| `helm-charts/lunary/values.yaml` | modify | drop `single-request-reopen` (keep `ndots`) |

**Repo `portfolio-orchestration-platform` (branch `main`):**

| Path | Action | Responsibility |
|------|--------|----------------|
| `k8s/deployments/embedding-adapter-deployment.yaml` | modify | remove the `use-vc`/`single-request-reopen`/`ndots` `dnsConfig` |

**Substitution values (transparent mode):** `__PILLAR__LOCAL__DNS__`=`169.254.20.10`, `__PILLAR__DNS__SERVER__`=`10.43.0.10`, `__PILLAR__DNS__DOMAIN__`=`cluster.local`. The tokens `__PILLAR__CLUSTER__DNS__` and `__PILLAR__UPSTREAM__SERVERS__` are **left literal** — the `node-cache` binary rewrites them at runtime from the `kube-dns-upstream` Service and `/etc/resolv.conf` respectively (via the `-upstreamsvc` arg).

---

## Task 1: Create the nodelocaldns manifests (canary-pinned)

**Files:**
- Create: `k8s/nodelocaldns/serviceaccount.yaml`
- Create: `k8s/nodelocaldns/service-kube-dns-upstream.yaml`
- Create: `k8s/nodelocaldns/configmap.yaml`
- Create: `k8s/nodelocaldns/daemonset.yaml`
- Create: `k8s/nodelocaldns/ROLLBACK.md`

- [ ] **Step 1: Create the ServiceAccount**

`k8s/nodelocaldns/serviceaccount.yaml`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: node-local-dns
  namespace: kube-system
  labels:
    k8s-app: node-local-dns
```

- [ ] **Step 2: Create the kube-dns-upstream Service**

`k8s/nodelocaldns/service-kube-dns-upstream.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: kube-dns-upstream
  namespace: kube-system
  labels:
    k8s-app: kube-dns
    kubernetes.io/name: KubeDNSUpstream
spec:
  ports:
    - name: dns
      port: 53
      protocol: UDP
      targetPort: 53
    - name: dns-tcp
      port: 53
      protocol: TCP
      targetPort: 53
  selector:
    k8s-app: kube-dns
```

- [ ] **Step 3: Create the ConfigMap (Corefile)**

`k8s/nodelocaldns/configmap.yaml` (note the literal `__PILLAR__CLUSTER__DNS__` / `__PILLAR__UPSTREAM__SERVERS__` — do NOT substitute these):

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-local-dns
  namespace: kube-system
  labels:
    k8s-app: node-local-dns
data:
  Corefile: |
    cluster.local:53 {
        errors
        cache {
            success 9984 30
            denial 9984 5
        }
        reload
        loop
        bind 169.254.20.10 10.43.0.10
        forward . __PILLAR__CLUSTER__DNS__ {
            force_tcp
        }
        prometheus :9253
        health 169.254.20.10:8080
    }
    in-addr.arpa:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10 10.43.0.10
        forward . __PILLAR__CLUSTER__DNS__ {
            force_tcp
        }
        prometheus :9253
    }
    ip6.arpa:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10 10.43.0.10
        forward . __PILLAR__CLUSTER__DNS__ {
            force_tcp
        }
        prometheus :9253
    }
    .:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10 10.43.0.10
        forward . __PILLAR__UPSTREAM__SERVERS__
        prometheus :9253
    }
```

- [ ] **Step 4: Create the DaemonSet (canary-pinned to vmi3115606)**

`k8s/nodelocaldns/daemonset.yaml`:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-local-dns
  namespace: kube-system
  labels:
    k8s-app: node-local-dns
spec:
  updateStrategy:
    rollingUpdate:
      maxUnavailable: 10%
  selector:
    matchLabels:
      k8s-app: node-local-dns
  template:
    metadata:
      labels:
        k8s-app: node-local-dns
      annotations:
        prometheus.io/port: "9253"
        prometheus.io/scrape: "true"
    spec:
      priorityClassName: system-node-critical
      serviceAccountName: node-local-dns
      hostNetwork: true
      dnsPolicy: Default
      tolerations:
        - key: "CriticalAddonsOnly"
          operator: "Exists"
        - effect: "NoExecute"
          operator: "Exists"
        - effect: "NoSchedule"
          operator: "Exists"
      # CANARY PIN — removed in Task 4 to roll fleet-wide.
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: kubernetes.io/hostname
                    operator: In
                    values: ["vmi3115606"]
      containers:
        - name: node-cache
          image: registry.k8s.io/dns/k8s-dns-node-cache:1.26.0
          resources:
            requests:
              cpu: 25m
              memory: 5Mi
          args:
            - "-localip"
            - "169.254.20.10,10.43.0.10"
            - "-conf"
            - "/etc/Corefile"
            - "-upstreamsvc"
            - "kube-dns-upstream"
          securityContext:
            capabilities:
              add:
                - NET_ADMIN
          ports:
            - containerPort: 53
              name: dns
              protocol: UDP
            - containerPort: 53
              name: dns-tcp
              protocol: TCP
            - containerPort: 9253
              name: metrics
              protocol: TCP
          livenessProbe:
            httpGet:
              host: 169.254.20.10
              path: /health
              port: 8080
            initialDelaySeconds: 60
            timeoutSeconds: 5
          volumeMounts:
            - mountPath: /run/xtables.lock
              name: xtables-lock
              readOnly: false
            - name: config-volume
              mountPath: /etc/coredns
            - name: kube-dns-config
              mountPath: /etc/kube-dns
      volumes:
        - name: xtables-lock
          hostPath:
            path: /run/xtables.lock
            type: FileOrCreate
        - name: kube-dns-config
          configMap:
            name: kube-dns
            optional: true
        - name: config-volume
          configMap:
            name: node-local-dns
            items:
              - key: Corefile
                path: Corefile.base
```

- [ ] **Step 5: Create the rollback runbook**

`k8s/nodelocaldns/ROLLBACK.md`:

```markdown
# NodeLocal DNSCache — Rollback Runbook

Deleting the DaemonSet does NOT remove the NOTRACK iptables rules or the dummy
`nodelocaldns` interface from each node. Orphaned, they route 10.43.0.10 to an
absent listener and WEDGE DNS on that node. Roll back in this order:

1. Stop ArgoCD fighting the teardown — delete the Application (its finalizer
   cleans the workloads):
       kubectl delete application nodelocaldns -n argocd
   (Or, to keep the app, set its syncPolicy.automated to null and sync manually.)

2. GRACEFUL pod teardown first — node-cache cleans its own iptables + interface on
   SIGTERM, so let it before the objects vanish:
       kubectl -n kube-system delete pod -l k8s-app=node-local-dns --grace-period=30

3. Confirm DNS still resolves on each affected node (see verification below). If a
   node is wedged (node-cache was force-killed / node crashed), clean it manually
   via a debug pod:
       kubectl debug node/<NODE> -it --image=nicolaka/netshoot --profile=sysadmin -- \
         nsenter -t 1 -n -- sh -c '
           iptables-save | grep -E "169.254.20.10|10.43.0.10" ;
           # delete each matching rule shown above with: iptables -t <table> -D <chain> <rule>
           ip link del nodelocaldns 2>/dev/null || true'

## Verify DNS healthy on a node
    kubectl run dns-rb-check --rm -it --restart=Never --image=busybox:1.36 \
      --overrides='{"spec":{"nodeName":"<NODE>"}}' -- nslookup kubernetes.default
Expected: resolves to 10.43.0.1.
```

- [ ] **Step 6: Validate manifests render and substitutions are correct**

Run:
```bash
cd ~/GitHub_Projects/devops-portfolio-manager
kubectl apply --dry-run=client -f k8s/nodelocaldns/ -o name
echo "--- leftover tokens that MUST be gone (expect no output): ---"
grep -R "__PILLAR__LOCAL__DNS__\|__PILLAR__DNS__SERVER__\|__PILLAR__DNS__DOMAIN__" k8s/nodelocaldns/ || echo "OK: none"
echo "--- tokens that MUST remain literal (expect matches): ---"
grep -R "__PILLAR__CLUSTER__DNS__\|__PILLAR__UPSTREAM__SERVERS__" k8s/nodelocaldns/configmap.yaml
```
Expected: dry-run prints `serviceaccount/node-local-dns`, `service/kube-dns-upstream`, `configmap/node-local-dns`, `daemonset.apps/node-local-dns` (all valid); first grep prints `OK: none`; second grep prints the two literal tokens.

- [ ] **Step 7: Commit**

```bash
git add k8s/nodelocaldns/
git commit -m "nodelocaldns: add transparent NodeLocal DNSCache (canary-pinned to vmi3115606)"
```

---

## Task 2: Wire the ArgoCD Application

**Files:**
- Create: `gitops/applications/nodelocaldns.yaml`

- [ ] **Step 1: Create the Application manifest**

`gitops/applications/nodelocaldns.yaml`:

```yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: nodelocaldns
  namespace: argocd
  labels:
    app: nodelocaldns
    infrastructure: "true"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/maxjeffwell/devops-portfolio-manager.git
    targetRevision: main
    path: k8s/nodelocaldns
  destination:
    server: https://kubernetes.default.svc
    namespace: kube-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - CreateNamespace=false
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

- [ ] **Step 2: Validate it renders**

Run:
```bash
kubectl apply --dry-run=client -f gitops/applications/nodelocaldns.yaml -o name
```
Expected: `application.argoproj.io/nodelocaldns` (valid).

- [ ] **Step 3: Commit and push**

```bash
git add gitops/applications/nodelocaldns.yaml
git commit -m "nodelocaldns: register ArgoCD Application"
git push origin main
```

- [ ] **Step 4: Confirm ArgoCD creates and syncs the app (canary scope)**

Run (allow ~3 min for app-of-apps to discover the new child):
```bash
kubectl -n argocd get application nodelocaldns -o wide
kubectl -n kube-system get ds node-local-dns
```
Expected: Application `Synced` / `Healthy`; DaemonSet shows `DESIRED 1` (only `vmi3115606`).
If `ProgressDeadlineExceeded` or `OutOfSync`, inspect: `kubectl -n argocd describe application nodelocaldns`.

---

## Task 3: Validate the canary (GATE — do not proceed if any check fails)

**Files:** none (verification only).

- [ ] **Step 1: Confirm the pod is Running on the canary node**

Run:
```bash
kubectl -n kube-system get pods -l k8s-app=node-local-dns -o wide
```
Expected: exactly one pod, `Running`, `1/1`, on node `vmi3115606`.

- [ ] **Step 2: DNS resolves from a pod ON the canary node**

Run:
```bash
kubectl run dns-canary --rm -it --restart=Never --image=busybox:1.36 \
  --overrides='{"spec":{"nodeName":"vmi3115606"}}' -- \
  sh -c 'nslookup kubernetes.default && nslookup github.com'
```
Expected: `kubernetes.default` resolves to `10.43.0.1`; `github.com` resolves to public IPs. (resolv.conf still points at `10.43.0.10`, now served locally.)

- [ ] **Step 3: NOTRACK rules are present on the node (iptables-nft compat proof)**

Run:
```bash
kubectl debug node/vmi3115606 -it --image=nicolaka/netshoot --profile=sysadmin -- \
  nsenter -t 1 -n -- sh -c 'iptables-save -t raw | grep -E "169.254.20.10|10.43.0.10"'
```
Expected: several `NOTRACK` rules in the `raw` table referencing `169.254.20.10` and `10.43.0.10` on dport/sport 53. **If empty, the iptables-nft shim failed — STOP and rollback (this is the gate's core risk).**

- [ ] **Step 4: No new UDP :53 conntrack entries from node DNS (race eliminated)**

Run:
```bash
kubectl debug node/vmi3115606 -it --image=nicolaka/netshoot --profile=sysadmin -- \
  nsenter -t 1 -n -- conntrack -L -p udp --dport 53 2>/dev/null | head
```
Expected: no (or near-zero) conntrack entries for pod→10.43.0.10:53 UDP traffic — they are NOTRACK'd. (Contrast: pre-deploy this table fills under load.)

- [ ] **Step 5: Rehearse rollback on the canary, then re-apply**

This proves the teardown path BEFORE fleet-wide. Run:
```bash
# Graceful pod delete — node-cache should clean its own iptables + iface on SIGTERM.
kubectl -n kube-system delete pod -l k8s-app=node-local-dns --grace-period=30
# Confirm the rules are gone:
kubectl debug node/vmi3115606 -it --image=nicolaka/netshoot --profile=sysadmin -- \
  nsenter -t 1 -n -- sh -c 'iptables-save -t raw | grep -cE "169.254.20.10|10.43.0.10" || echo 0'
# Confirm DNS still resolves on the node with the cache gone (falls back to kube-dns):
kubectl run dns-rb --rm -it --restart=Never --image=busybox:1.36 \
  --overrides='{"spec":{"nodeName":"vmi3115606"}}' -- nslookup kubernetes.default
```
Expected: rule count `0` after graceful delete (clean teardown — no manual cleanup needed); DNS still resolves via kube-dns fallback. ArgoCD `selfHeal` recreates the pod within ~1 min — confirm: `kubectl -n kube-system get pods -l k8s-app=node-local-dns -w` returns to `Running`. If the rule count was non-zero, the `ROLLBACK.md` manual cleanup is required and the runbook must be corrected before proceeding.

---

## Task 4: Roll out fleet-wide (remove the canary pin)

**Files:**
- Modify: `k8s/nodelocaldns/daemonset.yaml`

- [ ] **Step 1: Remove the canary nodeAffinity block**

In `k8s/nodelocaldns/daemonset.yaml`, delete these 11 lines (the canary pin added in Task 1 Step 4):

```yaml
      # CANARY PIN — removed in Task 4 to roll fleet-wide.
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: kubernetes.io/hostname
                    operator: In
                    values: ["vmi3115606"]
```

- [ ] **Step 2: Validate it still renders**

Run:
```bash
kubectl apply --dry-run=client -f k8s/nodelocaldns/daemonset.yaml -o name
grep -c "nodeAffinity" k8s/nodelocaldns/daemonset.yaml || echo "0 (pin removed)"
```
Expected: `daemonset.apps/node-local-dns` valid; grep prints `0 (pin removed)`.

- [ ] **Step 3: Commit and push**

```bash
git add k8s/nodelocaldns/daemonset.yaml
git commit -m "nodelocaldns: remove canary pin, roll out to all nodes"
git push origin main
```

- [ ] **Step 4: Confirm fleet-wide rollout**

Run (allow ~3 min for sync + rollout):
```bash
kubectl -n kube-system rollout status ds/node-local-dns --timeout=180s
kubectl -n kube-system get pods -l k8s-app=node-local-dns -o wide
```
Expected: `DESIRED 4`, all `Running 1/1`, one pod each on `vmi2951245`, `vmi3115606`, `debian-marmoset`, `marmoset`.

- [ ] **Step 5: Spot-check DNS on the home nodes (the WAN-pain nodes)**

Run:
```bash
for n in debian-marmoset marmoset; do
  echo "=== $n ===";
  kubectl run dns-$n --rm -i --restart=Never --image=busybox:1.36 \
    --overrides="{\"spec\":{\"nodeName\":\"$n\"}}" -- nslookup kubernetes.default 2>/dev/null;
done
```
Expected: both resolve locally (served by the on-node cache, no cross-WAN hop).

---

## Task 5: Retire the jellyfin CoreDNS sidecar (Phase 2a)

**Files:**
- Modify: `k8s/jellyfin/deployment.yaml`
- Modify: `k8s/jellyfin/kustomization.yaml`
- Delete: `k8s/jellyfin/configmap-coredns-sidecar.yaml`

- [ ] **Step 1: Remove the dnsPolicy/dnsConfig override (deployment.yaml lines 28–46)**

Replace this block:

```yaml
      # 2026-06-06 — Resolve DNS against a per-pod CoreDNS cache sidecar
      # (127.0.0.1:53, see initContainers/dns-cache) instead of the kube-dns
      # ClusterIP. The ClusterIP load-balances lookups across CoreDNS replicas
      # on cloud nodes reached over the lossy WireGuard WAN (measured up to
      # 2.7s/lookup vs 0.00s same-node), which stalled request threads → live-TV
      # freezes and /health probe timeouts. dnsPolicy None makes 127.0.0.1 the
      # sole resolver; the sidecar caches + forwards to kube-dns so each name
      # crosses the WAN at most once per TTL.
      dnsPolicy: None
      dnsConfig:
        nameservers:
          - 127.0.0.1
        searches:
          - jellyfin.svc.cluster.local
          - svc.cluster.local
          - cluster.local
          - tailnet.el-jefe.me
        options:
          - { name: ndots, value: "1" }
```

with:

```yaml
      # 2026-06-10 — DNS served by cluster-wide NodeLocal DNSCache (k8s/nodelocaldns).
      # The on-node cache resolves locally and forwards misses to CoreDNS over TCP,
      # so the per-pod sidecar that previously fronted kube-dns is no longer needed.
      dnsPolicy: ClusterFirst
```

- [ ] **Step 2: Remove the `dns-cache` native sidecar (deployment.yaml lines 57–93)**

Delete the entire `dns-cache` initContainer entry — from the comment `# Native sidecar (restartPolicy: Always)...` through the `volumeMounts:` line `- { name: coredns-config, mountPath: /etc/coredns, readOnly: true }` (i.e. the block beginning `- name: dns-cache` and ending at the line before `# Recover encoding.xml...`). Leave `initContainers:` itself and the following `ensure-encoding-config` container intact.

- [ ] **Step 3: Remove the `coredns-config` volume (deployment.yaml lines 212–214)**

Delete:

```yaml
        - name: coredns-config
          configMap:
            name: jellyfin-coredns-sidecar
```

- [ ] **Step 4: Remove the kustomization reference**

In `k8s/jellyfin/kustomization.yaml`, delete the line:

```yaml
  - configmap-coredns-sidecar.yaml
```

- [ ] **Step 5: Delete the sidecar ConfigMap file**

```bash
git rm k8s/jellyfin/configmap-coredns-sidecar.yaml
```

- [ ] **Step 6: Validate the kustomization still builds**

Run:
```bash
kubectl kustomize k8s/jellyfin >/dev/null && echo "OK: kustomize builds"
grep -c "coredns\|dnsPolicy: None\|dns-cache" k8s/jellyfin/deployment.yaml || echo "0 (clean)"
```
Expected: `OK: kustomize builds`; the grep prints `0 (clean)`.

- [ ] **Step 7: Commit and push**

```bash
git add k8s/jellyfin/
git commit -m "jellyfin: retire per-pod CoreDNS sidecar; use NodeLocal DNSCache (ClusterFirst)"
git push origin main
```

- [ ] **Step 8: Verify jellyfin is healthy after the rollout**

Run (allow ~3 min for sync + Recreate rollout):
```bash
kubectl -n jellyfin rollout status deploy/jellyfin --timeout=240s
kubectl -n jellyfin get pod -l app=jellyfin -o jsonpath='{.items[0].spec.dnsPolicy}{"\n"}'
kubectl -n jellyfin exec deploy/jellyfin -c jellyfin -- nslookup kube-dns.kube-system 2>/dev/null | head
```
Expected: rollout succeeds; dnsPolicy prints `ClusterFirst`; DNS resolves from inside the pod. Then confirm a representative Live TV session plays without freezes (manual check via the Jellyfin UI).

---

## Task 6: Retire the embedding-adapter dnsConfig (Phase 2b — other repo)

**Files:**
- Modify: `portfolio-orchestration-platform/k8s/deployments/embedding-adapter-deployment.yaml`

- [ ] **Step 1: Remove the dnsConfig block (lines 26–41)**

In `~/GitHub_Projects/portfolio-orchestration-platform/k8s/deployments/embedding-adapter-deployment.yaml`, replace this block:

```yaml
      # DNS hardening. The /health endpoint synchronously resolves the Triton
      # backend on every probe, and intermittent 5-10s glibc resolution stalls
      # were tripping the probe timeouts and crash-looping the pod. Root cause is
      # the glibc parallel A+AAAA "UDP conntrack race" (one reply dropped -> 5s
      # retransmit), which happens even for a single FQDN.
      #   - ndots:1            -> FQDN resolves in one query, no search-list walk
      #   - single-request-reopen -> serialize A/AAAA on separate sockets
      #   - use-vc             -> resolve over TCP; eliminates the UDP race
      # Validated: use-vc drops worst-case lookup from ~7s to ~2.6s with zero 5s
      # stalls over 30 samples.
      dnsConfig:
        options:
          - name: ndots
            value: "1"
          - name: single-request-reopen
          - name: use-vc
```

with:

```yaml
      # 2026-06-10 — DNS race fixed cluster-wide by NodeLocal DNSCache
      # (devops-portfolio-manager k8s/nodelocaldns): the on-node cache forwards
      # misses to CoreDNS over TCP, so the per-pod use-vc/single-request-reopen
      # workaround is no longer needed. /health uses the in-cluster FQDN (kept).
```

- [ ] **Step 2: Validate it renders**

Run:
```bash
cd ~/GitHub_Projects/portfolio-orchestration-platform
kubectl apply --dry-run=client -f k8s/deployments/embedding-adapter-deployment.yaml -o name
grep -c "use-vc\|single-request-reopen\|dnsConfig" k8s/deployments/embedding-adapter-deployment.yaml || echo "0 (clean)"
```
Expected: deployment valid; grep prints `0 (clean)`.

- [ ] **Step 3: Commit and push**

```bash
git add k8s/deployments/embedding-adapter-deployment.yaml
git commit -m "embedding-adapter: drop use-vc dnsConfig; rely on NodeLocal DNSCache"
git push origin main
```

- [ ] **Step 4: Verify the pod stays healthy with stock DNS**

Run (allow ~3 min for ArgoCD selfHeal to apply — this app is auto-synced):
```bash
kubectl -n default rollout status deploy/embedding-adapter --timeout=180s
kubectl -n default get pod -l app=embedding-adapter \
  -o jsonpath='{range .items[*]}{.metadata.name}{" restarts="}{.status.containerStatuses[0].restartCount}{" dnsPolicy="}{.spec.dnsPolicy}{"\n"}{end}'
```
Expected: rollout succeeds; new pod has `dnsPolicy=ClusterFirst` (default, no dnsConfig) and `restarts=0`. Re-check `restarts` after ~10 min to confirm `/health` stays green with no resolution stalls.

---

## Task 7: Retire the lunary single-request-reopen hack (keep ndots)

**Files:**
- Modify: `helm-charts/lunary/values.yaml`

- [ ] **Step 1: Remove only the race-mitigation option**

In `~/GitHub_Projects/devops-portfolio-manager/helm-charts/lunary/values.yaml`, in the `dnsConfig.options` list (around line 131), delete the `single-request-reopen` entry:

```yaml
    - name: single-request-reopen
```

**Keep** the `ndots` entry — it governs `tailnet.el-jefe.me` search-suffix resolution, which is orthogonal to the conntrack race. Update the preceding comment to note nodelocaldns now handles the race.

- [ ] **Step 2: Validate the chart still templates**

Run:
```bash
cd ~/GitHub_Projects/devops-portfolio-manager
helm template lunary helm-charts/lunary >/dev/null && echo "OK: chart templates"
grep -c "single-request-reopen" helm-charts/lunary/values.yaml || echo "0 (removed)"
grep -c "ndots" helm-charts/lunary/values.yaml
```
Expected: `OK: chart templates`; `single-request-reopen` count `0 (removed)`; `ndots` count `>=1` (kept).

- [ ] **Step 3: Commit and push**

```bash
git add helm-charts/lunary/values.yaml
git commit -m "lunary: drop single-request-reopen (race fixed by NodeLocal DNSCache); keep ndots"
git push origin main
```

- [ ] **Step 4: Verify lunary pods stay healthy**

Run (allow ~3 min):
```bash
kubectl -n default get pods -l app.kubernetes.io/name=lunary \
  -o jsonpath='{range .items[*]}{.metadata.name}{" restarts="}{.status.containerStatuses[0].restartCount}{"\n"}{end}'
```
Expected: backend + frontend pods `Running`, `restarts` not climbing. Confirm `tailnet.el-jefe.me`-suffixed names still resolve if the app uses them.

---

## Task 8: Final sweep and close-out

**Files:** none (verification + memory).

- [ ] **Step 1: Confirm no DNS workarounds remain in either repo**

Run:
```bash
grep -rn -E "use-vc|single-request-reopen|dnsPolicy: None|coredns-sidecar|jellyfin-coredns" \
  ~/GitHub_Projects/devops-portfolio-manager ~/GitHub_Projects/portfolio-orchestration-platform \
  --include=*.yaml 2>/dev/null || echo "CLEAN: no per-pod DNS workarounds remain"
```
Expected: `CLEAN: no per-pod DNS workarounds remain` (only `ndots`-based entries, which are search-suffix tuning, may persist intentionally).

- [ ] **Step 2: Confirm success criteria from the spec**

Run:
```bash
kubectl -n kube-system get ds node-local-dns
kubectl -n argocd get application nodelocaldns jellyfin -o wide
```
Expected: DaemonSet `4/4 Ready`; both Applications `Synced`/`Healthy`.

- [ ] **Step 3: Update memory**

Append a `project_` memory recording: NodeLocal DNSCache deployed transparently cluster-wide (link-local 169.254.20.10 + ClusterIP 10.43.0.10, force_tcp to kube-dns-upstream), the canary-then-fleet rollout, the retired per-pod hacks (jellyfin sidecar, embedding-adapter use-vc, lunary single-request-reopen), and the deferred Phase 3 (per-node CoreDNS for cold-miss locality). Cross-link `[[k3s-glibc-dns-conntrack-race-use-vc]]`, `[[project-jellyfin-k8s-dns-cache-sidecar]]`, `[[project-embedding-adapter-crashloop-dns]]`. Add the one-line pointer to `MEMORY.md`.

---

## Self-Review (completed by plan author)

- **Spec coverage:** Phase 1 deploy (Tasks 1–4), canary gate incl. iptables-nft proof + rollback rehearsal (Task 3), Phase 2 jellyfin (Task 5), embedding-adapter (Task 6), lunary — the third target the sweep surfaced (Task 7), rollback runbook (Task 1 Step 5 / ROLLBACK.md), GitOps app-of-apps wiring (Task 2). Deferred Phase 3 is explicitly out of scope and not tasked. ✅
- **Placeholder scan:** no TBD/TODO; every step has concrete YAML/commands. The `__PILLAR__CLUSTER__DNS__`/`__PILLAR__UPSTREAM__SERVERS__` tokens are intentional literals (documented), verified by Task 1 Step 6. ✅
- **Consistency:** link-local `169.254.20.10`, ClusterIP `10.43.0.10`, Service `kube-dns-upstream`, DaemonSet `node-local-dns`, canary node `vmi3115606`, and the `-upstreamsvc kube-dns-upstream` arg are used identically across all tasks. ✅
```
