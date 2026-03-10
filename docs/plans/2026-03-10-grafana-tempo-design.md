# Grafana Tempo Implementation Design

## Goal

Deploy Grafana Tempo for distributed tracing across the portfolio stack, with Alloy as the unified trace collector, Garage as the S3 backend, and Redis for query caching.

## Architecture

### Trace Pipeline

```
Apps (snappy/gRPC:4317) → Alloy (DaemonSet) → Tempo Monolithic → Garage S3
                                                      ↕
                                                 tempo-redis (cache)
                                                      ↓
                                              Mimir (span metrics via remote_write)
```

### Compression Strategy

| Hop | Compression | Protocol | Reason |
|-----|-------------|----------|--------|
| Apps → Alloy | snappy | gRPC (4317 preferred, 4318 HTTP fallback) | Fast ingestion, minimal CPU |
| Alloy → Tempo | snappy | gRPC | Local cluster hop, prioritize speed |
| Tempo WAL | snappy | local disk | Fast local writes |
| Tempo → Garage (S3 blocks) | zstd | HTTP | Max compression for storage |

### Retention & Sampling

- **Retention**: 30 days
- **Sampling**: 100% (no sampling) — trace volume is low enough to capture everything

## Components

### Tempo Monolithic (StatefulSet)

- **Image**: `grafana/tempo:2.7.2`
- **Replicas**: 1
- **Mode**: Monolithic (`-target=all`)
- **PVC**: 20Gi for WAL + compactor scratch (`local-path`, control plane node)
- **Resources**: 512Mi request / 2Gi limit memory, 100m CPU request / no limit
- **`GOMEMLIMIT=1800MiB`** (90% of memory limit) — prevents Go GC death spirals under load
- **NodeSelector**: `kubernetes.io/hostname: vmi2951245` (control plane, co-located with Garage)
- **Ports**: 3200 (HTTP API/query), 4317 (OTLP gRPC receiver), 4318 (OTLP HTTP receiver)

### S3 Storage (Garage)

- **Bucket**: `tempo-traces` (already pre-allocated in Garage)
- **Credentials**: Doppler ExternalSecret → `garage-tempo-credentials`
  - `GARAGE_TEMPO_ACCESS_KEY_ID`
  - `GARAGE_TEMPO_SECRET_ACCESS_KEY`
- **Region**: `garage` (required for Garage S3 auth)

### Dedicated Parquet Columns

Start conservative, expand in Phase 2:

```yaml
dedicated_columns:
  - name: service.name
  - name: http.status_code
  - name: http.route
```

### Redis Cache (Deployment)

Dedicated Redis for Tempo bloom filter and index header caching.

- **Image**: `redis:7-alpine`
- **Replicas**: 1
- **Resources**: 256Mi request / 2Gi limit memory, 50m CPU request / no limit
- **No persistence**: RDB and AOF disabled (cache only, rebuilt from S3 on miss)
- **NodeSelector**: control plane (low-latency to Tempo)

**Redis configuration:**
- `maxmemory 2gb`
- `maxmemory-policy allkeys-lru` — evict least-used bloom filters first
- `save ""` — disable RDB snapshots
- `appendonly no` — disable AOF

**Tempo cache configuration:**
- `cache: redis`
- `cache_min_compaction_level: 1` — skip uncompacted blocks, saves ~30% Redis memory
- `cache_max_block_age: 48h` — only cache recent data

### Metrics Generator

Tempo auto-generates RED metrics from traces and pushes to Mimir:

- **Service Graphs**: Auto-built service dependency map
- **Span Metrics**: P99 latency, error rates, request rates per service
- **Remote write**: `http://mimir-monolithic.monitoring.svc.cluster.local:8080/api/v1/push`
- **Exemplar support**: Click a metric spike → jump to the exact trace

### Alloy Changes

Add OTLP trace receiver and forwarding pipeline to existing Alloy DaemonSet config:

- **Receiver**: `otelcol.receiver.otlp` on ports 4317 (gRPC) and 4318 (HTTP)
- **Processor**: `otelcol.processor.batch` — 8192 spans, 200ms timeout
- **Exporter**: `otelcol.exporter.otlp` → Tempo with snappy compression
- **DaemonSet**: Expose ports 4317/4318 in pod spec

### Secrets (Doppler → ExternalSecret)

- `garage-tempo-credentials`:
  - `GARAGE_TEMPO_ACCESS_KEY_ID` — Garage API key for tempo-traces bucket
  - `GARAGE_TEMPO_SECRET_ACCESS_KEY`

## Grafana Integration

### Datasources

Add Tempo datasource to existing provisioning ConfigMap:
- **URL**: `http://tempo-monolithic.monitoring.svc.cluster.local:3200`
- **Trace-to-logs**: Link to Loki datasource (uid: `loki`, already configured at `http://10.0.0.4:3100`)
- **Trace-to-metrics**: Link to Mimir datasource (uid: `mimir`)

### Dashboards

- Import Official Tempo Dashboard [#15983](https://grafana.com/grafana/dashboards/15983)
- Monitor three golden signals:
  1. **Ingester Flush Queue** — growing = S3 write bottleneck → increase GOMEMLIMIT or scale
  2. **Compactor Delay** — lag >few hours = too many small S3 files → TraceQL degrades
  3. **Redis Hit Rate** — below 80% = cache_max_block_age too high → increase maxmemory or reduce age

### Correlation Flow

Latency spike in Mimir (auto-generated span metrics) → exemplar jump to Tempo trace → trace ID link to Loki logs

## Helm Templates (monitoring chart)

All custom templates, same pattern as Mimir/Garage:

- `tempo-monolithic-configmap.yaml` — Tempo YAML config
- `tempo-monolithic-statefulset.yaml` — StatefulSet with GOMEMLIMIT
- `tempo-monolithic-service.yaml` — ClusterIP (3200, 4317, 4318)
- `tempo-monolithic-servicemonitor.yaml` — Prometheus scraping
- `tempo-redis-deployment.yaml` — Redis cache pod
- `tempo-redis-service.yaml` — ClusterIP (6379)
- `tempo-externalsecret.yaml` — Garage credentials from Doppler

## Phased Instrumentation

1. **Phase 1** (this implementation): Tempo + Alloy pipeline + Redis + Grafana datasource + metrics-generator
2. **Phase 2**: LiteLLM Proxy (built-in OTEL), Gateway (Node.js OTEL SDK)
3. **Phase 3**: Ollama, Triton, portfolio apps (SDK instrumentation per language)

## Resource Summary

| Component | CPU Request | Memory Request | Memory Limit |
|-----------|-------------|----------------|--------------|
| Tempo monolithic | 100m | 512Mi | 2Gi |
| tempo-redis | 50m | 256Mi | 2Gi |
| **Total new** | **150m** | **768Mi** | **4Gi** |

## Notes

- gRPC h2c: Not needed — Alloy→Tempo is ClusterIP (no ingress), HTTP/2 works natively
- Loki stays on ASUSTOR NAS — no in-cluster Loki needed. Grafana queries it over WireGuard
- Marmoset (GPU node) runs Alloy as a K3s DaemonSet — inference servers can send traces to local Alloy
