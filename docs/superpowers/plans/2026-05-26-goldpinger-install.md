# Goldpinger Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Bloomberg goldpinger v3.11.2 as a DaemonSet across all 4 K3s nodes (marmoset, debian-marmoset, vmi2951245, vmi3115606) with ServiceMonitor, 4 PrometheusRule alerts, Traefik ingress, and a NetworkPolicy — managed via a single ArgoCD Application.

**Architecture:** Direct YAML manifests under `k8s/goldpinger/` (no Helm wrapper). One ArgoCD Application at `gitops/applications/goldpinger.yaml` points at that directory with autoSync + selfHeal. Marmoset is brought into the ping mesh via an `nvidia.com/gpu:NoSchedule` toleration; egress is left unrestricted in the NetworkPolicy so goldpinger can reach every pod cluster-wide.

**Tech Stack:** K3s, ArgoCD (autoSync), kube-prom-stack (ServiceMonitor + PrometheusRule CRDs), Traefik (`networking.k8s.io/v1` Ingress with `kube-system-crowdsec-bouncer@kubernetescrd` middleware), cert-manager `letsencrypt-prod` ClusterIssuer.

**Spec:** `docs/superpowers/specs/2026-05-26-goldpinger-install-design.md` (commit `dda26c9`).

**Repo:** `/home/maxjeffwell/GitHub_Projects/devops-portfolio-manager` on branch `main` (or a feature branch — see Task 0).

---

## File Manifest

| Path | Purpose |
|---|---|
| `k8s/goldpinger/namespace.yaml` | `goldpinger` namespace with monitored=true label |
| `k8s/goldpinger/rbac.yaml` | ServiceAccount + ClusterRole (`pods:list`) + ClusterRoleBinding |
| `k8s/goldpinger/daemonset.yaml` | Per-node pod with tolerations + non-root securityContext |
| `k8s/goldpinger/service.yaml` | ClusterIP Service on port 80 → 8080 |
| `k8s/goldpinger/servicemonitor.yaml` | Prometheus scrape config |
| `k8s/goldpinger/prometheusrule.yaml` | 4 alert rules |
| `k8s/goldpinger/ingress.yaml` | `goldpinger.el-jefe.me` Ingress |
| `k8s/goldpinger/networkpolicy.yaml` | Ingress-restricted, egress unrestricted |
| `gitops/applications/goldpinger.yaml` | ArgoCD Application |

---

## Task 0: Branch + cluster reachability sanity check

**Files:** none yet.

- [ ] **Step 1: Create + check out feature branch**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git checkout main && git pull --ff-only
git checkout -b feat/goldpinger
```

- [ ] **Step 2: Confirm kubectl context and node count**

Run: `kubectl get nodes -o wide`
Expected: 4 nodes Ready (marmoset, debian-marmoset, vmi2951245, vmi3115606). If anything is NotReady, stop and triage — do not deploy goldpinger onto a degraded cluster.

- [ ] **Step 3: Confirm prerequisite CRDs are present**

Run:
```bash
kubectl get crd servicemonitors.monitoring.coreos.com prometheusrules.monitoring.coreos.com 2>&1 | grep -v -E "^NAME"
```
Expected: both CRDs listed. If either is missing, the ServiceMonitor / PrometheusRule tasks will fail at apply time — stop and resolve before continuing.

- [ ] **Step 4: Confirm the crowdsec-bouncer middleware exists**

Run: `kubectl -n kube-system get middleware crowdsec-bouncer -o name`
Expected: `middleware.traefik.io/crowdsec-bouncer`. If absent, the Ingress would reference a non-existent middleware → Traefik will reject the IngressRoute config. Resolve before Task 6.

---

## Task 1: Namespace + RBAC

**Files:**
- Create: `k8s/goldpinger/namespace.yaml`
- Create: `k8s/goldpinger/rbac.yaml`

- [ ] **Step 1: Write the namespace**

Create `k8s/goldpinger/namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: goldpinger
  labels:
    name: goldpinger
    app.kubernetes.io/name: goldpinger
    app.kubernetes.io/part-of: observability
```

- [ ] **Step 2: Validate the namespace manifest server-side**

Run: `kubectl apply --dry-run=server -f k8s/goldpinger/namespace.yaml`
Expected: `namespace/goldpinger created (server dry run)` (or `unchanged` if it already exists).

- [ ] **Step 3: Write the RBAC manifest**

Create `k8s/goldpinger/rbac.yaml`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: goldpinger
  namespace: goldpinger
  labels:
    app.kubernetes.io/name: goldpinger
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: goldpinger
  labels:
    app.kubernetes.io/name: goldpinger
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: goldpinger
  labels:
    app.kubernetes.io/name: goldpinger
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: goldpinger
subjects:
  - kind: ServiceAccount
    name: goldpinger
    namespace: goldpinger
```

- [ ] **Step 4: Validate RBAC server-side**

Run: `kubectl apply --dry-run=server -f k8s/goldpinger/rbac.yaml`
Expected: 3 lines, one per resource, all `created (server dry run)`. The namespace must exist first; if it doesn't, the SA dry-run will fail with `namespaces "goldpinger" not found` — apply the namespace for real first via `kubectl apply -f k8s/goldpinger/namespace.yaml`.

- [ ] **Step 5: Commit**

```bash
git add k8s/goldpinger/namespace.yaml k8s/goldpinger/rbac.yaml
git commit -m "feat(goldpinger): add namespace and RBAC"
```

---

## Task 2: DaemonSet

**Files:**
- Create: `k8s/goldpinger/daemonset.yaml`

- [ ] **Step 1: Write the DaemonSet**

Create `k8s/goldpinger/daemonset.yaml`:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: goldpinger
  namespace: goldpinger
  labels:
    app: goldpinger
    app.kubernetes.io/name: goldpinger
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  selector:
    matchLabels:
      app: goldpinger
  template:
    metadata:
      labels:
        app: goldpinger
        app.kubernetes.io/name: goldpinger
    spec:
      serviceAccountName: goldpinger
      hostNetwork: false
      dnsPolicy: ClusterFirst
      priorityClassName: system-cluster-critical
      tolerations:
        # Allow scheduling on marmoset (taint: workload=gpu:NoSchedule).
        # Taint key verified 2026-05-26; NOT nvidia.com/gpu.
        - key: workload
          operator: Equal
          value: gpu
          effect: NoSchedule
        # Forward-compat: if vmi2951245's PreferNoSchedule is ever upgraded
        # to NoSchedule, the DaemonSet still lands. Harmless no-op today.
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
        # Keep the pod alive briefly when its own node goes unhealthy
        # so it can observe the degradation before being evicted.
        - key: node.kubernetes.io/not-ready
          operator: Exists
          effect: NoExecute
          tolerationSeconds: 30
        - key: node.kubernetes.io/unreachable
          operator: Exists
          effect: NoExecute
          tolerationSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 2000
      containers:
        - name: goldpinger
          image: docker.io/bloomberg/goldpinger:v3.11.2
          imagePullPolicy: IfNotPresent
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          # Only HOST/PORT/HOSTNAME/POD_IP are documented as env-driven in the
          # upstream example. Other tunables (--refresh-interval, --ping-timeout,
          # --check-timeout, --check-all-timeout, --label-selector) are CLI flags;
          # defaults are sensible for a 4-node cluster. Add args: below if/when
          # tuning is needed (e.g. "args: ['--refresh-interval', '60s']").
          env:
            - name: HOST
              value: "0.0.0.0"
            - name: PORT
              value: "8080"
            - name: HOSTNAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
          ports:
            - name: http
              containerPort: 8080
              protocol: TCP
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 30
            timeoutSeconds: 5
            failureThreshold: 3
          resources:
            requests:
              cpu: 10m
              memory: 40Mi
            limits:
              cpu: 200m
              memory: 128Mi
```

- [ ] **Step 2: Validate the DaemonSet server-side**

Run: `kubectl apply --dry-run=server -f k8s/goldpinger/daemonset.yaml`
Expected: `daemonset.apps/goldpinger created (server dry run)`. If validation fails on PSA (PodSecurity admission), the `restricted` profile requirements (runAsNonRoot, drop ALL caps, readOnlyRootFilesystem) are already met in this manifest.

- [ ] **Step 3: Confirm tolerations match real node taints**

Run:
```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints}{"\n"}{end}'
```
Expected: marmoset shows `nvidia.com/gpu=:NoSchedule` (or similar); control-plane nodes show `node-role.kubernetes.io/control-plane:NoSchedule`. If any node has an additional taint (e.g. `PreferNoSchedule` from a pin you set), note it but do NOT add tolerations for `PreferNoSchedule` — it's an advisory taint and scheduling still works without a toleration.

- [ ] **Step 4: Commit**

```bash
git add k8s/goldpinger/daemonset.yaml
git commit -m "feat(goldpinger): add DaemonSet with marmoset GPU toleration"
```

---

## Task 3: Service

**Files:**
- Create: `k8s/goldpinger/service.yaml`

- [ ] **Step 1: Write the Service**

Create `k8s/goldpinger/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: goldpinger
  namespace: goldpinger
  labels:
    app: goldpinger
    app.kubernetes.io/name: goldpinger
spec:
  type: ClusterIP
  selector:
    app: goldpinger
  ports:
    - name: http
      port: 80
      targetPort: http
      protocol: TCP
```

Rationale: port 80 on the Service so the Ingress backend reference is the conventional HTTP port; `targetPort: http` resolves to the named `http` container port (8080).

- [ ] **Step 2: Validate the Service server-side**

Run: `kubectl apply --dry-run=server -f k8s/goldpinger/service.yaml`
Expected: `service/goldpinger created (server dry run)`.

- [ ] **Step 3: Commit**

```bash
git add k8s/goldpinger/service.yaml
git commit -m "feat(goldpinger): add ClusterIP Service"
```

---

## Task 4: ServiceMonitor

**Files:**
- Create: `k8s/goldpinger/servicemonitor.yaml`

- [ ] **Step 1: Confirm which monitoring namespace + selectors kube-prom uses**

Run:
```bash
kubectl get prometheus -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"\t"}serviceMonitorSelector={.spec.serviceMonitorSelector}{"\tns="}{.spec.serviceMonitorNamespaceSelector}{"\n"}{end}'
```
Expected: one Prometheus CR. Note its `serviceMonitorSelector` (often `{}` = match all labels) and `serviceMonitorNamespaceSelector` (often `{}` = match all namespaces). If either is restrictive, add the required labels to the ServiceMonitor in Step 2 BEFORE proceeding — otherwise it will be silently ignored. A frequent pin label is `release: kube-prometheus-stack`.

- [ ] **Step 2: Write the ServiceMonitor**

Create `k8s/goldpinger/servicemonitor.yaml` (adjust the `release:` label in Step 1 if your Prometheus pins by it):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: goldpinger
  namespace: goldpinger
  labels:
    app: goldpinger
    app.kubernetes.io/name: goldpinger
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: goldpinger
  namespaceSelector:
    matchNames:
      - goldpinger
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
```

- [ ] **Step 3: Validate ServiceMonitor server-side**

Run: `kubectl apply --dry-run=server -f k8s/goldpinger/servicemonitor.yaml`
Expected: `servicemonitor.monitoring.coreos.com/goldpinger created (server dry run)`.

- [ ] **Step 4: Commit**

```bash
git add k8s/goldpinger/servicemonitor.yaml
git commit -m "feat(goldpinger): add ServiceMonitor for Prometheus scrape"
```

---

## Task 5: PrometheusRule with 4 alerts

**Files:**
- Create: `k8s/goldpinger/prometheusrule.yaml`

- [ ] **Step 1: Write the PrometheusRule**

Create `k8s/goldpinger/prometheusrule.yaml`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: goldpinger
  namespace: goldpinger
  labels:
    app: goldpinger
    app.kubernetes.io/name: goldpinger
    release: kube-prometheus-stack
spec:
  groups:
    - name: goldpinger.connectivity
      interval: 30s
      rules:
        - alert: GoldpingerPeerUnreachable
          expr: |
            sum by (instance) (goldpinger_nodes_health_total{status="unhealthy"}) > 0
          for: 2m
          labels:
            severity: warning
            component: networking
          annotations:
            summary: "Goldpinger reports unreachable peer from {{ $labels.instance }}"
            description: |
              Pod {{ $labels.instance }} cannot reach one or more goldpinger
              peers. Investigate flannel/CNI on this node and any WG mesh peer
              connections. See runbook for the silent flannel.1 drop pattern.
            runbook_url: "https://github.com/maxjeffwell/devops-portfolio-manager/blob/main/docs/runbooks/flannel-watchdog.md"

        - alert: GoldpingerPeerUnreachableProlonged
          expr: |
            sum by (instance) (goldpinger_nodes_health_total{status="unhealthy"}) > 0
          for: 10m
          labels:
            severity: critical
            component: networking
          annotations:
            summary: "Goldpinger peer unreachable from {{ $labels.instance }} for >10m"
            description: |
              Sustained pod-network connectivity loss from {{ $labels.instance }}.
              The flannel watchdog should have remediated by now — manual triage required.

        - alert: GoldpingerPeerSlow
          expr: |
            histogram_quantile(0.99,
              sum by (le, source_node, destination_node) (
                rate(goldpinger_peers_response_time_s_bucket[5m])
              )
            ) > 0.1
          for: 5m
          labels:
            severity: warning
            component: networking
          annotations:
            summary: "Goldpinger p99 ping latency >100ms ({{ $labels.source_node }} → {{ $labels.destination_node }})"
            description: |
              The pod-network path from {{ $labels.source_node }} to
              {{ $labels.destination_node }} has p99 latency above 100ms for 5m.
              Check WG mesh, NIC saturation, and CPU pressure on either node.

        - alert: GoldpingerDNSFailure
          expr: |
            sum by (instance) (rate(goldpinger_dns_resolution_failures_total[5m])) > 0
          for: 2m
          labels:
            severity: warning
            component: networking
          annotations:
            summary: "Goldpinger DNS resolution failures on {{ $labels.instance }}"
            description: |
              CoreDNS resolution failing from {{ $labels.instance }}. This is
              the exact failure mode seen 2026-05-25 when flannel.1 dropped on
              vmi2951245 and starved its local CoreDNS replica.
```

- [ ] **Step 2: Validate PrometheusRule server-side**

Run: `kubectl apply --dry-run=server -f k8s/goldpinger/prometheusrule.yaml`
Expected: `prometheusrule.monitoring.coreos.com/goldpinger created (server dry run)`. Prometheus-operator validates rule syntax at apply time — if expressions are malformed, the dry-run will fail with `cannot parse expression`.

- [ ] **Step 3: Commit**

```bash
git add k8s/goldpinger/prometheusrule.yaml
git commit -m "feat(goldpinger): add PrometheusRule with 4 connectivity alerts"
```

---

## Task 6: Traefik Ingress

**Files:**
- Create: `k8s/goldpinger/ingress.yaml`

- [ ] **Step 1: Write the Ingress**

Create `k8s/goldpinger/ingress.yaml`:

```yaml
# Standard Ingress catches all traffic to goldpinger.el-jefe.me with the
# CrowdSec bouncer middleware (cluster-wide IP reputation filtering).
# cert-manager provisions goldpinger-tls automatically via the annotation.
# Mirrors the convention used by jellyfin-k8s.el-jefe.me and prometheus.el-jefe.me.
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: goldpinger
  namespace: goldpinger
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.middlewares: kube-system-crowdsec-bouncer@kubernetescrd
    traefik.ingress.kubernetes.io/router.tls: "true"
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - goldpinger.el-jefe.me
      secretName: goldpinger-tls
  rules:
    - host: goldpinger.el-jefe.me
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: goldpinger
                port:
                  number: 80
```

- [ ] **Step 2: Validate Ingress server-side**

Run: `kubectl apply --dry-run=server -f k8s/goldpinger/ingress.yaml`
Expected: `ingress.networking.k8s.io/goldpinger created (server dry run)`.

- [ ] **Step 3: Confirm a DNS A record exists for `goldpinger.el-jefe.me`**

Run: `dig +short goldpinger.el-jefe.me @1.1.1.1`
Expected: one or more IPs matching the existing pattern for other `*.el-jefe.me` records (likely your Traefik LB IP). If empty, add the DNS record at your DNS provider BEFORE merging — Traefik will route but cert-manager will fail the ACME HTTP-01 challenge without external DNS resolution, and the UI will be unreachable.

- [ ] **Step 4: Commit**

```bash
git add k8s/goldpinger/ingress.yaml
git commit -m "feat(goldpinger): add Traefik ingress at goldpinger.el-jefe.me"
```

---

## Task 7: NetworkPolicy

**Files:**
- Create: `k8s/goldpinger/networkpolicy.yaml`

- [ ] **Step 1: Write the NetworkPolicy**

Create `k8s/goldpinger/networkpolicy.yaml`:

```yaml
# Ingress-only NetworkPolicy. Egress is intentionally UNRESTRICTED:
# goldpinger's purpose is to ping every pod IP in the cluster plus resolve
# DNS — restricting egress would defeat the tool.
# Ingress is restricted to the namespaces that legitimately reach :8080:
#   - monitoring (Prometheus scrape)
#   - kube-system (Traefik ingress controller)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: goldpinger
  namespace: goldpinger
  labels:
    app: goldpinger
    app.kubernetes.io/name: goldpinger
spec:
  podSelector:
    matchLabels:
      app: goldpinger
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 8080
          protocol: TCP
    # Allow pod-to-pod within the goldpinger namespace itself so peers can
    # ping each other (relevant if goldpinger ever runs >1 pod per node).
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: goldpinger
      ports:
        - port: 8080
          protocol: TCP
```

- [ ] **Step 2: Confirm the `kubernetes.io/metadata.name` automatic namespace label is present**

Run:
```bash
kubectl get ns monitoring kube-system -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.kubernetes\.io/metadata\.name}{"\n"}{end}'
```
Expected: `monitoring  monitoring` and `kube-system  kube-system`. This label is auto-applied by the apiserver on K8s 1.21+ and K3s inherits it. If missing on K3s (rare), the NetworkPolicy will block legitimate traffic — add explicit labels (`kubectl label ns monitoring name=monitoring`) and update the selectors before continuing.

- [ ] **Step 3: Validate NetworkPolicy server-side**

Run: `kubectl apply --dry-run=server -f k8s/goldpinger/networkpolicy.yaml`
Expected: `networkpolicy.networking.k8s.io/goldpinger created (server dry run)`.

- [ ] **Step 4: Commit**

```bash
git add k8s/goldpinger/networkpolicy.yaml
git commit -m "feat(goldpinger): add NetworkPolicy (ingress-only, egress allow-all)"
```

---

## Task 8: ArgoCD Application

**Files:**
- Create: `gitops/applications/goldpinger.yaml`

- [ ] **Step 1: Write the ArgoCD Application**

Create `gitops/applications/goldpinger.yaml`:

```yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: goldpinger
  namespace: argocd
  labels:
    app: goldpinger
    infrastructure: "true"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
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

Rationale: single Application (no chart/resources split since there is no Helm chart). `CreateNamespace=false` because `namespace.yaml` is in the synced path. `prune: true` keeps the cluster aligned with the directory contents — if any of the 8 manifests are removed in Git, ArgoCD deletes them from the cluster.

- [ ] **Step 2: Validate Application server-side**

Run: `kubectl apply --dry-run=server -f gitops/applications/goldpinger.yaml`
Expected: `application.argoproj.io/goldpinger created (server dry run)`.

- [ ] **Step 3: Commit**

```bash
git add gitops/applications/goldpinger.yaml
git commit -m "feat(goldpinger): add ArgoCD Application"
```

---

## Task 9: Push, open PR, merge

**Files:** none.

- [ ] **Step 1: Push the branch**

Run: `git push -u origin feat/goldpinger`

- [ ] **Step 2: Open a PR**

Run:
```bash
gh pr create --title "feat(goldpinger): install Bloomberg goldpinger v3.11.2" --body "$(cat <<'EOF'
## Summary
- Adds Bloomberg goldpinger v3.11.2 as a DaemonSet across all 4 K3s nodes (marmoset, debian-marmoset, vmi2951245, vmi3115606)
- Marmoset is brought into the ping mesh via `nvidia.com/gpu:NoSchedule` toleration (otherwise GPU node would be a blind spot)
- 4 PrometheusRule alerts, ServiceMonitor, Traefik ingress at `goldpinger.el-jefe.me`, ingress-restricted NetworkPolicy
- Single ArgoCD Application; no Helm

## Why
Pod-network drift incidents this month (silent flannel.1 drop, WG mesh peer flaps, Tailscale micro-blips) were detected only when downstream apps broke. Goldpinger surfaces these via continuous N×N pod-to-pod pings within ~30s.

## Spec / Plan
- `docs/superpowers/specs/2026-05-26-goldpinger-install-design.md`
- `docs/superpowers/plans/2026-05-26-goldpinger-install.md`

## Test plan
- [ ] All 4 goldpinger pods reach Running, 1 per node
- [ ] `kubectl -n goldpinger exec ds/goldpinger -- wget -qO- localhost:8080/metrics | head` returns Prometheus exposition
- [ ] Prometheus `Status > Targets` shows 4 healthy goldpinger endpoints
- [ ] `goldpinger.el-jefe.me` UI loads with valid TLS cert, full 4-node graph
- [ ] Alertmanager `Status > Configuration` lists all 4 goldpinger alerts as `inactive`
EOF
)"
```

- [ ] **Step 3: Wait for merge, then pull**

After the PR is reviewed and merged:

```bash
git checkout main && git pull --ff-only
```

ArgoCD's autoSync will pick up the Application within ~3 minutes and create the workload.

---

## Task 10: Post-deploy verification

**Files:** none.

- [ ] **Step 1: Wait for ArgoCD to register the Application**

Run: `kubectl -n argocd get application goldpinger -o jsonpath='{.status.sync.status}{"\t"}{.status.health.status}{"\n"}'`
Expected (within ~3min of merge): `Synced  Healthy`. If `OutOfSync` or `Degraded`, run:

```bash
kubectl -n argocd describe application goldpinger | tail -50
```

- [ ] **Step 2: Confirm 4 DaemonSet pods Running**

Run: `kubectl -n goldpinger get pods -o wide`
Expected: 4 pods, one per node, all `Running` and `1/1 Ready`. If marmoset is missing, the `nvidia.com/gpu` toleration didn't take — re-check Task 2 Step 3 output.

- [ ] **Step 3: Spot-check `/metrics` from inside the cluster**

Run:
```bash
kubectl -n goldpinger exec ds/goldpinger -- wget -qO- localhost:8080/metrics | grep -E "^goldpinger_(peers|nodes|dns)" | head -20
```
Expected: lines like `goldpinger_peers_response_time_s_bucket{...}` and `goldpinger_nodes_health_total{...}`. If empty, the container hasn't completed its first ping cycle yet — wait 30s and retry.

- [ ] **Step 4: Confirm Prometheus is scraping**

Open `https://prometheus.el-jefe.me/targets` (or `kubectl -n monitoring port-forward svc/prometheus 9090:9090` if no ingress) and verify the `serviceMonitor/goldpinger/goldpinger/0` job shows 4 endpoints `UP`. If `0/4 UP`, check the `release:` label match — see Task 4 Step 1.

- [ ] **Step 5: Confirm alerts are loaded**

Open `https://prometheus.el-jefe.me/rules` and search for `Goldpinger`. Expected: all 4 alerts listed, all in `inactive` state. If missing, the PrometheusRule wasn't picked up — same `release:` label check applies.

- [ ] **Step 6: Smoke-test the UI**

Open `https://goldpinger.el-jefe.me` in a browser. Expected: graph view with 4 nodes (marmoset, debian-marmoset, vmi2951245, vmi3115606), all edges green. If TLS fails, check `kubectl -n goldpinger describe certificate goldpinger-tls` — cert-manager may still be solving the ACME challenge for the first ~2min after the Ingress is created.

- [ ] **Step 7: Provoke a synthetic alert (optional)**

To verify the alerting pipeline end-to-end:

```bash
# Cordon a non-critical node so its goldpinger pod gets evicted, then watch
# the remaining 3 pods report it as unhealthy. The peer-unreachable alert
# should fire within 2 min and then auto-resolve when you uncordon.
kubectl cordon vmi3115606  # or whichever non-critical node
kubectl -n goldpinger delete pod -l app=goldpinger --field-selector spec.nodeName=vmi3115606
# wait 2-3min, check Alertmanager UI for GoldpingerPeerUnreachable
kubectl uncordon vmi3115606
```

Expected: alert fires, then resolves within ~1min of uncordon. Skip this step if cluster is under user-facing load.

- [ ] **Step 8: Final commit (if any tuning was needed)**

If the `release:` label on ServiceMonitor / PrometheusRule needed adjustment during verification, commit the fix:

```bash
git add k8s/goldpinger/servicemonitor.yaml k8s/goldpinger/prometheusrule.yaml
git commit -m "fix(goldpinger): align release label with kube-prom selector"
git push origin main  # or via PR if main is protected
```

ArgoCD will reconcile within ~3min.

---

## Rollback

If anything goes sideways, removal is clean (goldpinger has zero state):

```bash
# Removes the Application + finalizer cascade deletes everything in k8s/goldpinger/
kubectl -n argocd delete application goldpinger
# Then revert the Git change
git revert <last-commit-sha> && git push origin main
```

The namespace is removed by the finalizer cascade. Nothing else depends on goldpinger; no PVCs, no Secrets, no downstream consumers.
