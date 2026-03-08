# Home Network Security & Observability Platform

## Date: 2026-03-06

## Overview

A bidirectional monitoring and security architecture where VPS nodes act as external sentinels probing the home network from the outside, while CrowdSec + Loki + AdGuard Home provide internal security and observability. Grafana Alloy is the single observability agent on every node, handling metrics, logs, and probes through one config.

## Goals

1. **Threat detection & blocking**: CrowdSec engine analyzes Traefik access logs and router logs, propagates ban decisions to Traefik bouncers on all VPS nodes
2. **DNS protection**: AdGuard Home blocks malicious/phishing domains for all LAN devices
3. **Centralized logging**: Loki on ASUSTOR aggregates logs from all nodes (VPS, NAS, router, local GPU)
4. **External probing**: VPS nodes probe home network availability, latency, and perimeter security
5. **Storage redundancy**: Multi-node Garage cluster across ASUSTOR + Synology with native replication

## Infrastructure

### Existing

| Node | Role | Specs | WireGuard IP |
|------|------|-------|-------------|
| vmi2951245 | K3s control plane | 12 cores, 48GB | 10.0.0.1 |
| vmi3115606 | K3s worker | 8 cores, 24GB | 10.0.0.2 |
| marmoset | K3s local GPU node | 8 cores, 16GB | 10.0.0.3 |
| ASUS BE88U | Router (Merlin firmware) | - | LAN only |
| ASUSTOR AS5202T | NAS (Docker) | - | 10.0.0.4 (NEW) |
| Synology DS423 | NAS (Docker) | - | LAN only |

### New Components

#### ASUSTOR AS5202T (Docker Compose)

| Container | Role | Ports |
|-----------|------|-------|
| Garage | S3 storage, multi-node cluster with Synology | LAN: S3 API + RPC |
| Loki | Centralized log aggregation, stores in Garage | 10.0.0.4:3100 (WG + LAN) |
| CrowdSec Engine (LAPI) | Central security decision engine | 10.0.0.4:8080 (WG only) |
| AdGuard Home | DNS server, blocks malicious domains | LAN IP:53 (DNS), LAN IP:3001 (WebUI) |
| Grafana | Home network + security dashboards | 10.0.0.4:3000 (WG only) |
| Grafana Alloy | Syslog receiver, SNMP collector, host metrics, ships to Loki + Mimir | UDP/514 (syslog) |
| cAdvisor | Container metrics (scraped by Alloy) | localhost:8081 |

#### Synology DS423 (Docker)

| Container | Role |
|-----------|------|
| Garage | Replica node in Garage cluster (replication factor 2) |
| Grafana Alloy | Ships Synology logs to Loki, host metrics to Mimir |
| cAdvisor | Container metrics (scraped by Alloy) |

#### VPS Nodes (K3s)

| Component | Nodes | Role |
|-----------|-------|------|
| Grafana Alloy DaemonSet | All 3 K3s nodes | Logs to Loki, metrics to Mimir, blackbox probes, CrowdSec metrics scraping |
| CrowdSec Log Processor DaemonSet | vmi2951245 + vmi3115606 | Parses Traefik logs locally, sends alerts to LAPI over WireGuard |
| Traefik Bouncer Plugin | vmi2951245 + vmi3115606 | Traefik middleware, queries LAPI for ban decisions |
| nmap CronJob | One VPS node | Scheduled perimeter audit of home DDNS hostname |
| Speedtest + Traceroute CronJob | One VPS node | ISP performance monitoring |

#### marmoset

| Component | Role |
|-----------|------|
| Grafana Alloy DaemonSet | Logs to Loki, metrics to Mimir |
| CrowdSec Log Processor | Alerts to LAPI |
| No bouncer | Cloudflare Tunnel + WAF sufficient |

## Networking

### WireGuard Mesh

```
10.0.0.1 -- vmi2951245 (control plane)
10.0.0.2 -- vmi3115606 (worker)
10.0.0.3 -- marmoset (local GPU)
10.0.0.4 -- ASUSTOR AS5202T (NEW)
```

ASUSTOR joins the existing WireGuard mesh as 10.0.0.4/24. Peer configs added to all existing nodes.

### Service Endpoints

| Service | Address | Access |
|---------|---------|--------|
| CrowdSec LAPI | 10.0.0.4:8080 | WireGuard only |
| Loki | 10.0.0.4:3100 | WireGuard + LAN |
| Grafana (home) | 10.0.0.4:3000 | WireGuard only |
| AdGuard Home DNS | ASUSTOR LAN IP:53 | LAN only |
| AdGuard Home WebUI | ASUSTOR LAN IP:3001 | LAN only |
| Mimir | mimir-monolithic.monitoring.svc.cluster.local:8080 | K3s internal, reachable from WG via pod CIDR |
| Grafana (K3s) | grafana.el-jefe.me | Public (existing, unchanged) |
| Garage S3 | LAN only (ASUSTOR <-> Synology) | LAN only |

## Alloy Configurations

### VPS Nodes (vmi2951245, vmi3115606)

```
loki.source.file       -> tail Traefik access logs + container logs
loki.source.journal    -> systemd journal
prometheus.exporter.unix -> host CPU/mem/disk/net
prometheus.exporter.blackbox:
  - ICMP probe -> home DDNS hostname (latency/availability)
  - HTTP probe -> embeddings.el-jefe.me, el-jefe.me, *.el-jefe.me
  - TCP probes -> home DDNS:specific_ports (perimeter check)
prometheus.scrape      -> CrowdSec log processor /metrics
prometheus.remote_write -> Mimir
loki.write             -> Loki (10.0.0.4:3100)
```

### ASUSTOR

```
loki.source.syslog     -> receive UDP/514 from Merlin + ASUSTOR
prometheus.exporter.snmp -> poll Merlin router SNMP OIDs
prometheus.exporter.unix -> ASUSTOR host metrics
prometheus.scrape      -> cAdvisor, CrowdSec LAPI /metrics, AdGuard stats
prometheus.remote_write -> Mimir (over WireGuard)
loki.write             -> Loki (localhost)
```

### Synology DS423

```
loki.source.file        -> Synology system logs
prometheus.exporter.unix -> host metrics
prometheus.scrape       -> cAdvisor, Garage metrics
prometheus.remote_write -> Mimir (over WireGuard or LAN via ASUSTOR)
loki.write             -> Loki on ASUSTOR
```

### marmoset

```
loki.source.file        -> container logs
loki.source.journal     -> systemd journal
prometheus.exporter.unix -> host metrics
prometheus.scrape       -> CrowdSec log processor /metrics
prometheus.remote_write -> Mimir
loki.write             -> Loki (10.0.0.4:3100)
```

## Data Flows

### Security Pipeline (CrowdSec)

```
Merlin syslog --> Alloy (ASUSTOR) --> file --> CrowdSec Engine
AdGuard DNS query logs --> CrowdSec Engine (malicious domain detection)
VPS Traefik access logs --> CrowdSec Log Processor (local parse) --> alerts --> LAPI (10.0.0.4:8080)
LAPI --> Traefik Bouncer Plugin (vmi2951245 + vmi3115606)

Decision propagation: detection on any node -> all bouncers updated
```

### DNS Protection (AdGuard Home)

```
LAN devices --> AdGuard Home (ASUSTOR LAN IP:53) --> upstream DNS (Cloudflare DoH)
Blocklists: OISD, Steven Black, CrowdSec community DNS blocklist
Query logs --> Alloy --> Loki
```

Merlin DHCP configured to hand out ASUSTOR LAN IP as DNS server for all clients.

### Observability - Logs (Loki)

```
Merlin syslog ---------> Alloy (ASUSTOR) --> Loki --> Garage (ASUSTOR + Synology)
ASUSTOR syslog --------> Alloy (ASUSTOR) --> Loki
Synology logs ----------> Alloy (Synology) --> Loki
VPS container/Traefik --> Alloy DaemonSet --> Loki (over WireGuard)
marmoset containers ----> Alloy DaemonSet --> Loki (over WireGuard)
AdGuard query logs -----> Alloy (ASUSTOR) --> Loki
```

### Observability - Metrics (Mimir)

```
SNMP (Merlin router) --> Alloy (ASUSTOR) --> Mimir
Host metrics (all nodes) --> Alloy --> Mimir
Container metrics --> cAdvisor --> Alloy --> Mimir
Blackbox probes --> Alloy (VPS nodes) --> Mimir
CrowdSec metrics --> Alloy --> Mimir
AdGuard metrics --> Alloy --> Mimir
Speedtest/Traceroute --> CronJob --> Loki or Mimir
```

### Perimeter Audit

```
nmap CronJob (VPS) --> scan home DDNS hostname --> results to Loki + alert on unexpected ports
Blackbox TCP probes (Alloy) --> continuous port monitoring --> Mimir
```

## CrowdSec Configuration

### Engine (LAPI on ASUSTOR)

- **Collections**: crowdsecurity/traefik, crowdsecurity/linux, crowdsecurity/syslog
- **Scenarios**: HTTP brute force, bad user agents, path traversal, port scanning, DNS-based threats
- **Console**: Enroll in CrowdSec Console for community blocklists
- **Metrics**: Prometheus endpoint scraped by Alloy

### Log Processors (VPS DaemonSets)

- Tail /var/log/traefik/access.log on host
- Parse with crowdsecurity/traefik collection
- Send alerts to LAPI at 10.0.0.4:8080 over WireGuard
- Expose /metrics for Alloy to scrape

### Bouncers (Traefik Plugin)

- Traefik middleware plugin on vmi2951245 + vmi3115606
- Configured via HelmChartConfig (existing Traefik config pattern)
- Queries LAPI at 10.0.0.4:8080 for decisions on each request
- Decision cache TTL for performance

## Storage Architecture

### Garage Multi-Node Cluster

```
ASUSTOR AS5202T <--LAN--> Synology DS423
     Garage node              Garage node
     (primary writes)         (replica)
     Replication factor: 2
```

- Single Garage cluster spanning both NAS devices
- Loki writes chunks and indexes to Garage S3 API on localhost (ASUSTOR)
- Garage replicates to Synology automatically
- Both nodes must be online for writes (replication factor 2 with 2 nodes)

### Loki Storage Config

- chunks: s3://loki-chunks (Garage)
- index: s3://loki-index (Garage)
- Retention: TBD based on ASUSTOR + Synology available storage

## Grafana Instances

### K3s Grafana (existing, unchanged)

- URL: grafana.el-jefe.me
- Datasources: Mimir (localhost), Prometheus (localhost)
- Purpose: K3s cluster dashboards, application monitoring

### ASUSTOR Grafana (new)

- URL: 10.0.0.4:3000 (WireGuard only)
- Datasources:
  - Loki (localhost:3100) - centralized logs
  - Mimir (over WireGuard) - all metrics
  - CrowdSec LAPI - security decisions/alerts
- Purpose: Home network security, NAS health, DNS analytics, ISP performance, perimeter audit
- Dashboards:
  - CrowdSec threat overview (attacks, bans, decisions)
  - AdGuard DNS analytics (queries, blocked domains, top clients)
  - Home network availability (blackbox probe results)
  - NAS health (ASUSTOR + Synology disk/CPU/memory)
  - Router stats (SNMP - bandwidth, connections, CPU)
  - ISP performance (speedtest, traceroute, latency trends)
  - Perimeter audit (nmap results, unexpected open ports)

## DNS Setup (Merlin -> AdGuard)

1. AdGuard Home runs on ASUSTOR, listens on LAN IP port 53
2. Merlin DHCP settings: set DNS server to ASUSTOR LAN IP
3. AdGuard upstream DNS: Cloudflare DoH (https://dns.cloudflare.com/dns-query)
4. Blocklists: OISD, Steven Black unified hosts, CrowdSec community DNS list
5. Query logs shipped to Loki via Alloy for analysis and CrowdSec threat detection

## Implementation Order

1. Deploy Garage on ASUSTOR + Synology, form cluster
2. Deploy Loki on ASUSTOR, configure Garage S3 backend
3. Deploy Grafana Alloy on ASUSTOR (syslog receiver, SNMP, host metrics)
4. Add ASUSTOR to WireGuard mesh as 10.0.0.4
5. Deploy Alloy DaemonSet on K3s (replaces per-node Promtail if any)
6. Deploy CrowdSec Engine (LAPI) on ASUSTOR
7. Deploy CrowdSec Log Processor DaemonSet on VPS nodes
8. Configure Traefik Bouncer Plugin on VPS nodes
9. Deploy AdGuard Home on ASUSTOR, configure Merlin DHCP
10. Deploy Grafana on ASUSTOR, configure datasources and dashboards
11. Deploy nmap + speedtest/traceroute CronJobs on VPS
12. Deploy Alloy + cAdvisor on Synology
13. Configure Merlin syslog + SNMP export to ASUSTOR
14. Test end-to-end: trigger CrowdSec scenario, verify bouncer blocks, verify logs in Loki, verify metrics in Mimir
