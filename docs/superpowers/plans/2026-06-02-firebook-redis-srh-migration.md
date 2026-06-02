# Firebook Redis Migration (Upstash → in-cluster via SRH) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate firebook's cache from Upstash cloud Redis to the in-cluster `redis.default` by deploying an SRH (serverless-redis-http) adapter and repointing firebook's Firebase secrets — no firebook code changes.

**Architecture:** SRH pod in `default` ns speaks the Upstash REST API and proxies to `redis://:<pw>@redis:6379/1` (DB-1 isolation). Exposed at `firebook-redis.el-jefe.me` via Traefik ingress behind the Cloudflare Tunnel, authed by a bearer `SRH_TOKEN`. Firebook (Firebase Functions) keeps its `@upstash/redis` client; only its `UPSTASH_REDIS_REST_URL`/`TOKEN` secrets change.

**Tech Stack:** Kubernetes, ArgoCD (GitOps), Kustomize, External Secrets Operator + Doppler, Traefik, cert-manager, Cloudflare Tunnel, `hiett/serverless-redis-http`, Firebase CLI.

**Spec:** `docs/superpowers/specs/2026-06-02-firebook-redis-srh-migration-design.md`

**Working dir:** `/home/maxjeffwell/GitHub_Projects/devops-portfolio-manager` on branch `main` (the `firebook`/`network-policies` ArgoCD apps track `main`). This is **infra (apply-and-verify)**, not unit-tested code: each task creates a manifest, validates it, applies via commit→ArgoCD, and verifies in-cluster.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `k8s/firebook-redis-srh/external-secret.yaml` | create | ESO → K8s secret `firebook-redis-srh-secret` with `SRH_TOKEN` (from Doppler) |
| `k8s/firebook-redis-srh/deployment.yaml` | create | SRH pod; composes `SRH_CONNECTION_STRING` from `redis-secrets` password |
| `k8s/firebook-redis-srh/service.yaml` | create | `firebook-redis-srh` ClusterIP :80 |
| `k8s/firebook-redis-srh/ingress.yaml` | create | Traefik ingress `firebook-redis.el-jefe.me` → service, cert-manager TLS |
| `k8s/firebook-redis-srh/kustomization.yaml` | create | bundles the four above |
| `gitops/applications/firebook-redis-srh.yaml` | create | ArgoCD Application (path `k8s/firebook-redis-srh`, `main`) |

Doppler (external): add `FIREBOOK_SRH_TOKEN`. Firebase (external): update `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`.

---

## Task 1: Generate the SRH token and add it to Doppler

**Files:** none (external — Doppler).

- [ ] **Step 1: Generate a strong token**

Run:
```bash
openssl rand -hex 32
```
Expected: a 64-char hex string. Save it as `<SRH_TOKEN>` for the steps below.

- [ ] **Step 2: Add it to Doppler (the project/config feeding `doppler-secret-store`)**

The ClusterSecretStore `doppler-secret-store` reads from one Doppler project/config (the same one holding `CODE_TALK_*`). Add the key there:
```bash
# If doppler CLI is authed on marmoset (else add via the Doppler dashboard):
doppler secrets set FIREBOOK_SRH_TOKEN="<SRH_TOKEN>"
# confirm:
doppler secrets get FIREBOOK_SRH_TOKEN --plain
```
Expected: prints `<SRH_TOKEN>`. If the CLI isn't authed, add `FIREBOOK_SRH_TOKEN` via the Doppler dashboard to the project/config that backs `doppler-secret-store`.

- [ ] **Step 3: No commit** (secret value never enters Git).

---

## Task 2: Create the SRH ExternalSecret

**Files:**
- Create: `k8s/firebook-redis-srh/external-secret.yaml`

- [ ] **Step 1: Write the ExternalSecret**

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: firebook-redis-srh-external-secret
  namespace: default
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: doppler-secret-store
  target:
    name: firebook-redis-srh-secret
    creationPolicy: Owner
    deletionPolicy: Retain
  data:
    - remoteRef:
        key: FIREBOOK_SRH_TOKEN
      secretKey: SRH_TOKEN
```

- [ ] **Step 2: Validate YAML**

Run: `kubectl apply --dry-run=client -f k8s/firebook-redis-srh/external-secret.yaml`
Expected: `externalsecret.external-secrets.io/firebook-redis-srh-external-secret created (dry run)`.

---

## Task 3: Create the SRH Deployment

**Files:**
- Create: `k8s/firebook-redis-srh/deployment.yaml`

- [ ] **Step 1: Write the Deployment**

`SRH_CONNECTION_STRING` is composed from `REDIS_PASSWORD` using Kubernetes env var substitution (`$(VAR)` expands to an earlier env var in the same container). The password stays only in the existing `redis-secrets` secret.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: firebook-redis-srh
  namespace: default
  labels:
    app: firebook-redis-srh
spec:
  replicas: 1
  selector:
    matchLabels:
      app: firebook-redis-srh
  template:
    metadata:
      labels:
        app: firebook-redis-srh
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: srh
          image: hiett/serverless-redis-http:latest   # pin to a digest in Task 8
          imagePullPolicy: IfNotPresent
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          env:
            - name: SRH_MODE
              value: "env"
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: redis-secrets
                  key: redis-password
            # $(REDIS_PASSWORD) is expanded by Kubernetes from the env var above.
            # DB index 1 isolates firebook from code-talk's DB 0.
            - name: SRH_CONNECTION_STRING
              value: "redis://:$(REDIS_PASSWORD)@redis:6379/1"
            - name: SRH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: firebook-redis-srh-secret
                  key: SRH_TOKEN
          ports:
            - { name: http, containerPort: 80, protocol: TCP }
          resources:
            requests: { cpu: 25m, memory: 64Mi }
            limits:   { memory: 128Mi }
          readinessProbe:
            httpGet: { path: /, port: 80 }
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /, port: 80 }
            initialDelaySeconds: 10
            periodSeconds: 30
```

> Note: SRH serves HTTP on container port 80. `GET /` without a token returns 401 (a fast, dependency-free liveness signal that the process is up); that's an acceptable probe target.

- [ ] **Step 2: Validate YAML**

Run: `kubectl apply --dry-run=client -f k8s/firebook-redis-srh/deployment.yaml`
Expected: `deployment.apps/firebook-redis-srh created (dry run)`.

---

## Task 4: Create the Service

**Files:**
- Create: `k8s/firebook-redis-srh/service.yaml`

- [ ] **Step 1: Write the Service**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: firebook-redis-srh
  namespace: default
  labels:
    app: firebook-redis-srh
spec:
  selector:
    app: firebook-redis-srh
  ports:
    - { name: http, port: 80, targetPort: 80, protocol: TCP }
```

- [ ] **Step 2: Validate**

Run: `kubectl apply --dry-run=client -f k8s/firebook-redis-srh/service.yaml`
Expected: `service/firebook-redis-srh created (dry run)`.

---

## Task 5: Create the Ingress

**Files:**
- Create: `k8s/firebook-redis-srh/ingress.yaml`

Mirrors the sibling el-jefe.me ingresses (Traefik class, cert-manager `letsencrypt-prod`, cert-manager-provisioned TLS secret). **CrowdSec middleware is intentionally omitted** — Firebase Functions egress from dynamic Google IPs that CrowdSec could bounce; the SRH bearer token is the auth boundary.

- [ ] **Step 1: Write the Ingress**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: firebook-redis-srh-ingress
  namespace: default
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: traefik
  rules:
    - host: firebook-redis.el-jefe.me
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: firebook-redis-srh
                port:
                  number: 80
  tls:
    - hosts:
        - firebook-redis.el-jefe.me
      secretName: firebook-redis-srh-tls
```

- [ ] **Step 2: Validate**

Run: `kubectl apply --dry-run=client -f k8s/firebook-redis-srh/ingress.yaml`
Expected: `ingress.networking.k8s.io/firebook-redis-srh-ingress created (dry run)`.

---

## Task 6: Create the Kustomization

**Files:**
- Create: `k8s/firebook-redis-srh/kustomization.yaml`

- [ ] **Step 1: Write it**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: default
resources:
  - external-secret.yaml
  - deployment.yaml
  - service.yaml
  - ingress.yaml
```

- [ ] **Step 2: Validate the bundle renders**

Run: `kubectl kustomize k8s/firebook-redis-srh`
Expected: prints all four resources, no errors.

---

## Task 7: Create the ArgoCD Application

**Files:**
- Create: `gitops/applications/firebook-redis-srh.yaml`

- [ ] **Step 1: Write the Application** (mirrors `gitops/applications/ovms.yaml`, but tracks `main`)

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: firebook-redis-srh
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/maxjeffwell/devops-portfolio-manager.git
    targetRevision: main
    path: k8s/firebook-redis-srh
  destination:
    server: https://kubernetes.default.svc
    namespace: default
  ignoreDifferences:
    - group: external-secrets.io
      kind: ExternalSecret
      jqPathExpressions:
        - .spec.data[].remoteRef.conversionStrategy
        - .spec.data[].remoteRef.decodingStrategy
        - .spec.data[].remoteRef.metadataPolicy
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - ServerSideApply=true
    retry:
      limit: 5
      backoff: { duration: 5s, factor: 2, maxDuration: 3m }
```

- [ ] **Step 2: Confirm the app-of-apps will pick it up**

Run: `grep -rn 'applications' gitops/ | grep -iE 'directory|recurse|path' | head`
Expected: confirms `gitops/applications` is synced as a directory (the `app-of-apps` ArgoCD app). If app-of-apps does NOT auto-recurse, `kubectl apply -f gitops/applications/firebook-redis-srh.yaml` once to bootstrap.

---

## Task 8: Commit, deploy, verify in-cluster

**Files:** none (commit + verify).

- [ ] **Step 1: Pin the SRH image to a digest**

Run:
```bash
docker pull hiett/serverless-redis-http:latest
docker inspect --format='{{index .RepoDigests 0}}' hiett/serverless-redis-http:latest
```
Edit `deployment.yaml` `image:` to the `hiett/serverless-redis-http@sha256:...` digest from the output (reproducible pin).

- [ ] **Step 2: Commit + push**

```bash
git add k8s/firebook-redis-srh/ gitops/applications/firebook-redis-srh.yaml
git commit -m "feat: firebook-redis-srh (Upstash-compatible adapter -> in-cluster redis DB1)"
git pull --rebase --ff-only
git push origin main
```

- [ ] **Step 3: Wait for ArgoCD sync + pod ready**

```bash
kubectl annotate application app-of-apps -n argocd argocd.argoproj.io/refresh=hard --overwrite
# wait for the new app, then the pod:
kubectl rollout status deploy/firebook-redis-srh -n default --timeout=120s
```
Expected: `deployment "firebook-redis-srh" successfully rolled out`. Also confirm the secret exists: `kubectl get secret firebook-redis-srh-secret -n default` (created by ESO).

- [ ] **Step 4: Verify SRH → Redis DB 1 round-trip (in-cluster)**

```bash
POD=$(kubectl get pod -n default -l app=firebook-redis-srh -o jsonpath='{.items[0].metadata.name}')
TOKEN=$(kubectl get secret firebook-redis-srh-secret -n default -o jsonpath='{.data.SRH_TOKEN}' | base64 -d)
kubectl exec -n default "$POD" -- sh -c "wget -qO- --header='Authorization: Bearer $TOKEN' --post-data='[\"SET\",\"srh:smoketest\",\"ok\"]' http://localhost:80/ ; echo; wget -qO- --header='Authorization: Bearer $TOKEN' --post-data='[\"GET\",\"srh:smoketest\"]' http://localhost:80/; echo"
```
Expected: SET returns `{"result":"OK"}`, GET returns `{"result":"ok"}`.

> **If SET/GET errors with a connection failure to `redis:6379`** (timeout/ECONNREFUSED): the `default-deny-all` egress policy is blocking SRH→Redis. The existing `allow-redis-external` (egress :6379 → 0.0.0.0/0, `podSelector: {}`) *should* cover it; if it doesn't, add `k8s/network-policies/allow-firebook-srh-egress.yaml` — egress from `app=firebook-redis-srh` to port 6379 + DNS (UDP/TCP 53) — and to `k8s/firebook-redis-srh/kustomization.yaml`. Likewise, if Task 9 can't reach the pod, confirm `allow-traefik-ingress` selects this pod; add an ingress allow if not.

- [ ] **Step 5: Confirm the key landed in DB 1 (not DB 0)**

```bash
RPOD=$(kubectl get pod -n default -l app=redis -o jsonpath='{.items[0].metadata.name}')
RPW=$(kubectl get secret redis-secrets -n default -o jsonpath='{.data.redis-password}' | base64 -d)
kubectl exec -n default "$RPOD" -- redis-cli -a "$RPW" -n 1 GET srh:smoketest      # => "ok"
kubectl exec -n default "$RPOD" -- redis-cli -a "$RPW" -n 0 GET srh:smoketest      # => (nil)
```
Expected: DB 1 returns `ok`, DB 0 returns `(nil)` — isolation confirmed. Clean up: `redis-cli -a "$RPW" -n 1 DEL srh:smoketest`.

---

## Task 9: Verify public reachability (Cloudflare Tunnel routing)

**Files:** none.

- [ ] **Step 1: Test the public endpoint**

Run (from anywhere with internet; `<SRH_TOKEN>` is the value from Task 1):
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://firebook-redis.el-jefe.me/    # expect 401 (up, needs token)
curl -s -X POST https://firebook-redis.el-jefe.me/ \
  -H "Authorization: Bearer <SRH_TOKEN>" -d '["PING"]'                          # expect {"result":"PONG"}
```
Expected: `401` unauthenticated, `{"result":"PONG"}` with the token.

- [ ] **Step 2: If it does NOT resolve/route (timeout or Cloudflare error)**

The tunnel is token-managed (routing in the Cloudflare dashboard). Add a **public hostname** to the `cloudflared-ai-gateway` tunnel:
`firebook-redis.el-jefe.me` → service `https://traefik.kube-system` (or the same target the existing `*-k8s.el-jefe.me` hostnames use — copy an existing entry). Add the matching DNS record (Cloudflare auto-creates it for tunnel hostnames). This is a **Cloudflare dashboard / API** action; if a Cloudflare API token is available (`cloudflare-external-secret`), it can be scripted, else do it in the Zero Trust dashboard. Re-run Step 1 until it returns `{"result":"PONG"}`.

---

## Task 10: Firebase cutover

**Files:** none (external — Firebase project `bookmarks-capstone-api`).

- [ ] **Step 1: Confirm firebase CLI auth on marmoset**

Run: `firebase projects:list 2>&1 | head` (or via `! firebase projects:list` if it needs interactive auth).
Expected: lists the project backing `bookmarks-capstone-api`. If not authed: `! firebase login` in the session.

- [ ] **Step 2: Set the two secrets to the SRH endpoint**

```bash
cd /home/maxjeffwell/GitHub_Projects/bookmarks-capstone-api
printf 'https://firebook-redis.el-jefe.me' | firebase functions:secrets:set UPSTASH_REDIS_REST_URL --data-file=-
printf '<SRH_TOKEN>'                        | firebase functions:secrets:set UPSTASH_REDIS_REST_TOKEN --data-file=-
```
Expected: each prints a new secret version created.

- [ ] **Step 3: Redeploy the functions to pick up the new secret versions**

```bash
firebase deploy --only functions
```
Expected: deploy completes; functions now bound to the new secret versions.

- [ ] **Step 4: Verify end-to-end**

Exercise firebook (hit an endpoint that caches URL metadata, or use the app), then:
```bash
RPOD=$(kubectl get pod -n default -l app=redis -o jsonpath='{.items[0].metadata.name}')
RPW=$(kubectl get secret redis-secrets -n default -o jsonpath='{.data.redis-password}' | base64 -d)
kubectl exec -n default "$RPOD" -- redis-cli -a "$RPW" -n 1 --scan | head    # firebook cache keys appear in DB 1
```
Expected: firebook cache keys (e.g. metadata keys) appear in DB 1. Confirm no errors in `firebase functions:log` and that the Upstash cloud dashboard shows traffic dropping to zero.

- [ ] **Step 5: Rollback (only if needed)**

```bash
# revert the two secrets to the original Upstash values, then redeploy:
printf '<ORIGINAL_UPSTASH_URL>'   | firebase functions:secrets:set UPSTASH_REDIS_REST_URL --data-file=-
printf '<ORIGINAL_UPSTASH_TOKEN>' | firebase functions:secrets:set UPSTASH_REDIS_REST_TOKEN --data-file=-
firebase deploy --only functions
```
> Capture the ORIGINAL Upstash URL/token **before** Step 2 (`firebase functions:secrets:access UPSTASH_REDIS_REST_URL`) so rollback is possible. No data to unwind (cache).

---

## Out of Scope / Follow-ups
- Decommission the Upstash cloud Redis instance once stable (separate cleanup).
- Optional: Cloudflare Access service-token in front of the endpoint (deferred — `@upstash/redis` sends only a bearer token).
- code-talk also references Upstash (`CODE_TALK_UPSTASH_*`) — a separate migration if desired.
