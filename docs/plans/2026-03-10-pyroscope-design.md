# Pyroscope Continuous Profiling Design

## Goal

Deploy Grafana Pyroscope for continuous CPU profiling across the cluster, with Alloy's `pyroscope.ebpf` component as the eBPF profiler, Garage as the S3 backend, and Grafana as the query frontend.

## Architecture

### Profiling Pipeline

```
All pods (host PID) → Alloy pyroscope.ebpf (DaemonSet) → pyroscope.write → Pyroscope Monolithic → Garage S3
                                                                                    ↓
                                                                              Grafana (query)
```

### What eBPF Profiling Captures

- **CPU stack traces** at 97 samples/sec (default)
- Works best with natively compiled languages: Go, C/C++, Rust
- Node.js: captures V8 JIT frames (no JS function names without symbol maps)
- Python: supported with `python_enabled=true`
- Does NOT capture memory, goroutine, or mutex profiles (those require SDK instrumentation)

### Why eBPF Over SDK-First

Same rationale as Beyla — zero code changes, language-agnostic baseline. SDK profiling can be added later for richer profiles.

## Components

### Pyroscope Monolithic (StatefulSet)

- **Image**: `grafana/pyroscope:1.18.1`
- **Replicas**: 1
- **Mode**: Monolithic (`-target=all`)
- **PVC**: 20Gi for local data/WAL (`local-path`, control plane node)
- **Resources**: 100m CPU request, 512Mi memory request / 2Gi limit
- **`GOMEMLIMIT=1800MiB`** (90% of memory limit)
- **NodeSelector**: `kubernetes.io/hostname: vmi2951245` (control plane, co-located with Garage)
- **Ports**: 4040 (HTTP API/push/query)
- **No Redis** — in-memory cache sufficient for single-node

### S3 Storage (Garage)

- **Bucket**: `pyroscope-profiles` (needs creating in Garage)
- **Credentials**: Doppler ExternalSecret → `garage-pyroscope-credentials`
  - `GARAGE_PYROSCOPE_ACCESS_KEY_ID`
  - `GARAGE_PYROSCOPE_SECRET_ACCESS_KEY`
- **Region**: `garage` (required for Garage S3 auth)

### Alloy Config Addition

Add to existing `alloy-config.yaml` before the Beyla section:

```river
// --- eBPF CPU Profiler ---
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

No additional DaemonSet changes needed — Beyla already required `privileged: true`, `hostPID: true`, and `/sys/kernel/debug`.

### Pyroscope Configuration

```yaml
target: all

server:
  http_listen_port: 4040
  log_level: info

storage:
  backend: s3
  s3:
    bucket_name: pyroscope-profiles
    endpoint: garage.monitoring.svc.cluster.local:3900
    access_key_id: ${GARAGE_PYROSCOPE_ACCESS_KEY_ID}
    secret_access_key: ${GARAGE_PYROSCOPE_SECRET_ACCESS_KEY}
    insecure: true
    region: garage
```

### Secrets (Doppler → ExternalSecret)

- `garage-pyroscope-credentials`:
  - `GARAGE_PYROSCOPE_ACCESS_KEY_ID` — Garage API key for pyroscope-profiles bucket
  - `GARAGE_PYROSCOPE_SECRET_ACCESS_KEY`

## Grafana Integration

### Datasource

Add Pyroscope datasource to existing provisioning ConfigMap:
- **Type**: `grafana-pyroscope-datasource`
- **URL**: `http://pyroscope.monitoring.svc.cluster.local:4040`
- **uid**: `pyroscope`
- **isDefault**: false

## Helm Templates (monitoring chart)

Same pattern as Tempo:

- `pyroscope-configmap.yaml` — Pyroscope YAML config
- `pyroscope-statefulset.yaml` — StatefulSet with GOMEMLIMIT
- `pyroscope-service.yaml` — ClusterIP (4040)
- `pyroscope-servicemonitor.yaml` — Prometheus scraping
- `pyroscope-externalsecret.yaml` — Garage credentials from Doppler

## Resource Summary

| Component | CPU Request | Memory Request | Memory Limit |
|-----------|-------------|----------------|--------------|
| Pyroscope monolithic | 100m | 512Mi | 2Gi |
| **Total new** | **100m** | **512Mi** | **2Gi** |

## Notes

- No symbol cache volume needed — `pyroscope.ebpf` in Alloy handles symcache in its own `/tmp`
- Alloy already has all required privileges from Beyla deployment
- Profile retention follows Pyroscope defaults (configurable via compactor settings)
