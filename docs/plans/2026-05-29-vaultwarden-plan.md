# Vaultwarden Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a CNPG-backed (2-instance HA) Vaultwarden as the primary password vault on vmi2951245 with public TLS ingress, continuous PITR to Backblaze B2, three independent backup tracks, and a one-time migration of the existing ASUSTOR vault.

**Architecture:** Raw Kubernetes manifests under `k8s/vaultwarden/` synced by an ArgoCD Application (mirrors the `jellyfin` app). A dedicated CloudNativePG cluster provides Postgres; the Barman Cloud Plugin archives base backups + WAL to B2 for point-in-time recovery. The existing ASUSTOR SQLite instance is migrated in once, then left dormant as an off-cluster break-glass copy fed by a periodic export.

**Tech Stack:** Kubernetes (k3s), ArgoCD, CloudNativePG 1.29, Barman Cloud Plugin, Traefik, cert-manager (letsencrypt-prod), External Secrets Operator (Doppler), Velero (kopia FSB), Vaultwarden (Rust), pgloader.

**Spec:** `docs/plans/2026-05-29-vaultwarden-design.md`

**Confirmed cluster facts (gathered during planning):**
- App node: `vmi2951245` (node-agent present, Traefik replica co-located).
- StorageClass DB: `democratic-synology-iscsi-mp`; app `/data`: `local-path` (WaitForFirstConsumer + Retain).
- CrowdSec middleware ref: `kube-system-crowdsec-bouncer@kubernetescrd`.
- ESO store: `doppler-secret-store` (ClusterSecretStore, Valid).
- B2 endpoint: `https://s3.us-east-005.backblazeb2.com`, region `us-east-005`, bucket `k3s-velero-eljefe-backups`.
- CNPG image: `ghcr.io/cloudnative-pg/postgresql:17`. Velero server has `--default-volumes-to-fs-backup` (no per-volume annotation needed).
- ASUSTOR vault data: `/volume1/Docker/Vaultwarden/bw-data/` (`db.sqlite3` 2.86 MB, `rsa_key.pem`).

**Conventions for this plan:** Infrastructure work substitutes "verify resource absent → apply → verify healthy" for the TDD red/green cycle. Every apply is preceded by a `--dry-run=server` validation. Commit after each task. ArgoCD `autoSync` is enabled only at the end (Task 11) so we can stage and validate manifests on the branch first.

---

## File Structure

```
k8s/vaultwarden/
├─ namespace.yaml              # vaultwarden namespace (labeled for NetworkPolicy selectors)
├─ externalsecret-app.yaml     # ESO: ADMIN_TOKEN (+ optional SMTP) → vaultwarden-secrets
├─ externalsecret-b2.yaml      # ESO: B2 key for CNPG WAL → vaultwarden-b2-creds
├─ objectstore.yaml            # Barman Cloud ObjectStore → B2
├─ cnpg-cluster.yaml           # 2-instance CNPG cluster, plugin archiver
├─ cnpg-scheduledbackup.yaml   # daily plugin base backup
├─ pvc.yaml                    # local-path /data PVC (bound on vmi2951245)
├─ deployment.yaml             # Vaultwarden, pinned, Recreate
├─ service.yaml                # ClusterIP :80
├─ ingress.yaml                # vaultwarden.el-jefe.me + crowdsec + TLS
├─ networkpolicy.yaml          # default-deny + Traefik/PG/DNS allowances
├─ export-cronjob.yaml         # break-glass export → ASUSTOR NFS
└─ kustomization.yaml          # ties resources together, sync-wave annotations

gitops/applications/vaultwarden.yaml   # ArgoCD Application
helm-charts/barman-cloud-plugin/       # (Task 1) plugin install, OR k8s/barman-cloud-plugin/
k8s/backups/<weekly-offsite file>      # (Task 12) add vaultwarden to includedNamespaces
```

---

## Phase 0 — Prerequisites & discovery

### Task 1: Install the Barman Cloud Plugin

**Files:**
- Create: `k8s/barman-cloud-plugin/kustomization.yaml`
- Create: `gitops/applications/barman-cloud-plugin.yaml`

- [ ] **Step 1: Confirm the plugin is not already installed**

Run: `kubectl get pods -n cnpg-system | grep -i barman; kubectl get crd objectstores.barmancloud.cnpg.io`
Expected: no pods; `Error from server (NotFound)` for the CRD.

- [ ] **Step 2: Pin the plugin version compatible with CNPG 1.29**

Run: `kubectl -n cnpg-system get deploy cnpg-cloudnative-pg -o jsonpath='{.spec.template.spec.containers[0].image}'`
Expected: `ghcr.io/cloudnative-pg/cloudnative-pg:1.29.0`. Then check the plugin release notes for the matching tag (e.g. `v0.5.x`) at https://github.com/cloudnative-pg/plugin-barman-cloud/releases and record it.

- [ ] **Step 3: Create the kustomization referencing the upstream manifest**

`k8s/barman-cloud-plugin/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.5.0/manifest.yaml  # pin to the version recorded in Step 2
```

- [ ] **Step 4: Validate render**

Run: `kubectl kustomize k8s/barman-cloud-plugin/ | head -40`
Expected: renders a Deployment `barman-cloud` + `ObjectStore` CRD without error.

- [ ] **Step 5: Create the ArgoCD Application**

`gitops/applications/barman-cloud-plugin.yaml`:
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: barman-cloud-plugin
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/maxjeffwell/devops-portfolio-manager.git
    targetRevision: main
    path: k8s/barman-cloud-plugin
  destination:
    server: https://kubernetes.default.svc
    namespace: cnpg-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=false
      - ServerSideApply=true
```

- [ ] **Step 6: Apply (manual sync this prerequisite ahead of the app-of-apps)**

Run: `kubectl apply -f gitops/applications/barman-cloud-plugin.yaml && argocd app sync barman-cloud-plugin`
Expected: app `Synced/Healthy`; `kubectl get crd objectstores.barmancloud.cnpg.io` now exists; `kubectl get pods -n cnpg-system | grep barman` shows the plugin Running.

- [ ] **Step 7: Commit**

```bash
git add k8s/barman-cloud-plugin/ gitops/applications/barman-cloud-plugin.yaml
git commit -m "Install CNPG Barman Cloud Plugin for WAL archiving"
```

### Task 2: Provision the B2 application key and Doppler secrets

**Files:** none (external systems). Records values used by Tasks 3–4.

- [ ] **Step 1: Create a scoped B2 application key**

In Backblaze B2, create an application key restricted to bucket `k3s-velero-eljefe-backups` with read+write. Record `keyID` and `applicationKey`.

- [ ] **Step 2: Generate the Vaultwarden admin token (argon2-PHC)**

Run: `docker run --rm -it vaultwarden/server:latest /vaultwarden hash`
Enter a strong passphrase. Copy the full `$argon2id$...` string.

- [ ] **Step 3: Store all secrets in Doppler (project/config used by `doppler-secret-store`)**

Set these Doppler keys:
- `VAULTWARDEN_ADMIN_TOKEN` = the argon2 PHC string
- `VAULTWARDEN_B2_KEY_ID` = B2 keyID
- `VAULTWARDEN_B2_APP_KEY` = B2 applicationKey
- (optional) `VAULTWARDEN_SMTP_HOST/PORT/USERNAME/PASSWORD/FROM`

- [ ] **Step 4: Verify Doppler exposure**

Confirm the keys exist in the Doppler config that `doppler-secret-store` reads. (No cluster change yet — consumed in Tasks 3–4.)

---

## Phase 1 — Namespace & secrets

### Task 3: Namespace + app ExternalSecret

**Files:**
- Create: `k8s/vaultwarden/namespace.yaml`
- Create: `k8s/vaultwarden/externalsecret-app.yaml`

- [ ] **Step 1: Verify the namespace does not exist**

Run: `kubectl get ns vaultwarden`
Expected: `NotFound`.

- [ ] **Step 2: Write the namespace (labeled so NetworkPolicy `namespaceSelector` works)**

`k8s/vaultwarden/namespace.yaml`:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: vaultwarden
  labels:
    kubernetes.io/metadata.name: vaultwarden
```

- [ ] **Step 3: Write the app ExternalSecret**

`k8s/vaultwarden/externalsecret-app.yaml`:
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: vaultwarden-secrets
  namespace: vaultwarden
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: doppler-secret-store
    kind: ClusterSecretStore
  target:
    name: vaultwarden-secrets
    creationPolicy: Owner
  data:
    - secretKey: ADMIN_TOKEN
      remoteRef:
        key: VAULTWARDEN_ADMIN_TOKEN
```

- [ ] **Step 4: Server-side dry-run**

Run: `kubectl apply --dry-run=server -f k8s/vaultwarden/namespace.yaml -f k8s/vaultwarden/externalsecret-app.yaml`
Expected: both `created (server dry run)`, no schema errors.

- [ ] **Step 5: Apply and verify the Secret materializes**

Run: `kubectl apply -f k8s/vaultwarden/namespace.yaml -f k8s/vaultwarden/externalsecret-app.yaml && sleep 10 && kubectl -n vaultwarden get secret vaultwarden-secrets -o jsonpath='{.data.ADMIN_TOKEN}' | head -c 20`
Expected: base64 data printed (non-empty); `kubectl -n vaultwarden get externalsecret` shows `SecretSynced`.

- [ ] **Step 6: Commit**

```bash
git add k8s/vaultwarden/namespace.yaml k8s/vaultwarden/externalsecret-app.yaml
git commit -m "Add vaultwarden namespace and admin-token ExternalSecret"
```

### Task 4: B2 credentials ExternalSecret

**Files:**
- Create: `k8s/vaultwarden/externalsecret-b2.yaml`

- [ ] **Step 1: Write the ExternalSecret producing a secret in the shape the ObjectStore expects**

`k8s/vaultwarden/externalsecret-b2.yaml`:
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: vaultwarden-b2-creds
  namespace: vaultwarden
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: doppler-secret-store
    kind: ClusterSecretStore
  target:
    name: vaultwarden-b2-creds
    creationPolicy: Owner
  data:
    - secretKey: ACCESS_KEY_ID
      remoteRef:
        key: VAULTWARDEN_B2_KEY_ID
    - secretKey: ACCESS_SECRET_KEY
      remoteRef:
        key: VAULTWARDEN_B2_APP_KEY
```

- [ ] **Step 2: Apply and verify**

Run: `kubectl apply -f k8s/vaultwarden/externalsecret-b2.yaml && sleep 10 && kubectl -n vaultwarden get secret vaultwarden-b2-creds -o jsonpath='{.data.ACCESS_KEY_ID}' | head -c 12`
Expected: non-empty base64.

- [ ] **Step 3: Commit**

```bash
git add k8s/vaultwarden/externalsecret-b2.yaml
git commit -m "Add B2 credentials ExternalSecret for CNPG WAL archiving"
```

---

## Phase 2 — Database (CNPG + Barman → B2)

### Task 5: Barman Cloud ObjectStore

**Files:**
- Create: `k8s/vaultwarden/objectstore.yaml`

- [ ] **Step 1: Confirm the ObjectStore CRD fields**

Run: `kubectl explain objectstore.spec.configuration --recursive | head -40`
Expected: shows `destinationPath`, `endpointURL`, `s3Credentials`, `wal`, `data`, `retentionPolicy`. Adjust field names below if the installed plugin version differs.

- [ ] **Step 2: Write the ObjectStore**

`k8s/vaultwarden/objectstore.yaml`:
```yaml
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: vaultwarden-b2
  namespace: vaultwarden
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  retentionPolicy: "30d"
  configuration:
    destinationPath: "s3://k3s-velero-eljefe-backups/cnpg-vaultwarden"
    endpointURL: "https://s3.us-east-005.backblazeb2.com"
    s3Credentials:
      accessKeyId:
        name: vaultwarden-b2-creds
        key: ACCESS_KEY_ID
      secretAccessKey:
        name: vaultwarden-b2-creds
        key: ACCESS_SECRET_KEY
    wal:
      compression: gzip
    data:
      compression: gzip
```

- [ ] **Step 3: Dry-run and apply**

Run: `kubectl apply --dry-run=server -f k8s/vaultwarden/objectstore.yaml && kubectl apply -f k8s/vaultwarden/objectstore.yaml`
Expected: `objectstore.barmancloud.cnpg.io/vaultwarden-b2 created`.

- [ ] **Step 4: Commit**

```bash
git add k8s/vaultwarden/objectstore.yaml
git commit -m "Add Barman Cloud ObjectStore targeting Backblaze B2"
```

### Task 6: CNPG cluster (2-instance HA)

**Files:**
- Create: `k8s/vaultwarden/cnpg-cluster.yaml`

- [ ] **Step 1: Verify the cluster does not exist**

Run: `kubectl -n vaultwarden get cluster.postgresql.cnpg.io cnpg-vaultwarden`
Expected: `NotFound`.

- [ ] **Step 2: Write the Cluster manifest**

`k8s/vaultwarden/cnpg-cluster.yaml`:
```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: cnpg-vaultwarden
  namespace: vaultwarden
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  instances: 2
  imageName: ghcr.io/cloudnative-pg/postgresql:17
  primaryUpdateStrategy: unsupervised
  storage:
    storageClass: democratic-synology-iscsi-mp
    size: 5Gi
  affinity:
    enablePodAntiAffinity: true
    topologyKey: kubernetes.io/hostname
  bootstrap:
    initdb:
      database: vaultwarden
      owner: vaultwarden
  plugins:
    - name: barman-cloud.cloudnative-pg.io
      isWALArchiver: true
      parameters:
        barmanObjectName: vaultwarden-b2
```

- [ ] **Step 3: Dry-run, apply, wait for healthy**

Run:
```bash
kubectl apply --dry-run=server -f k8s/vaultwarden/cnpg-cluster.yaml
kubectl apply -f k8s/vaultwarden/cnpg-cluster.yaml
kubectl -n vaultwarden wait --for=condition=Ready cluster.postgresql.cnpg.io/cnpg-vaultwarden --timeout=600s
```
Expected: cluster reaches `Cluster in healthy state`; `kubectl -n vaultwarden get pods -l cnpg.io/cluster=cnpg-vaultwarden -o wide` shows 2 pods on **two different nodes**.

- [ ] **Step 4: Verify WAL archiving is working**

Run: `kubectl -n vaultwarden get cluster cnpg-vaultwarden -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")].status}'`
Expected: `True`. (If `False`, inspect `kubectl -n vaultwarden logs -l cnpg.io/cluster=cnpg-vaultwarden -c plugin-barman-cloud` for B2 auth/endpoint errors.)

- [ ] **Step 5: Confirm the app connection secret exists and inspect its keys**

Run: `kubectl -n vaultwarden get secret cnpg-vaultwarden-app -o go-template='{{range $k,$v := .data}}{{$k}} {{end}}'`
Expected: includes `username password`; if `uri` is present, the Deployment uses it directly (Task 8). If absent, use the compose-fallback noted in Task 8.

- [ ] **Step 6: Commit**

```bash
git add k8s/vaultwarden/cnpg-cluster.yaml
git commit -m "Add 2-instance CNPG cluster for vaultwarden with B2 WAL archiving"
```

### Task 7: Scheduled base backup

**Files:**
- Create: `k8s/vaultwarden/cnpg-scheduledbackup.yaml`

- [ ] **Step 1: Write the ScheduledBackup (plugin method)**

`k8s/vaultwarden/cnpg-scheduledbackup.yaml`:
```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: cnpg-vaultwarden-daily
  namespace: vaultwarden
spec:
  schedule: "0 0 1 * * *"   # 6-field CNPG cron: 01:00 daily
  backupOwnerReference: self
  cluster:
    name: cnpg-vaultwarden
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
```

- [ ] **Step 2: Apply and trigger a one-off backup to validate end-to-end**

Run:
```bash
kubectl apply -f k8s/vaultwarden/cnpg-scheduledbackup.yaml
kubectl -n vaultwarden create -f - <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: vaultwarden-proof-db
  namespace: vaultwarden
spec:
  cluster:
    name: cnpg-vaultwarden
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
EOF
kubectl -n vaultwarden wait --for=jsonpath='{.status.phase}'=completed backup/vaultwarden-proof-db --timeout=300s
```
Expected: backup `completed`; objects appear under `s3://k3s-velero-eljefe-backups/cnpg-vaultwarden/`.

- [ ] **Step 3: Commit**

```bash
git add k8s/vaultwarden/cnpg-scheduledbackup.yaml
git commit -m "Add daily CNPG base backup for vaultwarden"
```

---

## Phase 3 — Vaultwarden application manifests

### Task 8: PVC, Deployment, Service

**Files:**
- Create: `k8s/vaultwarden/pvc.yaml`, `k8s/vaultwarden/deployment.yaml`, `k8s/vaultwarden/service.yaml`

- [ ] **Step 1: Verify the current stable Vaultwarden tag against Docker Hub**

Run: `curl -s 'https://hub.docker.com/v2/repositories/vaultwarden/server/tags?page_size=20&name=alpine' | grep -oE '"name":"[0-9.]+-alpine"' | head`
Record the latest stable `X.Y.Z-alpine` and its digest. Use that exact tag below (per the tag-drift rule).

- [ ] **Step 2: Write the PVC**

`k8s/vaultwarden/pvc.yaml`:
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vaultwarden-data
  namespace: vaultwarden
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: local-path
  resources:
    requests:
      storage: 2Gi
```

- [ ] **Step 3: Write the Service**

`k8s/vaultwarden/service.yaml`:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: vaultwarden
  namespace: vaultwarden
spec:
  selector:
    app: vaultwarden
  ports:
    - name: http
      port: 80
      targetPort: 80
      protocol: TCP
```

- [ ] **Step 4: Write the Deployment (pinned, Recreate, DB wait initContainer)**

`k8s/vaultwarden/deployment.yaml` (replace `<TAG>` with the value from Step 1; if `cnpg-vaultwarden-app` lacked a `uri` key in Task 6 Step 5, use the compose-fallback block shown after):
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vaultwarden
  namespace: vaultwarden
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: vaultwarden
  template:
    metadata:
      labels:
        app: vaultwarden
    spec:
      nodeSelector:
        kubernetes.io/hostname: vmi2951245
      initContainers:
        - name: wait-for-db
          image: ghcr.io/cloudnative-pg/postgresql:17
          command:
            - sh
            - -c
            - 'until pg_isready -h cnpg-vaultwarden-rw -p 5432; do echo waiting; sleep 3; done'
      containers:
        - name: vaultwarden
          image: vaultwarden/server:<TAG>-alpine
          ports:
            - containerPort: 80
          env:
            - name: DOMAIN
              value: "https://vaultwarden.el-jefe.me"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: cnpg-vaultwarden-app
                  key: uri
            - name: SIGNUPS_ALLOWED
              value: "false"
            - name: INVITATIONS_ALLOWED
              value: "true"
            - name: ENABLE_WEBSOCKET
              value: "true"
            - name: SHOW_PASSWORD_HINT
              value: "false"
            - name: ADMIN_TOKEN
              valueFrom:
                secretKeyRef:
                  name: vaultwarden-secrets
                  key: ADMIN_TOKEN
          volumeMounts:
            - name: data
              mountPath: /data
          livenessProbe:
            httpGet:
              path: /alive
              port: 80
            initialDelaySeconds: 20
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /alive
              port: 80
            initialDelaySeconds: 10
            periodSeconds: 10
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 256Mi
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: vaultwarden-data
```

Compose-fallback for `DATABASE_URL` (only if `uri` key is absent) — replace the `DATABASE_URL` env entry with:
```yaml
            - name: DB_USER
              valueFrom:
                secretKeyRef: { name: cnpg-vaultwarden-app, key: username }
            - name: DB_PASS
              valueFrom:
                secretKeyRef: { name: cnpg-vaultwarden-app, key: password }
            - name: DATABASE_URL
              value: "postgresql://$(DB_USER):$(DB_PASS)@cnpg-vaultwarden-rw:5432/vaultwarden"
```

- [ ] **Step 5: Dry-run all three**

Run: `kubectl apply --dry-run=server -f k8s/vaultwarden/pvc.yaml -f k8s/vaultwarden/service.yaml -f k8s/vaultwarden/deployment.yaml`
Expected: all `created (server dry run)`.

- [ ] **Step 6: Apply and verify rollout + node placement**

Run:
```bash
kubectl apply -f k8s/vaultwarden/pvc.yaml -f k8s/vaultwarden/service.yaml -f k8s/vaultwarden/deployment.yaml
kubectl -n vaultwarden rollout status deploy/vaultwarden --timeout=180s
kubectl -n vaultwarden get pod -l app=vaultwarden -o wide
```
Expected: pod `Running` on `vmi2951245`; PVC `Bound`.

- [ ] **Step 7: Verify the app is up and DB-connected**

Run: `kubectl -n vaultwarden exec deploy/vaultwarden -- wget -qO- http://localhost:80/alive`
Expected: HTTP 200 (a timestamp body). Logs show `Rocket has launched` with no DB errors.

- [ ] **Step 8: Commit**

```bash
git add k8s/vaultwarden/pvc.yaml k8s/vaultwarden/service.yaml k8s/vaultwarden/deployment.yaml
git commit -m "Add Vaultwarden PVC, Deployment (pinned to vmi2951245), and Service"
```

### Task 9: Ingress + NetworkPolicy

**Files:**
- Create: `k8s/vaultwarden/ingress.yaml`, `k8s/vaultwarden/networkpolicy.yaml`

- [ ] **Step 1: Write the Ingress (mirrors jellyfin: crowdsec + letsencrypt-prod)**

`k8s/vaultwarden/ingress.yaml`:
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: vaultwarden
  namespace: vaultwarden
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.middlewares: kube-system-crowdsec-bouncer@kubernetescrd
    traefik.ingress.kubernetes.io/router.tls: "true"
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - vaultwarden.el-jefe.me
      secretName: vaultwarden-tls
  rules:
    - host: vaultwarden.el-jefe.me
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: vaultwarden
                port:
                  number: 80
```

- [ ] **Step 2: Write the NetworkPolicy (default-deny; Traefik in, DNS+PG out)**

`k8s/vaultwarden/networkpolicy.yaml`:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: vaultwarden
  namespace: vaultwarden
spec:
  podSelector:
    matchLabels:
      app: vaultwarden
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              app.kubernetes.io/name: traefik
      ports:
        - port: 80
          protocol: TCP
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - port: 80
          protocol: TCP
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    - to:
        - podSelector:
            matchLabels:
              cnpg.io/cluster: cnpg-vaultwarden
      ports:
        - port: 5432
          protocol: TCP
```

- [ ] **Step 3: Apply and verify TLS issuance**

Run:
```bash
kubectl apply -f k8s/vaultwarden/ingress.yaml -f k8s/vaultwarden/networkpolicy.yaml
kubectl -n vaultwarden get certificate vaultwarden-tls -w   # until READY=True (Ctrl-C when ready)
```
Expected: `vaultwarden-tls` becomes `Ready=True` within a few minutes.

- [ ] **Step 4: Verify external reachability**

Run: `curl -sI https://vaultwarden.el-jefe.me/alive`
Expected: HTTP 200, valid Let's Encrypt cert. (DNS for `vaultwarden.el-jefe.me` must point at the ingress — add the record if missing, mirroring other `*.el-jefe.me` hosts.)

- [ ] **Step 5: Commit**

```bash
git add k8s/vaultwarden/ingress.yaml k8s/vaultwarden/networkpolicy.yaml
git commit -m "Add Vaultwarden ingress (crowdsec+TLS) and default-deny NetworkPolicy"
```

### Task 10: Kustomization

**Files:**
- Create: `k8s/vaultwarden/kustomization.yaml`

- [ ] **Step 1: Write the kustomization listing all resources**

`k8s/vaultwarden/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: vaultwarden
resources:
  - namespace.yaml
  - externalsecret-app.yaml
  - externalsecret-b2.yaml
  - objectstore.yaml
  - cnpg-cluster.yaml
  - cnpg-scheduledbackup.yaml
  - pvc.yaml
  - deployment.yaml
  - service.yaml
  - ingress.yaml
  - networkpolicy.yaml
  - export-cronjob.yaml
```

- [ ] **Step 2: Validate the full render**

Run: `kubectl kustomize k8s/vaultwarden/ | kubectl apply --dry-run=server -f -`
Expected: every resource `configured/unchanged (server dry run)`, no errors. (Skip `export-cronjob.yaml` from `resources` until Task 13 creates it, or create a stub first — see Task 13.)

- [ ] **Step 3: Commit**

```bash
git add k8s/vaultwarden/kustomization.yaml
git commit -m "Add kustomization for vaultwarden app"
```

---

## Phase 4 — GitOps adoption

### Task 11: ArgoCD Application

**Files:**
- Create: `gitops/applications/vaultwarden.yaml`

- [ ] **Step 1: Write the Application (mirrors jellyfin.yaml ESO ignoreDifferences)**

`gitops/applications/vaultwarden.yaml`:
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: vaultwarden
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/maxjeffwell/devops-portfolio-manager.git
    targetRevision: main
    path: k8s/vaultwarden
  destination:
    server: https://kubernetes.default.svc
    namespace: vaultwarden
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
      - CreateNamespace=true
      - ServerSideApply=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
```

- [ ] **Step 2: Push the branch and merge to `main`**

```bash
git add gitops/applications/vaultwarden.yaml
git commit -m "Add ArgoCD Application for vaultwarden"
git push -u origin feat/vaultwarden
```
Open a PR and merge (ArgoCD tracks `main`).

- [ ] **Step 3: Verify ArgoCD adopts the live resources without churn**

Run: `argocd app get vaultwarden`
Expected: `Synced/Healthy`; because resources already exist and match, sync is a no-op (no recreate of CNPG/PVC).

---

## Phase 5 — Migration (real vault data — dedicated checkpoint)

> ⚠️ This phase touches the live vault. Take a fresh copy of the ASUSTOR data first and do not delete the source until verification passes.

### Task 12: Migrate ASUSTOR SQLite → CNPG Postgres

**Files:** none in-repo (operational runbook).

- [ ] **Step 1: Snapshot the source data (read-only copy)**

Run: `ssh 192.168.50.142 'cd /volume1/Docker/Vaultwarden/bw-data && tar czf /tmp/vw-migrate-$(date +%s).tgz db.sqlite3 rsa_key.pem attachments sends 2>/dev/null; ls -la /tmp/vw-migrate-*.tgz'`
Copy the tarball locally: `scp 192.168.50.142:/tmp/vw-migrate-*.tgz ./vw-source.tgz && tar xzf vw-source.tgz -C ./vw-source`

- [ ] **Step 2: Ensure the Postgres schema exists (Vaultwarden created it on first boot in Task 8)**

Run: `kubectl -n vaultwarden exec -it cnpg-vaultwarden-1 -- psql -U postgres -d vaultwarden -c '\dt' | head`
Expected: Vaultwarden tables present (e.g. `users`, `ciphers`, `organizations`). If empty, the app didn't migrate — restart it and recheck.

- [ ] **Step 3: Scale the app to zero during the load (avoid concurrent writes)**

Run: `kubectl -n vaultwarden scale deploy/vaultwarden --replicas=0`

- [ ] **Step 4: Load SQLite data into Postgres with pgloader (data-only)**

Port-forward the primary and run pgloader from a host that has it (or a one-off pod):
```bash
kubectl -n vaultwarden port-forward svc/cnpg-vaultwarden-rw 5432:5432 &
PF=$!
PGPASS=$(kubectl -n vaultwarden get secret cnpg-vaultwarden-app -o jsonpath='{.data.password}' | base64 -d)
cat > /tmp/vw.load <<EOF
LOAD DATABASE
  FROM sqlite:///$(pwd)/vw-source/db.sqlite3
  INTO postgresql://vaultwarden:${PGPASS}@127.0.0.1:5432/vaultwarden
  WITH data only, truncate, include no drop, reset sequences
  EXCLUDING TABLE NAMES MATCHING '__diesel_schema_migrations';
EOF
docker run --rm --network host -v /tmp/vw.load:/vw.load -v $(pwd)/vw-source:$(pwd)/vw-source dimitri/pgloader:latest pgloader /vw.load
kill $PF
```
Expected: pgloader summary reports rows copied for `users`, `ciphers`, etc., with 0 errors. (If FK ordering errors occur, re-run; pgloader retries within a transaction.)

- [ ] **Step 5: Carry over rsa_key + attachments into the K8s /data PVC**

```bash
POD=$(kubectl -n vaultwarden get pod -l app=vaultwarden -o name | head -1)   # app at 0 replicas → use a debug pod
kubectl -n vaultwarden run vw-copy --image=busybox --restart=Never --overrides='{"spec":{"nodeSelector":{"kubernetes.io/hostname":"vmi2951245"},"containers":[{"name":"vw-copy","image":"busybox","command":["sleep","600"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"vaultwarden-data"}}]}}'
kubectl -n vaultwarden wait --for=condition=Ready pod/vw-copy --timeout=60s
kubectl -n vaultwarden cp ./vw-source/rsa_key.pem vw-copy:/data/rsa_key.pem
kubectl -n vaultwarden cp ./vw-source/attachments vw-copy:/data/attachments 2>/dev/null || true
kubectl -n vaultwarden cp ./vw-source/sends vw-copy:/data/sends 2>/dev/null || true
kubectl -n vaultwarden delete pod vw-copy
```

- [ ] **Step 6: Scale the app back up and verify the migrated vault**

```bash
kubectl -n vaultwarden scale deploy/vaultwarden --replicas=1
kubectl -n vaultwarden rollout status deploy/vaultwarden --timeout=120s
```
Then in a browser at `https://vaultwarden.el-jefe.me`: log in with a **known existing account**, confirm vault items load, open one **attachment**, and confirm `/admin` opens with the admin token.
Expected: existing credentials work (rsa_key carried over → no forced re-login), items + attachment present.

- [ ] **Step 7: Set the ASUSTOR app to dormant break-glass**

Run: `ssh 192.168.50.142 'docker ps -a --format "{{.Names}} {{.Image}}" | grep -i vault'` to find the container name, then stop + disable autostart:
`ssh 192.168.50.142 'docker stop <name>; docker update --restart=no <name>'`
Expected: ASUSTOR instance stopped, will not auto-start. Its `bw-data` remains as the static pre-migration break-glass copy.

---

## Phase 6 — Backup wiring & proof

### Task 13: Break-glass export CronJob → ASUSTOR NFS

**Files:**
- Create: `k8s/vaultwarden/export-cronjob.yaml`

- [ ] **Step 1: Confirm an ASUSTOR NFS export path for break-glass dumps**

Run: `showmount -e 192.168.50.149 2>/dev/null | head` (or `.142`). Choose/confirm an export dir, e.g. `192.168.50.149:/volume1/backups/vaultwarden-breakglass`. Create it on the NAS if absent.

- [ ] **Step 2: Write the CronJob (pg_dump → NFS, weekly)**

`k8s/vaultwarden/export-cronjob.yaml`:
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: vaultwarden-breakglass-export
  namespace: vaultwarden
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  schedule: "0 4 * * 0"   # weekly Sun 04:00
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: export
              image: ghcr.io/cloudnative-pg/postgresql:17
              command:
                - sh
                - -c
                - 'pg_dump "$DATABASE_URL" -Fc -f /nfs/vaultwarden-$(date +%Y%m%d).dump && ls -la /nfs/ | tail -5'
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: cnpg-vaultwarden-app
                      key: uri
              volumeMounts:
                - name: nfs
                  mountPath: /nfs
          volumes:
            - name: nfs
              nfs:
                server: 192.168.50.149
                path: /volume1/backups/vaultwarden-breakglass
```

- [ ] **Step 2b: Allow NFS egress in the NetworkPolicy**

Add to `k8s/vaultwarden/networkpolicy.yaml` egress (the CronJob pod also matches `app: vaultwarden`? No — give the CronJob its own label or relax). Simplest: add a podSelector-less egress rule for NFS to the NAS IP. Append under `egress:`:
```yaml
    - to:
        - ipBlock:
            cidr: 192.168.50.149/32
      ports:
        - port: 2049
          protocol: TCP
```
(Also add the CronJob pod template label `app: vaultwarden` so the policy selects it — already implied if labeled; otherwise broaden `podSelector`.)

- [ ] **Step 3: Apply and run once manually**

```bash
kubectl apply -f k8s/vaultwarden/export-cronjob.yaml
kubectl -n vaultwarden create job --from=cronjob/vaultwarden-breakglass-export bg-test
kubectl -n vaultwarden wait --for=condition=complete job/bg-test --timeout=180s
```
Expected: job `Complete`; a `.dump` file is listed on the NFS path.

- [ ] **Step 4: Commit**

```bash
git add k8s/vaultwarden/export-cronjob.yaml k8s/vaultwarden/networkpolicy.yaml
git commit -m "Add break-glass export CronJob to ASUSTOR NFS + NFS egress"
```

### Task 14: Velero offsite inclusion + proof backup

**Files:**
- Modify: the `weekly-offsite` Schedule under `k8s/backups/`

- [ ] **Step 1: Locate the weekly-offsite manifest**

Run: `grep -rl "weekly-offsite" k8s/backups/`
Expected: one file. Open it.

- [ ] **Step 2: Add `vaultwarden` to `includedNamespaces`**

Edit the `spec.template.includedNamespaces` list to append `- vaultwarden` (alongside `default`, `lunary`, `monitoring`, etc.).

- [ ] **Step 3: Apply and verify the schedule**

Run: `kubectl apply -f k8s/backups/<file> && kubectl -n velero get schedule weekly-offsite -o jsonpath='{.spec.template.includedNamespaces}'`
Expected: list now contains `vaultwarden`.

- [ ] **Step 4: Run the proof Velero backup (FSB of /data)**

Run:
```bash
velero backup create vaultwarden-proof --include-namespaces vaultwarden --wait
velero backup describe vaultwarden-proof --details | grep -A5 "Restic\|Kopia\|Pod Volume"
```
Expected: `Completed`, and the `/data` (`vaultwarden-data`) volume appears in the pod-volume backup list (kopia). Confirms the `--default-volumes-to-fs-backup` path works for this namespace.

- [ ] **Step 5: Test-restore the DB into a throwaway namespace (recovery proof)**

```bash
kubectl create ns vw-restore-test
# Use CNPG bootstrap-from-backup (recovery) referencing the ObjectStore, OR restore the proof Backup.
# Minimal check: create a Cluster with bootstrap.recovery.source pointing at vaultwarden-b2 in vw-restore-test,
# wait Ready, then psql count rows in ciphers.
kubectl -n vw-restore-test exec cnpg-vw-restore-1 -- psql -U postgres -d vaultwarden -c 'select count(*) from ciphers;'
kubectl delete ns vw-restore-test
```
Expected: row count matches production (recovery from B2 works). Tear down the test namespace.

- [ ] **Step 6: Commit**

```bash
git add k8s/backups/<file>
git commit -m "Include vaultwarden namespace in Velero weekly offsite backup"
```

---

## Phase 7 — Finalization

### Task 15: Lock down signups & document operational runbook

- [ ] **Step 1: Confirm invitation-only is in effect**

In `/admin`, confirm "Allow new signups" is OFF and invitations are ON. Invite each intended user by email; if SMTP is unset, share the registration URL out-of-band and have them register the exact invited email.

- [ ] **Step 2: Verify all three backup tracks are green**

Run:
```bash
kubectl -n vaultwarden get cluster cnpg-vaultwarden -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")].status}{"\n"}'
kubectl -n vaultwarden get scheduledbackup cnpg-vaultwarden-daily
velero backup get | grep vaultwarden
kubectl -n vaultwarden get cronjob vaultwarden-breakglass-export
```
Expected: archiving `True`; scheduled backups present; Velero `vaultwarden-proof` Completed; cronjob scheduled.

- [ ] **Step 3: Record operational notes**

Append a short "Operations" section to the design doc (or a new `docs/runbooks/vaultwarden.md`): how to invite users, how to restore the DB from B2, how to start the ASUSTOR break-glass spare, and the rsa_key caveat.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "Add vaultwarden operations runbook"
```

---

## Self-Review notes (author)
- **Spec coverage:** plugin install (T1), B2/Doppler secrets (T2–T4), ObjectStore+CNPG+WAL (T5–T6), DB backup (T7), app+pinning+Recreate (T8), ingress+netpol (T9), kustomize (T10), ArgoCD+sync-waves (T11), migration+rsa_key+dormant ASUSTOR (T12), break-glass export (T13), Velero offsite+proof+restore test (T14), invitation lockdown (T15). All design sections mapped.
- **Known confirm-at-exec values:** Vaultwarden tag (T8 S1), ObjectStore CRD field names (T5 S1), `uri` vs compose DATABASE_URL (T6 S5 → T8 S4), ASUSTOR container name (T12 S7), ASUSTOR NFS export path (T13 S1), weekly-offsite filename (T14 S1).
- **Ordering:** secrets before ObjectStore before Cluster before app; migration only after the app boots once to create the schema; autoSync/merge (T11) after manifests validate on-branch.
