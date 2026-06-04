# CrowdSec LAPI In-Cluster Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ASUSTOR-hosted CrowdSec LAPI (`10.0.0.4:8080`, over WireGuard) with an in-cluster LAPI reached via a `ClusterIP` Service, so the Traefik bouncer and agents no longer depend on the flaky WG-to-NAS path.

**Architecture:** Add a single-replica LAPI `Deployment` + `ClusterIP` Service + mayastor SQLite PVC to the existing custom `monitoring` Helm chart (release `prometheus`, ns `monitoring`). The LAPI auto-registers the Traefik bouncer (`BOUNCER_KEY_traefik`) and the agent machine (`AGENT_USERNAME`/`AGENT_PASSWORD` on a LAPI instance). Repoint agents (`LOCAL_API_URL`) and both bouncer Middlewares (`crowdsecLapiHost`) to the in-cluster Service, add a LAPI-down alert, then decommission the NAS LAPI. Fail-open bouncer (PR #15) means traffic is never blocked during cutover.

**Tech Stack:** Helm (custom umbrella chart), CrowdSec `crowdsecurity/crowdsec:v1.7.6`, Traefik CrowdSec bouncer plugin, OpenEBS Mayastor (`mayastor-single-replica`), External Secrets (Doppler), kube-prometheus-stack + Alertmanager + gotify.

**Spec:** `docs/superpowers/specs/2026-06-03-crowdsec-lapi-in-cluster-migration-design.md`

**Branch:** `feat/crowdsec-lapi-in-cluster` (already created off `main`; the spec is committed there).

---

## Key facts (verified during design)

- Custom chart: Helm release **`prometheus`**, ns **`monitoring`**, chart `monitoring-1.0.0` at `helm-charts/monitoring/`. Deploy with `helm upgrade prometheus ./helm-charts/monitoring -n monitoring`. NOT ArgoCD/CI-managed.
- `monitoring` namespace has **no NetworkPolicy** (not default-deny) → no netpol task required.
- Agent creds secret `crowdsec-log-processor-credentials` (keys `username`, `password`) exists in `monitoring`.
- Bouncer key: Doppler `CROWDSEC_LAPI_KEY` → secret `crowdsec-bouncer-lapi-key` (key `lapi-key`). Currently synced into `kube-system` only; must also be synced into `monitoring` for the LAPI.
- CrowdSec env contract: `DISABLE_AGENT=true` (LAPI-only); `AGENT_USERNAME`/`AGENT_PASSWORD` on a LAPI **registers** that machine; `BOUNCER_KEY_<name>` registers a bouncer with that key; `DISABLE_ONLINE_API` disables CAPI (leave UNSET on the LAPI to keep the community blocklist).
- `mayastor-single-replica`: provisioner `io.openebs.csi-mayastor`, `protocol: nvmf`, `repl: 1`, RWO.
- Two bouncer Middlewares to repoint: `k8s/traefik/crowdsec-bouncer-middleware.yaml` (ns kube-system, `kubectl apply`-managed) and `k8s/jellyfin/crowdsec-bouncer-middleware.yaml` (ns jellyfin, ArgoCD-managed → via git/PR to `main`).

---

## File structure

**New (`helm-charts/monitoring/templates/`):**
- `crowdsec-lapi-pvc.yaml` — SQLite PVC (mayastor-single-replica)
- `crowdsec-lapi-externalsecret.yaml` — bouncer key ExternalSecret in `monitoring`
- `crowdsec-lapi-service.yaml` — ClusterIP Service (8080, 6060)
- `crowdsec-lapi-deployment.yaml` — LAPI Deployment
- `crowdsec-lapi-alerts.yaml` — PrometheusRule (`CrowdsecLapiDown`)

**Modified:**
- `helm-charts/monitoring/values.yaml` — add `crowdsec.lapi.*`; add `crowdsec.logProcessor.localApiUrl`
- `helm-charts/monitoring/templates/crowdsec-log-processor-daemonset.yaml` — templatize `LOCAL_API_URL`
- `k8s/traefik/crowdsec-bouncer-middleware.yaml` — `crowdsecLapiHost`
- `k8s/jellyfin/crowdsec-bouncer-middleware.yaml` — `crowdsecLapiHost`

**Decommission:** `asustor-observability-stack/docker-compose.yml` (separate repo)

---

## Task 1: Add LAPI chart values (disabled by default)

**Files:**
- Modify: `helm-charts/monitoring/values.yaml` (under the existing `crowdsec:` block)

- [ ] **Step 1: Add the `crowdsec.lapi` block and `localApiUrl` value**

Insert under `crowdsec:` (sibling of `logProcessor:`):

```yaml
  # In-cluster LAPI (replaces ASUSTOR 10.0.0.4:8080). See
  # docs/superpowers/specs/2026-06-03-crowdsec-lapi-in-cluster-migration-design.md
  lapi:
    enabled: false            # flipped to true in Task 4 after manifests validate
    image:
      repository: crowdsecurity/crowdsec
      tag: "v1.7.6"
    collections: "crowdsecurity/traefik crowdsecurity/linux"
    storage:
      storageClassName: mayastor-single-replica
      size: 1Gi
    resources:
      requests:
        cpu: 50m
        memory: 128Mi
      limits:
        memory: 256Mi
  logProcessor:
    # Existing keys stay; ADD this one (used in Task 5):
    localApiUrl: "http://crowdsec-lapi.monitoring.svc.cluster.local:8080"
```

- [ ] **Step 2: Verify YAML parses**

Run: `helm lint ./helm-charts/monitoring`
Expected: `0 chart(s) failed` (warnings about icon are fine).

- [ ] **Step 3: Commit**

```bash
git add helm-charts/monitoring/values.yaml
git commit -m "feat(crowdsec): add disabled crowdsec.lapi values + localApiUrl"
```

---

## Task 2: PVC + ExternalSecret + Service manifests

**Files:**
- Create: `helm-charts/monitoring/templates/crowdsec-lapi-pvc.yaml`
- Create: `helm-charts/monitoring/templates/crowdsec-lapi-externalsecret.yaml`
- Create: `helm-charts/monitoring/templates/crowdsec-lapi-service.yaml`

- [ ] **Step 1: Create the PVC**

`helm-charts/monitoring/templates/crowdsec-lapi-pvc.yaml`:

```yaml
{{- if .Values.crowdsec.lapi.enabled }}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: crowdsec-lapi-data
  namespace: {{ .Release.Namespace }}
  labels:
    app: crowdsec-lapi
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: {{ .Values.crowdsec.lapi.storage.storageClassName }}
  resources:
    requests:
      storage: {{ .Values.crowdsec.lapi.storage.size }}
{{- end }}
```

- [ ] **Step 2: Create the bouncer-key ExternalSecret in `monitoring`**

`helm-charts/monitoring/templates/crowdsec-lapi-externalsecret.yaml` (mirrors `k8s/external-secrets/crowdsec-bouncer-external-secret.yaml` but in this namespace):

```yaml
{{- if .Values.crowdsec.lapi.enabled }}
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: crowdsec-bouncer-lapi-key
  namespace: {{ .Release.Namespace }}
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: doppler-secret-store
  target:
    name: crowdsec-bouncer-lapi-key
    creationPolicy: Owner
    deletionPolicy: Retain
  data:
    - secretKey: lapi-key
      remoteRef:
        key: CROWDSEC_LAPI_KEY
{{- end }}
```

- [ ] **Step 3: Create the Service**

`helm-charts/monitoring/templates/crowdsec-lapi-service.yaml`:

```yaml
{{- if .Values.crowdsec.lapi.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: crowdsec-lapi
  namespace: {{ .Release.Namespace }}
  labels:
    app: crowdsec-lapi
spec:
  type: ClusterIP
  selector:
    app: crowdsec-lapi
  ports:
    - name: api
      port: 8080
      targetPort: 8080
    - name: metrics
      port: 6060
      targetPort: 6060
{{- end }}
```

- [ ] **Step 4: Verify they render (with the flag forced on)**

Run: `helm template prometheus ./helm-charts/monitoring -n monitoring --set crowdsec.lapi.enabled=true -s templates/crowdsec-lapi-pvc.yaml -s templates/crowdsec-lapi-service.yaml -s templates/crowdsec-lapi-externalsecret.yaml`
Expected: three valid manifests print; PVC `storageClassName: mayastor-single-replica`, Service has ports 8080/6060, ExternalSecret targets `crowdsec-bouncer-lapi-key`.

- [ ] **Step 5: Commit**

```bash
git add helm-charts/monitoring/templates/crowdsec-lapi-pvc.yaml helm-charts/monitoring/templates/crowdsec-lapi-externalsecret.yaml helm-charts/monitoring/templates/crowdsec-lapi-service.yaml
git commit -m "feat(crowdsec): LAPI PVC, bouncer-key ExternalSecret, ClusterIP Service"
```

---

## Task 3: LAPI Deployment manifest

**Files:**
- Create: `helm-charts/monitoring/templates/crowdsec-lapi-deployment.yaml`

- [ ] **Step 1: Create the Deployment**

`helm-charts/monitoring/templates/crowdsec-lapi-deployment.yaml`:

```yaml
{{- if .Values.crowdsec.lapi.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: crowdsec-lapi
  namespace: {{ .Release.Namespace }}
  labels:
    app: crowdsec-lapi
spec:
  replicas: 1
  strategy:
    type: Recreate          # single RWO volume; never two pods attached at once
  selector:
    matchLabels:
      app: crowdsec-lapi
  template:
    metadata:
      labels:
        app: crowdsec-lapi
    spec:
      containers:
        - name: crowdsec
          image: "{{ .Values.crowdsec.lapi.image.repository }}:{{ .Values.crowdsec.lapi.image.tag }}"
          ports:
            - name: api
              containerPort: 8080
            - name: metrics
              containerPort: 6060
          env:
            - name: DISABLE_AGENT          # LAPI only; the DaemonSet agents parse logs
              value: "true"
            - name: AGENT_USERNAME         # on a LAPI, this REGISTERS the agent machine
              valueFrom:
                secretKeyRef:
                  name: crowdsec-log-processor-credentials
                  key: username
            - name: AGENT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: crowdsec-log-processor-credentials
                  key: password
            - name: BOUNCER_KEY_traefik    # pre-registers the Traefik bouncer with its key
              valueFrom:
                secretKeyRef:
                  name: crowdsec-bouncer-lapi-key
                  key: lapi-key
            - name: COLLECTIONS
              value: "{{ .Values.crowdsec.lapi.collections }}"
            - name: CROWDSEC_BYPASS_DB_VOLUME_CHECK
              value: "true"
          volumeMounts:
            - name: lapi-data
              mountPath: /var/lib/crowdsec/data
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 20
          resources:
            {{- toYaml .Values.crowdsec.lapi.resources | nindent 12 }}
      volumes:
        - name: lapi-data
          persistentVolumeClaim:
            claimName: crowdsec-lapi-data
{{- end }}
```

- [ ] **Step 2: Render and validate**

Run: `helm template prometheus ./helm-charts/monitoring -n monitoring --set crowdsec.lapi.enabled=true -s templates/crowdsec-lapi-deployment.yaml`
Expected: valid Deployment; env has `DISABLE_AGENT`, `AGENT_USERNAME`, `BOUNCER_KEY_traefik`; `strategy.type: Recreate`; image `crowdsecurity/crowdsec:v1.7.6`.

- [ ] **Step 3: Server-side dry-run the rendered output**

Run: `helm template prometheus ./helm-charts/monitoring -n monitoring --set crowdsec.lapi.enabled=true -s templates/crowdsec-lapi-deployment.yaml -s templates/crowdsec-lapi-service.yaml -s templates/crowdsec-lapi-pvc.yaml | kubectl apply --dry-run=server -f -`
Expected: `created (server dry run)` for all three, no schema errors.

- [ ] **Step 4: Commit**

```bash
git add helm-charts/monitoring/templates/crowdsec-lapi-deployment.yaml
git commit -m "feat(crowdsec): in-cluster LAPI Deployment (LAPI-only, auto-registers bouncer+agent)"
```

---

## Task 4: Deploy the LAPI and verify it bootstraps

**Files:**
- Modify: `helm-charts/monitoring/values.yaml` (`crowdsec.lapi.enabled: false` → `true`)

- [ ] **Step 1: Enable the LAPI**

Set `crowdsec.lapi.enabled: true` in `helm-charts/monitoring/values.yaml`.

- [ ] **Step 2: Deploy**

Run: `helm upgrade prometheus ./helm-charts/monitoring -n monitoring`
Expected: `Release "prometheus" has been upgraded`. (If the chart has dependencies, run `helm dependency build ./helm-charts/monitoring` first.)

- [ ] **Step 3: Verify the pod is healthy**

Run: `kubectl rollout status deploy/crowdsec-lapi -n monitoring --timeout=120s`
Expected: `deployment "crowdsec-lapi" successfully rolled out`.
Run: `kubectl get pvc crowdsec-lapi-data -n monitoring`
Expected: `Bound`.

- [ ] **Step 4: Verify bouncer + agent registered and blocklist syncing**

Run: `kubectl exec -n monitoring deploy/crowdsec-lapi -- cscli bouncers list`
Expected: a bouncer named `traefik` is listed.
Run: `kubectl exec -n monitoring deploy/crowdsec-lapi -- cscli machines list`
Expected: the agent username (from `crowdsec-log-processor-credentials`) is listed and validated.
Run: `kubectl exec -n monitoring deploy/crowdsec-lapi -- cscli decisions list -a | head` (wait ~2 min for CAPI sync)
Expected: community blocklist decisions appear (non-empty). If empty, check `cscli capi status` — CAPI enrollment may need egress; see Risks.

- [ ] **Step 5: Commit**

```bash
git add helm-charts/monitoring/values.yaml
git commit -m "feat(crowdsec): enable in-cluster LAPI"
```

---

## Task 5: Repoint the agents to the in-cluster LAPI

**Files:**
- Modify: `helm-charts/monitoring/templates/crowdsec-log-processor-daemonset.yaml:48-49`

- [ ] **Step 1: Templatize `LOCAL_API_URL`**

Replace lines 48-49 (currently hardcoded `value: "http://10.0.0.4:8080"`):

```yaml
        - name: LOCAL_API_URL
          value: "{{ .Values.crowdsec.logProcessor.localApiUrl }}"
```

- [ ] **Step 2: Verify it renders to the in-cluster Service**

Run: `helm template prometheus ./helm-charts/monitoring -n monitoring -s templates/crowdsec-log-processor-daemonset.yaml | grep -A1 LOCAL_API_URL`
Expected: `value: "http://crowdsec-lapi.monitoring.svc.cluster.local:8080"`.

- [ ] **Step 3: Deploy and roll the agents**

Run: `helm upgrade prometheus ./helm-charts/monitoring -n monitoring`
Run: `kubectl rollout status ds/crowdsec-log-processor -n monitoring --timeout=120s`
Expected: rolled out.

- [ ] **Step 4: Verify agents connected to the new LAPI (no auth errors)**

Run: `kubectl logs -n monitoring ds/crowdsec-log-processor --tail=40 | grep -iE "lapi|push|auth|error" | tail`
Expected: connection/heartbeat to the in-cluster LAPI; no `401`/auth failures.
Run: `kubectl exec -n monitoring deploy/crowdsec-lapi -- cscli machines list`
Expected: agent machines show recent `last_update` / heartbeat.

- [ ] **Step 5: Commit**

```bash
git add helm-charts/monitoring/templates/crowdsec-log-processor-daemonset.yaml
git commit -m "feat(crowdsec): point agents at in-cluster LAPI service"
```

---

## Task 6: Repoint the Traefik bouncer (both Middlewares)

**Files:**
- Modify: `k8s/traefik/crowdsec-bouncer-middleware.yaml` (`crowdsecLapiHost`)
- Modify: `k8s/jellyfin/crowdsec-bouncer-middleware.yaml` (`crowdsecLapiHost`)

- [ ] **Step 1: Update both `crowdsecLapiHost` values**

In each file, change:
```yaml
      crowdsecLapiHost: "10.0.0.4:8080"
```
to:
```yaml
      crowdsecLapiHost: "crowdsec-lapi.monitoring.svc.cluster.local:8080"
```

- [ ] **Step 2: Validate both manifests**

Run: `kubectl apply --dry-run=client -f k8s/traefik/crowdsec-bouncer-middleware.yaml -f k8s/jellyfin/crowdsec-bouncer-middleware.yaml`
Expected: both `configured (dry run)`.

- [ ] **Step 3: Apply the kube-system Middleware (it is `kubectl apply`-managed, not ArgoCD)**

Run: `kubectl apply -f k8s/traefik/crowdsec-bouncer-middleware.yaml`
Expected: `middleware.traefik.io/crowdsec-bouncer configured`.
Run: `kubectl get middleware -n kube-system crowdsec-bouncer -o jsonpath='{.spec.plugin.crowdsec-bouncer.crowdsecLapiHost}{"\n"}'`
Expected: `crowdsec-lapi.monitoring.svc.cluster.local:8080`.

- [ ] **Step 4: Verify the bouncer reaches the LAPI and serving works**

Run: `kubectl exec -n kube-system deploy/traefik -c traefik -- sh -c 'wget -T 8 -qO- http://crowdsec-lapi.monitoring.svc.cluster.local:8080/health >/dev/null 2>&1 && echo REACHABLE || echo TIMEOUT'`
Expected: `REACHABLE` (this is the whole point — no WireGuard).
Run: `curl -sS -m 15 -o /dev/null -w "vaultwarden /api/config => HTTP %{http_code}\n" https://vaultwarden.el-jefe.me/api/config`
Expected: `HTTP 200`.

- [ ] **Step 5: Commit the jellyfin Middleware and open a PR (it is ArgoCD-managed, targetRevision `main`, selfHeal)**

```bash
git add k8s/traefik/crowdsec-bouncer-middleware.yaml k8s/jellyfin/crowdsec-bouncer-middleware.yaml
git commit -m "feat(crowdsec): repoint Traefik + jellyfin bouncers to in-cluster LAPI"
```

The jellyfin Middleware only takes effect once merged to `main` (ArgoCD selfHeal). The kube-system one is already live via Step 3. (PR is opened at the end, Task 9.)

---

## Task 7: Add LAPI-down alerting

**Files:**
- Create: `helm-charts/monitoring/templates/crowdsec-lapi-alerts.yaml`

- [ ] **Step 1: Create the PrometheusRule**

`helm-charts/monitoring/templates/crowdsec-lapi-alerts.yaml`:

```yaml
{{- if .Values.crowdsec.lapi.enabled }}
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: crowdsec-lapi-alerts
  namespace: {{ .Release.Namespace }}
  labels:
    release: prometheus        # matches kube-prometheus-stack ruleSelector
spec:
  groups:
    - name: crowdsec-lapi
      rules:
        - alert: CrowdsecLapiDown
          expr: kube_deployment_status_replicas_available{namespace="{{ .Release.Namespace }}",deployment="crowdsec-lapi"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "CrowdSec LAPI is down"
            description: "crowdsec-lapi has 0 available replicas for >5m. The Traefik bouncer is fail-open, so enforcement is silently OFF until this recovers."
{{- end }}
```

- [ ] **Step 2: Confirm the `release` label matches the Prometheus ruleSelector**

Run: `kubectl get prometheus -n monitoring -o jsonpath='{.items[0].spec.ruleSelector}{"\n"}'`
Expected: a `matchLabels` containing `release: prometheus` (adjust the label in Step 1 if the operator expects a different value).

- [ ] **Step 3: Deploy and verify the rule loads**

Run: `helm upgrade prometheus ./helm-charts/monitoring -n monitoring`
Run: `kubectl get prometheusrule -n monitoring crowdsec-lapi-alerts`
Expected: exists. After ~1 min, the rule appears in Prometheus (`/api/v1/rules`) — verify via the Prometheus UI or:
`kubectl exec -n monitoring prometheus-prometheus-kube-prometheus-prometheus-0 -c prometheus -- wget -qO- http://localhost:9090/api/v1/rules | grep -o CrowdsecLapiDown`
Expected: `CrowdsecLapiDown`.

- [ ] **Step 4: Functional test — scale LAPI to 0, confirm alert fires, restore**

Run: `kubectl scale deploy/crowdsec-lapi -n monitoring --replicas=0`
Wait 6 min, then check Alertmanager (or gotify) for `CrowdsecLapiDown` firing.
Run: `kubectl scale deploy/crowdsec-lapi -n monitoring --replicas=1`
Expected: alert clears after the LAPI is `Available` again. (Bouncer fail-open means no traffic impact during this test.)

- [ ] **Step 5: Commit**

```bash
git add helm-charts/monitoring/templates/crowdsec-lapi-alerts.yaml
git commit -m "feat(crowdsec): alert when in-cluster LAPI is down (fail-open is silent otherwise)"
```

---

## Task 8: Decommission the ASUSTOR LAPI

**Files:**
- Modify: `asustor-observability-stack/docker-compose.yml` (separate repo: `/home/maxjeffwell/GitHub_Projects/asustor-observability-stack`)

- [ ] **Step 1: Confirm nothing still points at `10.0.0.4:8080`**

Run: `grep -rn "10.0.0.4:8080" /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager 2>/dev/null`
Expected: no results (all repointed). Also:
Run: `kubectl get middleware -A -o yaml | grep -c "10.0.0.4:8080"`
Expected: `0`.

- [ ] **Step 2: Stop the ASUSTOR crowdsec container**

Run (interactive, needs ASUSTOR sudo): `! ssh maxjeffwell@192.168.50.142 'sudo docker stop crowdsec'`
Expected: `crowdsec` stopped. (Leave the container present, not removed, for quick rollback.)

- [ ] **Step 3: Comment out / remove the crowdsec service in compose**

In `asustor-observability-stack/docker-compose.yml`, comment out the `crowdsec:` service block (lines ~61-76) with a note pointing to this migration. Do not delete the volumes yet (rollback).

- [ ] **Step 4: Verify enforcement still works without the NAS LAPI**

Run: `curl -sS -m 15 -o /dev/null -w "HTTP %{http_code}\n" https://vaultwarden.el-jefe.me/api/config`
Expected: `HTTP 200`.
Run: `kubectl exec -n monitoring deploy/crowdsec-lapi -- cscli decisions list -a | head`
Expected: decisions present (served entirely in-cluster).

- [ ] **Step 5: Commit (asustor-observability-stack repo)**

```bash
cd /home/maxjeffwell/GitHub_Projects/asustor-observability-stack
git add docker-compose.yml
git commit -m "chore(crowdsec): decommission ASUSTOR LAPI (migrated in-cluster)"
```

---

## Task 9: Final verification and PR

- [ ] **Step 1: End-to-end checks**

- `kubectl get deploy,svc,pvc -n monitoring | grep crowdsec-lapi` → all healthy/Bound.
- `kubectl exec -n monitoring deploy/crowdsec-lapi -- cscli bouncers list` → `traefik` present, `valid`.
- `kubectl exec -n monitoring deploy/crowdsec-lapi -- cscli machines list` → agents heartbeating.
- From a Traefik pod: `/health` to the Service is `REACHABLE` (Task 6 Step 4).
- `curl https://vaultwarden.el-jefe.me/api/config` → 200; jellyfin login + podrick `/devops-api` reachable.
- Optional enforcement test: `kubectl exec -n monitoring deploy/crowdsec-lapi -- cscli decisions add --ip <a-test-IP-you-control> --duration 2m` then confirm that IP gets 403 within `updateIntervalSeconds`, and is allowed again after expiry.

- [ ] **Step 2: Push the branch and open the PR**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git push -u origin feat/crowdsec-lapi-in-cluster
gh pr create --base main --title "feat(crowdsec): migrate LAPI in-cluster (kill WireGuard-to-NAS dependency)" --body "Implements docs/superpowers/specs/2026-06-03-crowdsec-lapi-in-cluster-migration-design.md. In-cluster LAPI (mayastor SQLite, fresh start), repointed agents + bouncers, LAPI-down alert, ASUSTOR LAPI decommissioned. Fail-open bouncer meant zero traffic impact during cutover."
```

Note: the **jellyfin** Middleware change only takes effect on merge (ArgoCD selfHeal). The kube-system Middleware, the chart (`helm upgrade`), and the agents are already live from Tasks 4-7 — they are NOT gated on the PR merge.

---

## Risks & rollback

- **CAPI/community blocklist won't sync** (Task 4 Step 4 empty): the LAPI still serves locally-detected decisions; acceptable. If wanted, add the `api.crowdsec.net` host aliases (as in the ASUSTOR compose) or confirm egress DNS. The LAPI's `/etc/crowdsec` is ephemeral (only the DB PVC is persisted); CAPI re-enrolls each restart, which is harmless but noisy — if it becomes an issue, persist `/etc/crowdsec` via a second subPath of the PVC.
- **Bouncer key mismatch** (bouncer gets 403/401 from LAPI): confirm the `monitoring` ExternalSecret resolved the same Doppler `CROWDSEC_LAPI_KEY` as `kube-system`; `cscli bouncers list` shows the key's first chars.
- **Rollback at any step:** set `crowdsec.logProcessor.localApiUrl` and both Middlewares' `crowdsecLapiHost` back to `10.0.0.4:8080`, `helm upgrade` + `kubectl apply`, and `sudo docker start crowdsec` on the ASUSTOR. Fail-open means no outage during rollback. Set `crowdsec.lapi.enabled: false` to remove the in-cluster LAPI.
