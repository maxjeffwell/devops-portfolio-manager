# Grafana Tempo Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy Grafana Tempo for distributed tracing with Alloy as the collector, Garage as S3 storage, and Redis for query caching.

**Architecture:** Monolithic Tempo pod receives OTLP traces from Alloy DaemonSet, writes WAL to local PVC, flushes compressed blocks to Garage S3, caches bloom filters/index headers in dedicated Redis, and generates RED metrics pushed to Mimir. All custom Helm templates in the monitoring chart, same pattern as Mimir/Garage.

**Tech Stack:** Grafana Tempo 2.7.2, Redis 7-alpine, Alloy (OTLP receiver), Garage S3, Doppler ExternalSecrets, Helm

---

### Task 1: Add Tempo and Redis values to values.yaml

**Files:**
- Modify: `helm-charts/monitoring/values.yaml:159` (add Tempo Grafana datasource)
- Modify: `helm-charts/monitoring/values.yaml:678` (add tempoMonolithic and tempoRedis sections)

**Step 1: Add Tempo datasource to Grafana additionalDataSources**

After the Mimir datasource block (line 159), add:

```yaml
      - name: Tempo
        type: tempo
        uid: tempo
        access: proxy
        url: http://tempo-monolithic.monitoring.svc.cluster.local:3200
        editable: true
        jsonData:
          tracesToLogs:
            datasourceUid: loki
            filterByTraceID: true
            filterBySpanID: true
          tracesToMetrics:
            datasourceUid: mimir
          nodeGraph:
            enabled: true
          serviceMap:
            datasourceUid: mimir
```

**Step 2: Add tempoMonolithic section after mimirMonolithic (after line 678)**

```yaml
# Tempo Monolithic - Distributed tracing (single binary, OTLP receiver + S3 storage)
# Design: docs/plans/2026-03-10-grafana-tempo-design.md
tempoMonolithic:
  enabled: true
  image:
    repository: grafana/tempo
    tag: "2.7.2"
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
    credentialsSecret: garage-tempo-credentials
    s3:
      endpoint: garage.monitoring.svc.cluster.local:3900
      bucket: tempo-traces
      insecure: true
      region: garage
  config:
    retention: 720h  # 30 days
    ingester:
      flushCheckPeriod: 30s
      maxBlockDuration: 30m
    compactor:
      compactionWindow: 4h
    metricsGenerator:
      remoteWriteUrl: http://mimir-monolithic.monitoring.svc.cluster.local:8080/api/v1/push
  redis:
    address: tempo-redis.monitoring.svc.cluster.local:6379
    cacheMinCompactionLevel: 1
    cacheMaxBlockAge: 48h
  serviceMonitor:
    enabled: true

# Tempo Redis - Bloom filter and index header cache (no persistence, rebuilt from S3)
tempoRedis:
  enabled: true
  image:
    repository: redis
    tag: "7-alpine"
  nodeSelector:
    kubernetes.io/hostname: vmi2951245
  resources:
    requests:
      cpu: 50m
      memory: 256Mi
    limits:
      memory: 2Gi
  maxmemory: 2gb
  maxmemoryPolicy: allkeys-lru
```

**Step 3: Add Alloy OTLP extraPorts for trace receiver**

In the `alloy` section (after line 606), add under `controller`:

```yaml
    extraPorts:
      - name: otlp-grpc
        port: 4317
        targetPort: 4317
        protocol: TCP
      - name: otlp-http
        port: 4318
        targetPort: 4318
        protocol: TCP
```

**Step 4: Verify template renders**

Run: `cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager && helm template monitoring helm-charts/monitoring --debug 2>&1 | head -50`
Expected: No template errors

**Step 5: Commit**

```bash
git add helm-charts/monitoring/values.yaml
git commit -m "feat(tempo): add Tempo, Redis, and Alloy OTLP values"
```

---

### Task 2: Create Tempo ExternalSecret template

**Files:**
- Create: `helm-charts/monitoring/templates/tempo-externalsecret.yaml`

**Step 1: Create the ExternalSecret**

Follow the pattern from `garage-externalsecret.yaml`. Map Doppler keys to a K8s secret that Tempo's StatefulSet will mount via `envFrom`:

```yaml
{{- if .Values.tempoMonolithic.enabled }}
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: tempo-external-secret
  namespace: {{ .Release.Namespace }}
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: doppler-secret-store
    kind: ClusterSecretStore
  target:
    name: garage-tempo-credentials
    creationPolicy: Owner
  data:
    - secretKey: accessKeyId
      remoteRef:
        key: GARAGE_TEMPO_ACCESS_KEY_ID
    - secretKey: secretAccessKey
      remoteRef:
        key: GARAGE_TEMPO_SECRET_ACCESS_KEY
{{- end }}
```

**Step 2: Verify template renders**

Run: `helm template monitoring helm-charts/monitoring --show-only templates/tempo-externalsecret.yaml`
Expected: Valid ExternalSecret YAML with correct Doppler key references

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/tempo-externalsecret.yaml
git commit -m "feat(tempo): add ExternalSecret for Garage S3 credentials"
```

---

### Task 3: Create Tempo ConfigMap template

**Files:**
- Create: `helm-charts/monitoring/templates/tempo-monolithic-configmap.yaml`

**Step 1: Create the ConfigMap with full Tempo configuration**

This is the core Tempo config. It references values from `values.yaml` and uses `${accessKeyId}` / `${secretAccessKey}` env var expansion (same pattern as Mimir):

```yaml
{{- if .Values.tempoMonolithic.enabled }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: tempo-monolithic-config
  labels:
    app.kubernetes.io/name: tempo
    app.kubernetes.io/component: monolithic
data:
  tempo.yaml: |
    target: all
    multitenancy_enabled: false

    server:
      http_listen_port: 3200
      log_level: warn

    distributor:
      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: "0.0.0.0:4317"
            http:
              endpoint: "0.0.0.0:4318"

    ingester:
      trace_idle_period: 10s
      flush_check_period: {{ .Values.tempoMonolithic.config.ingester.flushCheckPeriod }}
      max_block_duration: {{ .Values.tempoMonolithic.config.ingester.maxBlockDuration }}

    compactor:
      compaction:
        compaction_window: {{ .Values.tempoMonolithic.config.compactor.compactionWindow }}
        block_retention: {{ .Values.tempoMonolithic.config.retention }}

    storage:
      trace:
        backend: s3
        s3:
          endpoint: {{ .Values.tempoMonolithic.storage.s3.endpoint }}
          bucket: {{ .Values.tempoMonolithic.storage.s3.bucket }}
          access_key: ${accessKeyId}
          secret_key: ${secretAccessKey}
          insecure: {{ .Values.tempoMonolithic.storage.s3.insecure }}
          region: {{ .Values.tempoMonolithic.storage.s3.region }}
        wal:
          path: /data/wal
          encoding: snappy
        block:
          encoding: zstd
          bloom_filter_false_positive: 0.01
          v2_index_downsample_bytes: 1048576
        cache: redis
        redis:
          endpoint: {{ .Values.tempoMonolithic.redis.address }}
          cache_min_compaction_level: {{ .Values.tempoMonolithic.redis.cacheMinCompactionLevel }}
          cache_max_block_age: {{ .Values.tempoMonolithic.redis.cacheMaxBlockAge }}
        dedicated_columns:
          - name: service.name
          - name: http.status_code
          - name: http.route

    metrics_generator:
      registry:
        external_labels:
          source: tempo
      storage:
        path: /data/generator/wal
        remote_write:
          - url: {{ .Values.tempoMonolithic.config.metricsGenerator.remoteWriteUrl }}
      processor:
        service_graphs:
          dimensions:
            - service.namespace
        span_metrics:
          dimensions:
            - service.namespace
            - http.method
            - http.status_code
          enable_target_info: true

    overrides:
      defaults:
        metrics_generator:
          processors:
            - service-graphs
            - span-metrics
{{- end }}
```

**Step 2: Verify template renders**

Run: `helm template monitoring helm-charts/monitoring --show-only templates/tempo-monolithic-configmap.yaml`
Expected: Valid ConfigMap with interpolated values, `${accessKeyId}` left as literal (expanded at runtime by Tempo's `-config.expand-env=true`)

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/tempo-monolithic-configmap.yaml
git commit -m "feat(tempo): add ConfigMap with trace storage, cache, and metrics-generator config"
```

---

### Task 4: Create Tempo StatefulSet template

**Files:**
- Create: `helm-charts/monitoring/templates/tempo-monolithic-statefulset.yaml`

**Step 1: Create the StatefulSet**

Follow the Mimir StatefulSet pattern. Key differences: GOMEMLIMIT env var, three ports (HTTP + gRPC + HTTP OTLP), different config paths:

```yaml
{{- if .Values.tempoMonolithic.enabled }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: tempo-monolithic
  labels:
    app.kubernetes.io/name: tempo
    app.kubernetes.io/component: monolithic
spec:
  serviceName: tempo-monolithic-headless
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: tempo
      app.kubernetes.io/component: monolithic
  template:
    metadata:
      labels:
        app.kubernetes.io/name: tempo
        app.kubernetes.io/component: monolithic
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/tempo-monolithic-configmap.yaml") . | sha256sum }}
    spec:
      {{- with .Values.tempoMonolithic.priorityClassName }}
      priorityClassName: {{ . }}
      {{- end }}
      {{- with .Values.tempoMonolithic.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: tempo
          image: "{{ .Values.tempoMonolithic.image.repository }}:{{ .Values.tempoMonolithic.image.tag }}"
          imagePullPolicy: IfNotPresent
          args:
            - -config.file=/etc/tempo/tempo.yaml
            - -config.expand-env=true
          env:
            - name: GOMEMLIMIT
              value: "1800MiB"
          ports:
            - name: http-metrics
              containerPort: 3200
              protocol: TCP
            - name: otlp-grpc
              containerPort: 4317
              protocol: TCP
            - name: otlp-http
              containerPort: 4318
              protocol: TCP
          envFrom:
            - secretRef:
                name: {{ .Values.tempoMonolithic.storage.credentialsSecret }}
          readinessProbe:
            httpGet:
              path: /ready
              port: http-metrics
            initialDelaySeconds: 30
            timeoutSeconds: 5
          livenessProbe:
            httpGet:
              path: /ready
              port: http-metrics
            initialDelaySeconds: 60
            timeoutSeconds: 5
          startupProbe:
            httpGet:
              path: /ready
              port: http-metrics
            failureThreshold: 30
            periodSeconds: 10
          resources:
            {{- toYaml .Values.tempoMonolithic.resources | nindent 12 }}
          volumeMounts:
            - name: config
              mountPath: /etc/tempo
            - name: data
              mountPath: /data
      volumes:
        - name: config
          configMap:
            name: tempo-monolithic-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: {{ .Values.tempoMonolithic.persistence.storageClass }}
        resources:
          requests:
            storage: {{ .Values.tempoMonolithic.persistence.size }}
{{- end }}
```

**Step 2: Verify template renders**

Run: `helm template monitoring helm-charts/monitoring --show-only templates/tempo-monolithic-statefulset.yaml`
Expected: Valid StatefulSet with GOMEMLIMIT, envFrom, three ports, 20Gi PVC

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/tempo-monolithic-statefulset.yaml
git commit -m "feat(tempo): add StatefulSet with GOMEMLIMIT and OTLP ports"
```

---

### Task 5: Create Tempo Service templates

**Files:**
- Create: `helm-charts/monitoring/templates/tempo-monolithic-service.yaml`

**Step 1: Create ClusterIP + headless Services**

Follow the Mimir service pattern. Tempo needs ports 3200 (HTTP API/query), 4317 (OTLP gRPC), 4318 (OTLP HTTP):

```yaml
{{- if .Values.tempoMonolithic.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: tempo-monolithic
  labels:
    app.kubernetes.io/name: tempo
    app.kubernetes.io/component: monolithic
spec:
  type: ClusterIP
  ports:
    - name: http-metrics
      port: 3200
      targetPort: http-metrics
      protocol: TCP
    - name: otlp-grpc
      port: 4317
      targetPort: otlp-grpc
      protocol: TCP
    - name: otlp-http
      port: 4318
      targetPort: otlp-http
      protocol: TCP
  selector:
    app.kubernetes.io/name: tempo
    app.kubernetes.io/component: monolithic
---
apiVersion: v1
kind: Service
metadata:
  name: tempo-monolithic-headless
  labels:
    app.kubernetes.io/name: tempo
    app.kubernetes.io/component: monolithic
spec:
  type: ClusterIP
  clusterIP: None
  ports:
    - name: http-metrics
      port: 3200
      targetPort: http-metrics
      protocol: TCP
    - name: otlp-grpc
      port: 4317
      targetPort: otlp-grpc
      protocol: TCP
    - name: otlp-http
      port: 4318
      targetPort: otlp-http
      protocol: TCP
  selector:
    app.kubernetes.io/name: tempo
    app.kubernetes.io/component: monolithic
{{- end }}
```

**Step 2: Verify template renders**

Run: `helm template monitoring helm-charts/monitoring --show-only templates/tempo-monolithic-service.yaml`
Expected: Two Services (ClusterIP + headless) with three ports each

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/tempo-monolithic-service.yaml
git commit -m "feat(tempo): add ClusterIP and headless Services"
```

---

### Task 6: Create Tempo ServiceMonitor template

**Files:**
- Create: `helm-charts/monitoring/templates/tempo-monolithic-servicemonitor.yaml`

**Step 1: Create the ServiceMonitor**

```yaml
{{- if and .Values.tempoMonolithic.enabled .Values.tempoMonolithic.serviceMonitor.enabled }}
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: tempo-monolithic
  labels:
    app.kubernetes.io/name: tempo
    app.kubernetes.io/component: monolithic
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: tempo
      app.kubernetes.io/component: monolithic
  endpoints:
    - port: http-metrics
      interval: 30s
{{- end }}
```

**Step 2: Verify template renders**

Run: `helm template monitoring helm-charts/monitoring --show-only templates/tempo-monolithic-servicemonitor.yaml`
Expected: Valid ServiceMonitor scraping port `http-metrics` (3200)

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/tempo-monolithic-servicemonitor.yaml
git commit -m "feat(tempo): add ServiceMonitor for Prometheus scraping"
```

---

### Task 7: Create Redis Deployment and Service templates

**Files:**
- Create: `helm-charts/monitoring/templates/tempo-redis-deployment.yaml`
- Create: `helm-charts/monitoring/templates/tempo-redis-service.yaml`

**Step 1: Create the Redis Deployment**

Dedicated cache-only Redis — no persistence (RDB/AOF disabled), LRU eviction:

```yaml
{{- if .Values.tempoRedis.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tempo-redis
  labels:
    app.kubernetes.io/name: tempo-redis
    app.kubernetes.io/component: cache
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: tempo-redis
      app.kubernetes.io/component: cache
  template:
    metadata:
      labels:
        app.kubernetes.io/name: tempo-redis
        app.kubernetes.io/component: cache
    spec:
      {{- with .Values.tempoRedis.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: redis
          image: "{{ .Values.tempoRedis.image.repository }}:{{ .Values.tempoRedis.image.tag }}"
          imagePullPolicy: IfNotPresent
          args:
            - --maxmemory
            - {{ .Values.tempoRedis.maxmemory }}
            - --maxmemory-policy
            - {{ .Values.tempoRedis.maxmemoryPolicy }}
            - --save
            - ""
            - --appendonly
            - "no"
          ports:
            - name: redis
              containerPort: 6379
              protocol: TCP
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            initialDelaySeconds: 5
            timeoutSeconds: 3
          livenessProbe:
            exec:
              command: ["redis-cli", "ping"]
            initialDelaySeconds: 15
            timeoutSeconds: 3
          resources:
            {{- toYaml .Values.tempoRedis.resources | nindent 12 }}
{{- end }}
```

**Step 2: Create the Redis Service**

```yaml
{{- if .Values.tempoRedis.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: tempo-redis
  labels:
    app.kubernetes.io/name: tempo-redis
    app.kubernetes.io/component: cache
spec:
  type: ClusterIP
  ports:
    - name: redis
      port: 6379
      targetPort: redis
      protocol: TCP
  selector:
    app.kubernetes.io/name: tempo-redis
    app.kubernetes.io/component: cache
{{- end }}
```

**Step 3: Verify templates render**

Run: `helm template monitoring helm-charts/monitoring --show-only templates/tempo-redis-deployment.yaml && helm template monitoring helm-charts/monitoring --show-only templates/tempo-redis-service.yaml`
Expected: Valid Deployment with Redis args (maxmemory, save, appendonly) and ClusterIP Service on 6379

**Step 4: Commit**

```bash
git add helm-charts/monitoring/templates/tempo-redis-deployment.yaml helm-charts/monitoring/templates/tempo-redis-service.yaml
git commit -m "feat(tempo): add Redis cache Deployment and Service (no persistence, LRU eviction)"
```

---

### Task 8: Update Alloy config with OTLP trace pipeline

**Files:**
- Modify: `helm-charts/monitoring/templates/alloy-config.yaml:181` (add OTLP pipeline before closing `{{- end }}`)

**Step 1: Add OTLP receiver, batch processor, and exporter**

Add before the final `{{- end }}` in `alloy-config.yaml`:

```
    // --- OTLP Trace Pipeline (Apps → Alloy → Tempo) ---
    otelcol.receiver.otlp "default" {
      grpc {
        endpoint = "0.0.0.0:4317"
      }
      http {
        endpoint = "0.0.0.0:4318"
      }
      output {
        traces = [otelcol.processor.batch.default.input]
      }
    }

    otelcol.processor.batch "default" {
      send_batch_size = 8192
      timeout          = "200ms"
      output {
        traces = [otelcol.exporter.otlp.tempo.input]
      }
    }

    otelcol.exporter.otlp "tempo" {
      client {
        endpoint = "tempo-monolithic.monitoring.svc.cluster.local:4317"
        tls {
          insecure = true
        }
        compression = "snappy"
      }
    }
```

**Step 2: Verify template renders**

Run: `helm template monitoring helm-charts/monitoring --show-only templates/alloy-config.yaml 2>&1 | tail -30`
Expected: OTLP pipeline blocks at the end of the config

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/alloy-config.yaml
git commit -m "feat(tempo): add OTLP trace receiver and Tempo exporter to Alloy config"
```

---

### Task 9: Create Garage API key and bucket for Tempo

**Context:** This task runs on the VPS (control plane node), not locally. It creates the S3 bucket and API credentials in Garage, then stores them in Doppler.

**Step 1: Create the tempo-traces bucket in Garage**

```bash
# On VPS (vmi2951245) - exec into Garage pod
kubectl exec -n monitoring deploy/garage -- /garage bucket create tempo-traces
```

**Step 2: Create a Garage API key for Tempo**

```bash
kubectl exec -n monitoring deploy/garage -- /garage key create tempo-key
```

Note the `Key ID` and `Secret key` from the output.

**Step 3: Grant the key access to the bucket**

```bash
kubectl exec -n monitoring deploy/garage -- /garage bucket allow --read --write --owner tempo-traces --key tempo-key
```

**Step 4: Store credentials in Doppler**

```bash
doppler secrets set GARAGE_TEMPO_ACCESS_KEY_ID="<key-id-from-step-2>" --project portfolio --config prd
doppler secrets set GARAGE_TEMPO_SECRET_ACCESS_KEY="<secret-key-from-step-2>" --project portfolio --config prd
```

**Step 5: Verify ExternalSecret will resolve**

After helm deploy (Task 10), check:
```bash
kubectl get externalsecret tempo-external-secret -n monitoring
```
Expected: Status `SecretSynced`

---

### Task 10: Deploy via helm upgrade

**Step 1: Run helm upgrade**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
helm upgrade monitoring helm-charts/monitoring -n monitoring --values helm-charts/monitoring/values.yaml
```

**Step 2: Check all pods are running**

```bash
kubectl get pods -n monitoring -l 'app.kubernetes.io/name in (tempo, tempo-redis)'
```

Expected: `tempo-monolithic-0` Running, `tempo-redis-*` Running

**Step 3: Check ExternalSecret synced**

```bash
kubectl get externalsecret -n monitoring tempo-external-secret
```

Expected: `SecretSynced`

**Step 4: Restart Alloy to pick up config changes**

```bash
kubectl rollout restart daemonset prometheus-alloy -n monitoring
kubectl rollout status daemonset prometheus-alloy -n monitoring
```

Expected: All Alloy pods restarted successfully

**Step 5: Check Tempo logs for startup errors**

```bash
kubectl logs -n monitoring tempo-monolithic-0 --tail=30
```

Expected: No errors, `tempo started` message, S3 connection successful

---

### Task 11: Verify end-to-end trace pipeline

**Step 1: Send a test trace via Alloy's OTLP endpoint**

From any pod in the cluster (or using kubectl exec into an Alloy pod):

```bash
# Generate a test trace using Tempo's built-in query
kubectl exec -n monitoring tempo-monolithic-0 -- wget -qO- http://localhost:3200/ready
```

**Step 2: Check Tempo's metrics for ingested traces**

```bash
kubectl exec -n monitoring tempo-monolithic-0 -- wget -qO- http://localhost:3200/metrics 2>/dev/null | grep tempo_ingester_traces_created_total
```

Expected: Counter exists (may be 0 until real traces flow in Phase 2)

**Step 3: Check metrics-generator is pushing to Mimir**

```bash
kubectl exec -n monitoring tempo-monolithic-0 -- wget -qO- http://localhost:3200/metrics 2>/dev/null | grep tempo_metrics_generator_spans_received_total
```

Expected: Metric exists

**Step 4: Verify Redis cache connectivity**

```bash
kubectl exec -n monitoring tempo-monolithic-0 -- wget -qO- http://localhost:3200/metrics 2>/dev/null | grep tempo_cache
```

Expected: Cache metrics present (hits/misses)

**Step 5: Verify Grafana datasource**

Open Grafana → Configuration → Data Sources → Tempo → Test
Expected: "Data source is working"

---

### Task 12: Import Tempo Grafana dashboard

**Step 1: Import dashboard #15983**

In Grafana:
1. Go to Dashboards → Import
2. Enter ID: `15983`
3. Select Tempo datasource: `Tempo`
4. Select Prometheus datasource: `Mimir` (for Tempo's own metrics)
5. Click Import

**Step 2: Verify the three golden signals are visible**

Check the dashboard shows panels for:
1. **Ingester Flush Queue** — should be near 0
2. **Compactor Delay** — should be minimal
3. **Redis Hit Rate** — will populate once queries start

**Step 3: Save dashboard**

Grafana auto-saves imported dashboards. Verify it appears in the dashboard list.
