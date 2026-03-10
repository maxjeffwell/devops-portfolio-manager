# Beyla eBPF Auto-Instrumentation Design

## Goal

Add Grafana Beyla eBPF auto-instrumentation to the existing Alloy DaemonSet to generate distributed traces from all HTTP/gRPC services in the `default` namespace without any application code changes.

## Architecture

### Trace Pipeline

```
Portfolio Apps (default ns) → Beyla eBPF (kernel-level) → batch processor → Tempo
Future SDK Apps → OTLP receiver (4317/4318) → batch processor → Tempo
```

Beyla attaches eBPF probes at the kernel level to intercept HTTP/gRPC calls. No application modification or sidecar injection required — Beyla discovers services via the Kubernetes API and instruments them automatically.

### Discovery Strategy

Kubernetes-based discovery filtered to the `default` namespace only. No port-range scanning. Beyla queries the K8s API for pods in the target namespace and attaches probes to discovered services.

### Why eBPF Over SDK-First

- **Zero code changes**: Instruments all portfolio apps immediately (bookmarked, educationelly, intervalai, portfolio-gatsby, gateway, etc.)
- **Language-agnostic**: Works with Node.js, Python, Go — no per-language SDK setup
- **Baseline traces now**: Get HTTP/gRPC spans flowing to Tempo today; add SDK instrumentation later (Phase 3) for custom spans and business logic tracing

### Limitations

- eBPF traces capture HTTP/gRPC request/response metadata only (method, path, status, latency)
- No custom spans, business logic traces, or database query tracing — that requires SDK instrumentation (Phase 3)
- Requires `privileged: true` on Alloy pods (eBPF needs kernel access)

## Components

### Alloy Config Changes

Replace the existing OTLP trace pipeline (lines 183-213 of `alloy-config.yaml`) with:

1. **`beyla.ebpf "auto"`** — eBPF auto-instrumentation targeting `default` namespace via Kubernetes discovery
2. **`otelcol.receiver.otlp "default"`** — Kept for future SDK-instrumented apps (ports 4317/4318)
3. **`otelcol.processor.batch "tempo"`** — Renamed from `"default"`, both Beyla and OTLP receiver feed into it. Tuned for Beyla's steady trickle: 1024 batch size, 5s timeout
4. **`otelcol.exporter.otlp "tempo"`** — Unchanged, snappy compression to Tempo

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
    traces  = [otelcol.processor.batch.tempo.input]
    metrics = [prometheus.remote_write.mimir.receiver]
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

### DaemonSet Changes (values.yaml)

Two additions to the Alloy subchart values:

1. **Privileged security context** — eBPF requires kernel access to attach probes:
   ```yaml
   alloy:
     alloy:
       securityContext:
         privileged: true
   ```

2. **debugfs volume mount** — eBPF tracepoints live in `/sys/kernel/debug`:
   ```yaml
   controller:
     volumes:
       extra:
         - name: debugfs
           hostPath:
             path: /sys/kernel/debug
             type: Directory
   alloy:
     mounts:
       extra:
         - name: debugfs
           mountPath: /sys/kernel/debug
           readOnly: true
   ```

### No New Templates

All changes are to existing files only:
- `helm-charts/monitoring/templates/alloy-config.yaml` — Replace OTLP section
- `helm-charts/monitoring/values.yaml` — Add security context + debugfs mount

## Batch Processor Tuning

| Setting | Old (SDK-optimized) | New (Beyla-optimized) | Reason |
|---------|--------------------|-----------------------|--------|
| Label | `"default"` | `"tempo"` | Clarity — both sources feed it |
| `send_batch_size` | 8192 | 1024 | Beyla generates fewer, steadier spans |
| `timeout` | 200ms | 5s | Flush less frequently, reduce Tempo write pressure |
| `send_batch_max_size` | 0 | 0 | Unchanged — unlimited (avoids the error we hit) |

## Phased Instrumentation

1. **Phase 1** (done): Tempo + Alloy OTLP pipeline + Redis + Grafana datasource
2. **Phase 2** (this implementation): Beyla eBPF auto-instrumentation for `default` namespace
3. **Phase 3** (future): SDK instrumentation — LiteLLM, Gateway (Node.js OTEL SDK), portfolio apps
4. **Phase 4** (future): Pyroscope continuous profiling

## Resource Impact

No new pods. Beyla runs inside the existing Alloy DaemonSet. Memory increase expected to be minimal (~50-100Mi per node for eBPF maps). Monitor Alloy memory after deployment and increase limits if needed.

## Deployment

```bash
helm upgrade prometheus helm-charts/monitoring -n monitoring -f helm-charts/monitoring/values.yaml
kubectl rollout restart daemonset alloy -n monitoring
```

## Verification

1. Alloy pods restart without errors: `kubectl logs -n monitoring -l app.kubernetes.io/name=alloy --tail=50`
2. Beyla discovers services: Look for `beyla` component logs in Alloy output
3. Traces appear in Grafana → Explore → Tempo datasource
4. Service map populates in Grafana (Tempo metrics-generator service graphs)
