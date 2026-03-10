# Pyroscope Continuous Profiling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy Grafana Pyroscope for continuous CPU profiling with eBPF collection via Alloy, Garage S3 storage, and Grafana integration.

**Architecture:** Pyroscope monolithic StatefulSet on control plane node, Alloy's `pyroscope.ebpf` component collects CPU profiles via eBPF and forwards to Pyroscope via HTTP. Profiles stored in Garage S3 bucket `pyroscope-profiles`. Same patterns as Tempo deployment.

**Tech Stack:** Grafana Pyroscope 1.18.1, Grafana Alloy (pyroscope.ebpf), Garage S3, Helm, K3s

---

### Task 1: Add Pyroscope Values to values.yaml

**Context:** Add a `pyroscope` values section following the exact same pattern as `tempoMonolithic` (lines 48-86). This goes after the `tempoRedis` section (after line 103) and before the `ingress` section.

**Files:**
- Modify: `helm-charts/monitoring/values.yaml` — insert after line 103 (after `tempoRedis` block)

**Step 1: Add the pyroscope values block**

Insert this block between the `tempoRedis` section and the `# Custom Ingress Configuration` comment:

```yaml
# Pyroscope - Continuous profiling (monolithic mode, Garage S3 backend)
pyroscope:
  enabled: true
  image:
    repository: grafana/pyroscope
    tag: "1.18.1"
  priorityClassName: monitoring
  nodeSelector:
    kubernetes.io/hostname: vmi2951245
  resources:
    requests:
      cpu: 100m
      memory: 512Mi
    limits:
      memory: 2Gi
  persistence:
    storageClass: local-path
    size: 20Gi
  storage:
    credentialsSecret: garage-pyroscope-credentials
    s3:
      endpoint: garage.monitoring.svc.cluster.local:3900
      bucket: pyroscope-profiles
      insecure: true
      region: garage
  serviceMonitor:
    enabled: true
```

**Step 2: Add Pyroscope Grafana datasource**

In the `additionalDataSources` list (after the Tempo datasource entry, around line 237), add:

```yaml
      - name: Pyroscope
        type: grafana-pyroscope-datasource
        uid: pyroscope
        access: proxy
        url: http://pyroscope.monitoring.svc.cluster.local:4040
        editable: true
        isDefault: false
```

**Step 3: Verify template renders**

Run:
```bash
helm template prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml > /dev/null 2>&1 && echo "OK" || echo "TEMPLATE ERROR"
```
Expected: `OK`

**Step 4: Commit**

```bash
git add helm-charts/monitoring/values.yaml
git commit -m "feat(pyroscope): add values for Pyroscope monolithic + Grafana datasource"
```

---

### Task 2: Create Pyroscope ExternalSecret

**Context:** Garage S3 credentials for the `pyroscope-profiles` bucket, sourced from Doppler. Mirrors `tempo-externalsecret.yaml` exactly.

**Files:**
- Create: `helm-charts/monitoring/templates/pyroscope-externalsecret.yaml`

**Step 1: Create the ExternalSecret template**

```yaml
{{- if .Values.pyroscope.enabled }}
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: pyroscope-external-secret
  namespace: {{ .Release.Namespace }}
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: doppler-secret-store
    kind: ClusterSecretStore
  target:
    name: garage-pyroscope-credentials
    creationPolicy: Owner
  data:
    - secretKey: accessKeyId
      remoteRef:
        key: GARAGE_PYROSCOPE_ACCESS_KEY_ID
    - secretKey: secretAccessKey
      remoteRef:
        key: GARAGE_PYROSCOPE_SECRET_ACCESS_KEY
{{- end }}
```

**Step 2: Verify template renders**

Run:
```bash
helm template prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml --show-only templates/pyroscope-externalsecret.yaml 2>&1
```
Expected: Clean YAML output with the ExternalSecret.

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/pyroscope-externalsecret.yaml
git commit -m "feat(pyroscope): add ExternalSecret for Garage S3 credentials"
```

---

### Task 3: Create Pyroscope ConfigMap

**Context:** Pyroscope server configuration. Uses `-config.expand-env=true` so `${accessKeyId}` and `${secretAccessKey}` are resolved from the secret environment variables at runtime (same pattern as Tempo).

**Files:**
- Create: `helm-charts/monitoring/templates/pyroscope-configmap.yaml`

**Step 1: Create the ConfigMap template**

```yaml
{{- if .Values.pyroscope.enabled }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: pyroscope-config
  labels:
    app.kubernetes.io/name: pyroscope
    app.kubernetes.io/component: monolithic
data:
  config.yaml: |
    target: all

    server:
      http_listen_port: 4040
      log_level: info

    storage:
      backend: s3
      s3:
        bucket_name: {{ .Values.pyroscope.storage.s3.bucket }}
        endpoint: {{ .Values.pyroscope.storage.s3.endpoint }}
        access_key_id: ${accessKeyId}
        secret_access_key: ${secretAccessKey}
        insecure: {{ .Values.pyroscope.storage.s3.insecure }}
        region: {{ .Values.pyroscope.storage.s3.region }}
{{- end }}
```

**Step 2: Verify template renders**

Run:
```bash
helm template prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml --show-only templates/pyroscope-configmap.yaml 2>&1
```
Expected: Clean YAML with S3 config populated from values.

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/pyroscope-configmap.yaml
git commit -m "feat(pyroscope): add ConfigMap with S3 storage config"
```

---

### Task 4: Create Pyroscope StatefulSet

**Context:** Mirrors the Tempo StatefulSet pattern exactly — GOMEMLIMIT, config checksum annotation, envFrom for S3 credentials, health probes, PVC.

**Files:**
- Create: `helm-charts/monitoring/templates/pyroscope-statefulset.yaml`

**Step 1: Create the StatefulSet template**

```yaml
{{- if .Values.pyroscope.enabled }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: pyroscope
  labels:
    app.kubernetes.io/name: pyroscope
    app.kubernetes.io/component: monolithic
spec:
  serviceName: pyroscope-headless
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: pyroscope
      app.kubernetes.io/component: monolithic
  template:
    metadata:
      labels:
        app.kubernetes.io/name: pyroscope
        app.kubernetes.io/component: monolithic
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/pyroscope-configmap.yaml") . | sha256sum }}
    spec:
      {{- with .Values.pyroscope.priorityClassName }}
      priorityClassName: {{ . }}
      {{- end }}
      {{- with .Values.pyroscope.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: pyroscope
          image: "{{ .Values.pyroscope.image.repository }}:{{ .Values.pyroscope.image.tag }}"
          imagePullPolicy: IfNotPresent
          args:
            - -config.file=/etc/pyroscope/config.yaml
            - -config.expand-env=true
          env:
            - name: GOMEMLIMIT
              value: "1800MiB"
          ports:
            - name: http
              containerPort: 4040
              protocol: TCP
          envFrom:
            - secretRef:
                name: {{ .Values.pyroscope.storage.credentialsSecret }}
          readinessProbe:
            httpGet:
              path: /ready
              port: http
            initialDelaySeconds: 30
            timeoutSeconds: 5
          livenessProbe:
            httpGet:
              path: /ready
              port: http
            initialDelaySeconds: 60
            timeoutSeconds: 5
          startupProbe:
            httpGet:
              path: /ready
              port: http
            failureThreshold: 30
            periodSeconds: 10
          resources:
            {{- toYaml .Values.pyroscope.resources | nindent 12 }}
          volumeMounts:
            - name: config
              mountPath: /etc/pyroscope
            - name: data
              mountPath: /data
      volumes:
        - name: config
          configMap:
            name: pyroscope-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: {{ .Values.pyroscope.persistence.storageClass }}
        resources:
          requests:
            storage: {{ .Values.pyroscope.persistence.size }}
{{- end }}
```

**Step 2: Verify template renders**

Run:
```bash
helm template prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml --show-only templates/pyroscope-statefulset.yaml 2>&1
```
Expected: Clean YAML with StatefulSet, GOMEMLIMIT, probes, PVC.

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/pyroscope-statefulset.yaml
git commit -m "feat(pyroscope): add StatefulSet with GOMEMLIMIT and health probes"
```

---

### Task 5: Create Pyroscope Service and ServiceMonitor

**Context:** ClusterIP + headless service on port 4040, and ServiceMonitor for Prometheus scraping. Mirrors Tempo service pattern.

**Files:**
- Create: `helm-charts/monitoring/templates/pyroscope-service.yaml`
- Create: `helm-charts/monitoring/templates/pyroscope-servicemonitor.yaml`

**Step 1: Create the Service template**

```yaml
{{- if .Values.pyroscope.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: pyroscope
  labels:
    app.kubernetes.io/name: pyroscope
    app.kubernetes.io/component: monolithic
spec:
  type: ClusterIP
  ports:
    - name: http
      port: 4040
      targetPort: http
      protocol: TCP
  selector:
    app.kubernetes.io/name: pyroscope
    app.kubernetes.io/component: monolithic
---
apiVersion: v1
kind: Service
metadata:
  name: pyroscope-headless
  labels:
    app.kubernetes.io/name: pyroscope
    app.kubernetes.io/component: monolithic
spec:
  type: ClusterIP
  clusterIP: None
  ports:
    - name: http
      port: 4040
      targetPort: http
      protocol: TCP
  selector:
    app.kubernetes.io/name: pyroscope
    app.kubernetes.io/component: monolithic
{{- end }}
```

**Step 2: Create the ServiceMonitor template**

```yaml
{{- if and .Values.pyroscope.enabled .Values.pyroscope.serviceMonitor.enabled }}
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: pyroscope
  labels:
    app.kubernetes.io/name: pyroscope
    app.kubernetes.io/component: monolithic
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: pyroscope
      app.kubernetes.io/component: monolithic
  endpoints:
    - port: http
      interval: 30s
{{- end }}
```

**Step 3: Verify templates render**

Run:
```bash
helm template prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml --show-only templates/pyroscope-service.yaml 2>&1 && helm template prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml --show-only templates/pyroscope-servicemonitor.yaml 2>&1
```
Expected: Clean YAML for both.

**Step 4: Commit**

```bash
git add helm-charts/monitoring/templates/pyroscope-service.yaml helm-charts/monitoring/templates/pyroscope-servicemonitor.yaml
git commit -m "feat(pyroscope): add Service, headless Service, and ServiceMonitor"
```

---

### Task 6: Create Garage Bucket and Doppler Secrets

**Context:** The `pyroscope-profiles` bucket needs to be created in Garage, and API keys stored in Doppler. This is a manual/CLI step, same as what was done for `tempo-traces`.

**Step 1: Create Garage bucket**

Run on the control plane node (or via kubectl exec into the garage pod):
```bash
kubectl exec -n monitoring garage-0 -- /garage bucket create pyroscope-profiles
```

**Step 2: Create Garage API key**

```bash
kubectl exec -n monitoring garage-0 -- /garage key create pyroscope-key
```
Note the `accessKeyId` and `secretAccessKey` from the output.

**Step 3: Grant bucket permissions**

```bash
kubectl exec -n monitoring garage-0 -- /garage bucket allow --read --write --owner pyroscope-profiles --key pyroscope-key
```

**Step 4: Store credentials in Doppler**

Via Doppler UI or CLI, add to the `portfolio/prd` config:
- `GARAGE_PYROSCOPE_ACCESS_KEY_ID` = the access key from step 2
- `GARAGE_PYROSCOPE_SECRET_ACCESS_KEY` = the secret key from step 2

**Step 5: Commit** (nothing to commit — this is infrastructure setup)

---

### Task 7: Add Alloy eBPF Profiling Config

**Context:** Add `pyroscope.ebpf` pipeline to the existing Alloy config. Goes before the Beyla section (before line 183). Uses Kubernetes discovery filtered to local node pods.

**Files:**
- Modify: `helm-charts/monitoring/templates/alloy-config.yaml` — insert before `// --- Beyla eBPF Auto-Instrumentation ---`

**Step 1: Add the profiling pipeline**

Insert this block before the `// --- Beyla eBPF Auto-Instrumentation ---` comment (line 183):

```river
    // --- eBPF CPU Profiler (Pyroscope) ---
    discovery.kubernetes "local_pods" {
      selectors {
        field = "spec.nodeName=" + env("HOSTNAME")
        role  = "pod"
      }
      role = "pod"
    }

    pyroscope.ebpf "instance" {
      forward_to = [pyroscope.write.endpoint.receiver]
      targets    = discovery.kubernetes.local_pods.targets
    }

    pyroscope.write "endpoint" {
      endpoint {
        url = "http://pyroscope.monitoring.svc.cluster.local:4040"
      }
    }

```

**Step 2: Verify template renders**

Run:
```bash
helm template prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml --show-only templates/alloy-config.yaml 2>&1 | tail -80
```
Expected: Clean output showing the new profiling blocks before the Beyla section.

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/alloy-config.yaml
git commit -m "feat(alloy): add pyroscope.ebpf CPU profiling pipeline"
```

---

### Task 8: Deploy and Verify

**Context:** All templates created, secrets configured. Deploy via helm upgrade, restart Alloy, verify everything comes up.

**Step 1: Full template dry-run**

Run:
```bash
helm template prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml > /dev/null 2>&1 && echo "OK" || echo "TEMPLATE ERROR"
```
Expected: `OK`

**Step 2: Deploy**

Run:
```bash
helm upgrade prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml
```
Expected: Release upgraded successfully.

**Step 3: Wait for Pyroscope pod**

Run:
```bash
kubectl get pods -n monitoring -l app.kubernetes.io/name=pyroscope -w
```
Expected: `pyroscope-0` reaches `Running` state.

**Step 4: Check Pyroscope logs**

Run:
```bash
kubectl logs -n monitoring pyroscope-0 --tail=30
```
Expected: Startup messages, no S3 connection errors.

**Step 5: Restart Alloy to pick up profiling config**

Run:
```bash
kubectl rollout restart daemonset prometheus-alloy -n monitoring
kubectl rollout status daemonset prometheus-alloy -n monitoring --timeout=120s
```
Expected: All 3 pods restarted successfully.

**Step 6: Check Alloy logs for pyroscope.ebpf**

Run:
```bash
kubectl logs -n monitoring -l app.kubernetes.io/name=alloy --tail=200 | grep -i 'pyroscope\|profil'
```
Expected: Log lines showing pyroscope.ebpf component started.

**Step 7: Verify profiles in Grafana**

Open Grafana → Explore → Select Pyroscope datasource → Run a query.
Expected: CPU profiles appearing from cluster workloads.

**Step 8: Push to GitHub**

Run:
```bash
git push origin main
```
