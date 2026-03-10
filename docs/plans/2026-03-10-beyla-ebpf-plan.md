# Beyla eBPF Auto-Instrumentation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Grafana Beyla eBPF auto-instrumentation to the Alloy DaemonSet for zero-code HTTP/gRPC tracing of all services in the `default` namespace.

**Architecture:** Beyla runs as an embedded component inside Alloy, discovers pods via the Kubernetes API (filtered to `default` namespace), attaches eBPF probes at the kernel level, and forwards generated traces through a batch processor to the existing Tempo instance. The OTLP receiver is kept for future SDK instrumentation.

**Tech Stack:** Grafana Alloy (with Beyla eBPF component), Helm, K3s

---

### Task 1: Update Alloy Config — Replace OTLP Pipeline with Beyla + Renamed Batch

**Context:** The existing Alloy config has a plain OTLP receiver → batch → Tempo exporter pipeline (lines 183-213). We replace it with Beyla eBPF discovery + the same OTLP receiver (for future SDK use), both feeding into a renamed batch processor `"tempo"` with tuned settings for Beyla's steady trickle pattern.

**Files:**
- Modify: `helm-charts/monitoring/templates/alloy-config.yaml:183-213`

**Step 1: Replace the OTLP trace pipeline section**

Replace lines 183-213 (everything from `// --- OTLP Trace Pipeline` through the closing `}` of `otelcol.exporter.otlp "tempo"`) with:

```river
    // --- Beyla eBPF Auto-Instrumentation ---
    beyla.ebpf "auto" {
      discovery {
        services {
          kubernetes {
            namespace = "default"
          }
        }
      }
      output {
        traces = [otelcol.processor.batch.tempo.input]
      }
    }

    // --- OTLP Receiver (for future SDK-instrumented apps) ---
    otelcol.receiver.otlp "default" {
      grpc {
        endpoint = "0.0.0.0:4317"
      }
      http {
        endpoint = "0.0.0.0:4318"
      }
      output {
        traces = [otelcol.processor.batch.tempo.input]
      }
    }

    // --- Batch spans before export ---
    otelcol.processor.batch "tempo" {
      timeout             = "5s"
      send_batch_size     = 1024
      send_batch_max_size = 0
      output {
        traces = [otelcol.exporter.otlp.tempo.input]
      }
    }

    // --- Export to Tempo ---
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

**Key changes from old config:**
- Added `beyla.ebpf "auto"` block (Kubernetes discovery, `default` namespace)
- Batch processor renamed `"default"` → `"tempo"` (both Beyla and OTLP receiver reference it)
- Batch tuned: 8192→1024 batch size, 200ms→5s timeout
- OTLP receiver output changed from `otelcol.processor.batch.default.input` → `otelcol.processor.batch.tempo.input`
- Exporter block unchanged

**Step 2: Verify template renders**

Run:
```bash
helm template prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml --show-only templates/alloy-config.yaml 2>&1 | tail -50
```
Expected: Clean YAML output with the new Beyla + OTLP + batch + exporter blocks. No errors.

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/alloy-config.yaml
git commit -m "feat(alloy): add Beyla eBPF auto-instrumentation to trace pipeline

Replace plain OTLP receiver pipeline with Beyla eBPF discovery targeting
default namespace. Keep OTLP receiver for future SDK instrumentation.
Rename batch processor to 'tempo', tune for Beyla's steady trickle."
```

---

### Task 2: Update values.yaml — Add Privileged Security Context

**Context:** Beyla eBPF requires kernel-level access to attach probes. The Alloy container needs `privileged: true` in its security context. The Alloy subchart exposes this via `alloy.alloy.securityContext`.

**Files:**
- Modify: `helm-charts/monitoring/values.yaml:638-663`

**Step 1: Add securityContext to the alloy.alloy section**

After the existing `clustering` block (line 641) and before `configMap` (line 642), add the security context. The resulting section should look like:

```yaml
alloy:
  enabled: true
  alloy:
    clustering:
      enabled: true
    securityContext:
      privileged: true
    configMap:
      create: false
```

Insert these two lines after `enabled: true` (line 641) and before `configMap:` (line 642):
```yaml
    securityContext:
      privileged: true
```

**Step 2: Verify template renders**

Run:
```bash
helm template prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml --show-only charts/alloy/templates/controllers/daemonset.yaml 2>&1 | grep -A3 'securityContext'
```
Expected: Should show `privileged: true` under the alloy container's securityContext.

**Step 3: Commit**

```bash
git add helm-charts/monitoring/values.yaml
git commit -m "feat(alloy): enable privileged mode for Beyla eBPF kernel access"
```

---

### Task 3: Update values.yaml — Add debugfs Volume Mount

**Context:** eBPF tracepoints live in `/sys/kernel/debug`. Alloy needs this mounted to attach probes. The Alloy subchart uses `controller.volumes.extra` for hostPath volumes and `alloy.mounts.extra` for container mounts.

**Files:**
- Modify: `helm-charts/monitoring/values.yaml:646-652` (mounts.extra) and `678-683` (volumes.extra)

**Step 1: Add debugfs to alloy.mounts.extra**

The existing `mounts.extra` section (lines 649-652) has the journal mount. Add the debugfs mount after it:

```yaml
    mounts:
      varlog: true
      dockercontainers: true
      extra:
        - name: journal
          mountPath: /var/log/journal
          readOnly: true
        - name: debugfs
          mountPath: /sys/kernel/debug
          readOnly: true
```

**Step 2: Add debugfs to controller.volumes.extra**

The existing `volumes.extra` section (lines 679-683) has the journal volume. Add the debugfs volume after it:

```yaml
    volumes:
      extra:
        - name: journal
          hostPath:
            path: /var/log/journal
            type: DirectoryOrCreate
        - name: debugfs
          hostPath:
            path: /sys/kernel/debug
            type: Directory
```

**Step 3: Verify template renders with both volume and mount**

Run:
```bash
helm template prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml --show-only charts/alloy/templates/controllers/daemonset.yaml 2>&1 | grep -A4 'debugfs'
```
Expected: Should show both the volume definition and the volumeMount for debugfs.

**Step 4: Commit**

```bash
git add helm-charts/monitoring/values.yaml
git commit -m "feat(alloy): mount /sys/kernel/debug for eBPF tracepoint access"
```

---

### Task 4: Increase Alloy Memory Limit

**Context:** Beyla eBPF uses kernel memory maps that add ~50-100Mi per node. The current Alloy memory limit is 256Mi which may be tight. Bump to 512Mi to accommodate Beyla's eBPF maps plus the existing log/metrics collection workload.

**Files:**
- Modify: `helm-charts/monitoring/values.yaml:658-663`

**Step 1: Update memory resources**

Change:
```yaml
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        memory: 256Mi
```

To:
```yaml
    resources:
      requests:
        cpu: 50m
        memory: 128Mi
      limits:
        memory: 512Mi
```

**Step 2: Commit**

```bash
git add helm-charts/monitoring/values.yaml
git commit -m "feat(alloy): increase memory for Beyla eBPF overhead (256Mi→512Mi)"
```

---

### Task 5: Deploy and Verify

**Context:** All config changes are committed. Deploy via helm upgrade and verify Alloy pods restart cleanly with Beyla discovering services.

**Step 1: Full helm template dry-run**

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

**Step 3: Restart Alloy DaemonSet to pick up config changes**

Run:
```bash
kubectl rollout restart daemonset alloy -n monitoring
kubectl rollout status daemonset alloy -n monitoring --timeout=120s
```
Expected: All pods restarted successfully.

**Step 4: Verify Alloy pods are running without errors**

Run:
```bash
kubectl get pods -n monitoring -l app.kubernetes.io/name=alloy
```
Expected: All pods in `Running` state, 0 restarts (or minimal).

**Step 5: Check Alloy logs for Beyla initialization**

Run:
```bash
kubectl logs -n monitoring -l app.kubernetes.io/name=alloy --tail=50 | grep -i 'beyla\|ebpf\|discovery'
```
Expected: Log lines showing Beyla component started and discovering services in default namespace.

**Step 6: Check Alloy logs for errors**

Run:
```bash
kubectl logs -n monitoring -l app.kubernetes.io/name=alloy --tail=100 | grep -i 'error\|failed\|fatal'
```
Expected: No errors related to beyla, ebpf, or batch processor.

**Step 7: Verify traces in Grafana**

Open Grafana → Explore → Select Tempo datasource → Run a TraceQL query:
```
{}
```
Expected: After a few minutes of traffic to portfolio apps, traces should appear showing HTTP request spans auto-generated by Beyla.

**Step 8: Push to GitHub**

Run:
```bash
git push origin main
```
