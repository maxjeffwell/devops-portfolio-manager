# Home Network Security & Observability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy a bidirectional monitoring and security platform with CrowdSec, Loki, AdGuard Home, and Grafana Alloy across a hybrid K3s cluster and two NAS devices.

**Architecture:** ASUSTOR AS5202T is the security/observability hub (CrowdSec LAPI, Loki, AdGuard Home, Grafana) with Garage S3 storage replicated to Synology DS423. VPS nodes run Alloy DaemonSets for metrics/logs/probes and CrowdSec log processors + Traefik bouncers for security. WireGuard mesh connects everything.

**Tech Stack:** Garage (S3), Loki, Grafana Alloy, CrowdSec, AdGuard Home, Grafana, Docker Compose (NAS), Helm/K3s (VPS), WireGuard

**Important:** Before starting, verify actual WireGuard IPs on each node (`ip addr show wg0`). The UFW rules file says `vmi2951245=10.0.0.1, marmoset=10.0.0.2, vmi3115606=10.0.0.3`. Confirm this matches reality. The ASUSTOR will be `10.0.0.4`.

---

## Phase 1: Garage Storage Cluster

### Task 1.1: Deploy Garage on ASUSTOR

**Files:**
- Create: `~/nas-configs/asustor/docker-compose.yml` (on ASUSTOR)
- Create: `~/nas-configs/asustor/garage/garage.toml`

**Step 1: Create Garage config directory on ASUSTOR**

SSH into ASUSTOR and create the project structure:

```bash
ssh asustor
mkdir -p ~/observability-stack/garage/data ~/observability-stack/garage/meta
```

**Step 2: Create garage.toml for ASUSTOR node**

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"

replication_factor = 2

[rpc]
bind_addr = "[::]:3901"
# Replace with ASUSTOR's LAN IP
rpc_bind_addr = "ASUSTOR_LAN_IP:3901"
secret = "GENERATE_WITH_openssl_rand_hex_32"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[s3_web]
bind_addr = "[::]:3902"

[admin]
api_bind_addr = "[::]:3903"
admin_token = "GENERATE_WITH_openssl_rand_hex_32"
```

Generate secrets:
```bash
openssl rand -hex 32  # rpc_secret
openssl rand -hex 32  # admin_token
```

**Step 3: Create initial docker-compose.yml with just Garage**

```yaml
services:
  garage:
    image: dxflrs/garage:v1.1.0
    container_name: garage
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./garage/garage.toml:/etc/garage.toml:ro
      - ./garage/meta:/var/lib/garage/meta
      - ./garage/data:/var/lib/garage/data
```

**Step 4: Start Garage and verify**

```bash
cd ~/observability-stack
docker compose up -d garage
docker exec garage /garage status
```

Expected: Single node shown, no peers yet.

**Step 5: Note the Garage node ID**

```bash
docker exec garage /garage node id
```

Save the full node ID (including `@ASUSTOR_LAN_IP:3901`) — needed for Synology peering.

---

### Task 1.2: Deploy Garage on Synology DS423

**Files:**
- Create: `~/observability-stack/garage/garage.toml` (on Synology)
- Create: `~/observability-stack/docker-compose.yml` (on Synology)

**Step 1: Create directory structure on Synology**

```bash
ssh synology
mkdir -p ~/observability-stack/garage/data ~/observability-stack/garage/meta
```

**Step 2: Create garage.toml for Synology node**

Same config as ASUSTOR but with Synology's LAN IP:
```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"

replication_factor = 2

[rpc]
bind_addr = "[::]:3901"
rpc_bind_addr = "SYNOLOGY_LAN_IP:3901"
# MUST be the same secret as ASUSTOR
secret = "SAME_RPC_SECRET_AS_ASUSTOR"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[s3_web]
bind_addr = "[::]:3902"

[admin]
api_bind_addr = "[::]:3903"
admin_token = "SAME_ADMIN_TOKEN_AS_ASUSTOR"
```

**Step 3: Create docker-compose.yml**

```yaml
services:
  garage:
    image: dxflrs/garage:v1.1.0
    container_name: garage
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./garage/garage.toml:/etc/garage.toml:ro
      - ./garage/meta:/var/lib/garage/meta
      - ./garage/data:/var/lib/garage/data
```

**Step 4: Start Garage and connect to ASUSTOR**

```bash
docker compose up -d garage
# Connect to ASUSTOR's Garage node (use node ID from Task 1.1 Step 5)
docker exec garage /garage node connect ASUSTOR_NODE_ID@ASUSTOR_LAN_IP:3901
```

**Step 5: Verify cluster formation**

```bash
docker exec garage /garage status
```

Expected: Two nodes shown, both connected.

---

### Task 1.3: Configure Garage Layout and Create Buckets

**Step 1: Assign roles to both nodes**

Run from either node:
```bash
# Get node IDs (short form)
docker exec garage /garage status
# Assign zone and capacity (adjust capacity to match available disk in GB)
docker exec garage /garage layout assign ASUSTOR_SHORT_ID -z asustor -c 500G -t asustor
docker exec garage /garage layout assign SYNOLOGY_SHORT_ID -z synology -c 500G -t synology
docker exec garage /garage layout apply --version 1
```

**Step 2: Create S3 access key**

```bash
docker exec garage /garage key create loki-service-account
```

Save the `Key ID` and `Secret key` output — needed for Loki config.

**Step 3: Create Loki buckets**

```bash
docker exec garage /garage bucket create loki-chunks
docker exec garage /garage bucket create loki-ruler
docker exec garage /garage bucket allow --read --write --owner loki-service-account --bucket loki-chunks
docker exec garage /garage bucket allow --read --write --owner loki-service-account --bucket loki-ruler
```

**Step 4: Verify buckets**

```bash
docker exec garage /garage bucket list
```

Expected: `loki-chunks` and `loki-ruler` listed.

**Step 5: Test S3 access (optional)**

```bash
# From ASUSTOR
apt-get install -y awscli || pip install awscli
AWS_ACCESS_KEY_ID=KEY_ID AWS_SECRET_ACCESS_KEY=SECRET_KEY \
  aws --endpoint-url http://localhost:3900 s3 ls
```

Expected: Both buckets listed.

---

## Phase 2: WireGuard Mesh Expansion

### Task 2.1: Add ASUSTOR to WireGuard Mesh

**Files:**
- Create: WireGuard config on ASUSTOR
- Modify: WireGuard peer configs on vmi2951245, vmi3115606 (or marmoset — verify which is 10.0.0.2/3)

**Step 1: Verify current WireGuard IPs on all nodes**

```bash
# On each node:
ssh vmi2951245 "ip addr show wg0 | grep inet"
ssh marmoset "ip addr show wg0 | grep inet"
# vmi3115606 - verify from marmoset or control plane
```

Confirm: vmi2951245=10.0.0.1, and which of marmoset/vmi3115606 is .2 vs .3.

**Step 2: Generate WireGuard keypair on ASUSTOR**

```bash
ssh asustor
# Install wireguard-tools if not present
wg genkey | tee /etc/wireguard/privatekey | wg pubkey > /etc/wireguard/publickey
cat /etc/wireguard/publickey
```

**Step 3: Create WireGuard config on ASUSTOR**

Create `/etc/wireguard/wg0.conf`:

```ini
[Interface]
Address = 10.0.0.4/24
PrivateKey = ASUSTOR_PRIVATE_KEY
ListenPort = 51820
MTU = 1280

[Peer]
# vmi2951245 (control plane)
PublicKey = VMI2951245_PUBKEY
Endpoint = VMI2951245_PUBLIC_IP:51820
AllowedIPs = 10.0.0.1/32, 10.42.0.0/24
PersistentKeepalive = 25

[Peer]
# marmoset or vmi3115606 (whichever is 10.0.0.2)
PublicKey = NODE2_PUBKEY
Endpoint = NODE2_PUBLIC_OR_LAN_IP:51820
AllowedIPs = 10.0.0.2/32, 10.42.1.0/24
PersistentKeepalive = 25

[Peer]
# the other node (10.0.0.3)
PublicKey = NODE3_PUBKEY
Endpoint = NODE3_PUBLIC_OR_LAN_IP:51820
AllowedIPs = 10.0.0.3/32, 10.42.2.0/24
PersistentKeepalive = 25
```

Note: marmoset is on the same LAN as ASUSTOR, so use its LAN IP as endpoint. For VPS nodes, use public IPs.

**Step 4: Add ASUSTOR as peer on all existing nodes**

On each existing node, add to `/etc/wireguard/wg0.conf`:

```ini
[Peer]
# ASUSTOR AS5202T
PublicKey = ASUSTOR_PUBKEY
Endpoint = ASUSTOR_PUBLIC_IP_OR_DDNS:51820
AllowedIPs = 10.0.0.4/32
PersistentKeepalive = 25
```

Note: VPS nodes need the home DDNS hostname as endpoint (since home IP is dynamic). marmoset can use ASUSTOR's LAN IP.

**Step 5: Bring up WireGuard on ASUSTOR**

```bash
wg-quick up wg0
# Enable on boot
systemctl enable wg-quick@wg0
```

**Step 6: Reload WireGuard on existing nodes**

```bash
# On each existing node:
wg syncconf wg0 <(wg-quick strip wg0)
```

**Step 7: Verify connectivity**

```bash
# From ASUSTOR:
ping -c 3 10.0.0.1  # vmi2951245
ping -c 3 10.0.0.2  # node 2
ping -c 3 10.0.0.3  # node 3

# From vmi2951245:
ping -c 3 10.0.0.4  # ASUSTOR
```

All pings should succeed.

**Step 8: Update k3s-cluster-config repo**

Add ASUSTOR config to `/home/maxjeffwell/GitHub_Projects/k3s-cluster-config/nodes/`:

```bash
mkdir -p nodes/asustor
# Document the WireGuard config (without private keys)
```

**Step 9: Commit**

```bash
cd /home/maxjeffwell/GitHub_Projects/k3s-cluster-config
git add nodes/asustor/
git commit -m "feat: add ASUSTOR AS5202T to WireGuard mesh as 10.0.0.4"
```

---

### Task 2.2: Port-forward ASUSTOR WireGuard Through Router

**Step 1: Configure port forwarding on Merlin**

In the ASUS router web UI (`Administration > WAN > Virtual Server / Port Forwarding`):
- External Port: 51820
- Internal IP: ASUSTOR LAN IP
- Internal Port: 51820
- Protocol: UDP

This allows VPS nodes to reach ASUSTOR's WireGuard endpoint via the home DDNS hostname.

**Step 2: Verify VPS can reach ASUSTOR**

```bash
# From vmi2951245:
ping -c 3 10.0.0.4
```

---

## Phase 3: Loki on ASUSTOR

### Task 3.1: Add Loki to ASUSTOR Docker Compose

**Files:**
- Modify: `~/observability-stack/docker-compose.yml` (on ASUSTOR)
- Create: `~/observability-stack/loki/loki-config.yaml`

**Step 1: Create Loki config**

```yaml
auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096
  log_level: info

common:
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: "2024-01-01"
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: loki_index_
        period: 24h

storage_config:
  tsdb_shipper:
    active_index_directory: /var/loki/tsdb-index
    cache_location: /var/loki/tsdb-cache
  aws:
    s3: http://GARAGE_KEY_ID:GARAGE_SECRET_KEY@localhost:3900/loki-chunks
    s3forcepathstyle: true
    region: garage

limits_config:
  retention_period: 720h
  max_query_length: 721h
  max_query_series: 100000

compactor:
  working_directory: /var/loki/compactor
  retention_enabled: true
  delete_request_store: filesystem
  compaction_interval: 10m

ruler:
  storage:
    type: s3
    s3:
      endpoint: localhost:3900
      bucketnames: loki-ruler
      access_key_id: GARAGE_KEY_ID
      secret_access_key: GARAGE_SECRET_KEY
      insecure: true
      s3forcepathstyle: true
```

**Step 2: Add Loki to docker-compose.yml**

```yaml
  loki:
    image: grafana/loki:3.4.2
    container_name: loki
    restart: unless-stopped
    ports:
      - "3100:3100"
    volumes:
      - ./loki/loki-config.yaml:/etc/loki/config.yaml:ro
      - loki-data:/var/loki
    command: -config.file=/etc/loki/config.yaml
    depends_on:
      - garage

volumes:
  loki-data:
```

**Step 3: Start Loki and verify**

```bash
docker compose up -d loki
# Wait a few seconds for startup
curl -s http://localhost:3100/ready
```

Expected: `ready`

**Step 4: Verify Loki can write to Garage**

```bash
# Push a test log entry
curl -s -X POST http://localhost:3100/loki/api/v1/push \
  -H "Content-Type: application/json" \
  -d '{"streams":[{"stream":{"job":"test"},"values":[["'$(date +%s)000000000'","hello from loki"]]}]}'

# Query it back
curl -s "http://localhost:3100/loki/api/v1/query?query={job=\"test\"}"
```

Expected: JSON response with the test log entry.

**Step 5: Verify data landed in Garage**

```bash
docker exec garage /garage bucket info loki-chunks
```

Expected: Non-zero object count.

---

## Phase 4: Alloy on ASUSTOR

### Task 4.1: Add Grafana Alloy to ASUSTOR Docker Compose

**Files:**
- Create: `~/observability-stack/alloy/config.alloy`
- Modify: `~/observability-stack/docker-compose.yml`

**Step 1: Create Alloy config for ASUSTOR**

```hcl
// ============================================
// ASUSTOR Alloy Config
// Receives syslog, collects SNMP, host metrics
// Ships logs to Loki, metrics to Mimir
// ============================================

// --- Syslog Receiver (from Merlin router + ASUSTOR) ---
loki.source.syslog "router_syslog" {
  listener {
    address  = "0.0.0.0:1514"
    protocol = "udp"
    labels   = { job = "syslog", source = "router" }
  }
  forward_to = [loki.write.local.receiver]
}

// --- SNMP Collection (Merlin Router) ---
prometheus.exporter.snmp "router" {
  target "merlin" {
    address = "MERLIN_ROUTER_LAN_IP"
    module  = "if_mib"
  }
}

prometheus.scrape "snmp" {
  targets    = prometheus.exporter.snmp.router.targets
  forward_to = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "60s"
}

// --- Host Metrics (ASUSTOR) ---
prometheus.exporter.unix "host" {
  set_collectors = ["cpu", "diskstats", "filesystem", "loadavg", "meminfo", "netdev", "uname"]
}

prometheus.scrape "host_metrics" {
  targets    = prometheus.exporter.unix.host.targets
  forward_to = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "30s"
}

// --- cAdvisor Scrape ---
prometheus.scrape "cadvisor" {
  targets = [{
    __address__ = "localhost:8081",
  }]
  forward_to = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "30s"
  job_name = "cadvisor-asustor"
}

// --- CrowdSec LAPI Metrics ---
prometheus.scrape "crowdsec" {
  targets = [{
    __address__ = "localhost:6060",
  }]
  forward_to = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "30s"
  job_name = "crowdsec-lapi"
  metrics_path = "/metrics"
}

// --- AdGuard Home Stats ---
// AdGuard exposes stats at /control/stats — use a custom scrape or exporter
// For now, ship AdGuard query logs via file tailing
loki.source.file "adguard_querylog" {
  targets = [{
    __path__ = "/var/log/adguardhome/querylog.json",
    job      = "adguard",
    source   = "adguard-home",
  }]
  forward_to = [loki.write.local.receiver]
}

// --- Write to Loki (localhost) ---
loki.write "local" {
  endpoint {
    url = "http://localhost:3100/loki/api/v1/push"
  }
}

// --- Write to Mimir (over WireGuard) ---
// Mimir is on K3s control plane. Route: 10.0.0.4 -> 10.0.0.1 -> pod CIDR
// Use the Mimir NodePort or the K3s node IP + port-forward
// Option: expose Mimir on WireGuard via NodePort
prometheus.remote_write "mimir" {
  endpoint {
    url = "http://10.0.0.1:MIMIR_NODEPORT/api/v1/push"
  }
}
```

Note: Mimir is currently cluster-internal (`mimir-monolithic.monitoring.svc.cluster.local:8080`). You need to either:
1. Create a NodePort service for Mimir (recommended — Task 4.2), or
2. Use `kubectl port-forward` (not production-ready), or
3. Expose via Traefik IngressRoute on a WireGuard-only IP

**Step 2: Add Alloy + cAdvisor to docker-compose.yml**

```yaml
  alloy:
    image: grafana/alloy:v1.8.0
    container_name: alloy
    restart: unless-stopped
    ports:
      - "1514:1514/udp"   # syslog receiver
      - "12345:12345"     # Alloy UI
    volumes:
      - ./alloy/config.alloy:/etc/alloy/config.alloy:ro
      - /var/log:/var/log:ro
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
    command:
      - run
      - /etc/alloy/config.alloy
      - --storage.path=/var/lib/alloy/data
    depends_on:
      - loki

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.51.0
    container_name: cadvisor
    restart: unless-stopped
    ports:
      - "8081:8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    privileged: true
```

**Step 3: Start and verify**

```bash
docker compose up -d alloy cadvisor
# Check Alloy UI
curl -s http://localhost:12345/api/v0/health
# Check cAdvisor
curl -s http://localhost:8081/metrics | head -5
```

---

### Task 4.2: Expose Mimir on WireGuard via NodePort

**Files:**
- Create: `/home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/k8s/monitoring/mimir-nodeport.yaml`

The ASUSTOR and Synology need to remote-write metrics to Mimir over WireGuard. Mimir is currently only accessible inside the K3s cluster.

**Step 1: Create NodePort service**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: mimir-monolithic-wireguard
  namespace: monitoring
  labels:
    app: mimir-monolithic
spec:
  type: NodePort
  selector:
    app: mimir-monolithic
  ports:
    - port: 8080
      targetPort: 8080
      nodePort: 30090
      protocol: TCP
      name: http
```

**Step 2: Apply and verify**

```bash
kubectl apply -f k8s/monitoring/mimir-nodeport.yaml
# Test from ASUSTOR over WireGuard:
curl -s http://10.0.0.1:30090/ready
```

Expected: `ready`

**Step 3: Update UFW on VPS nodes to allow NodePort from WireGuard**

The existing UFW rules allow 10.0.0.0/24 for specific ports. Add Mimir NodePort:

```bash
# On vmi2951245:
ufw allow from 10.0.0.0/24 to any port 30090 proto tcp comment 'Mimir NodePort - WG only'
```

**Step 4: Update Alloy config with actual Mimir endpoint**

In `alloy/config.alloy`, update the remote_write URL:
```hcl
prometheus.remote_write "mimir" {
  endpoint {
    url = "http://10.0.0.1:30090/api/v1/push"
  }
}
```

**Step 5: Commit**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add k8s/monitoring/mimir-nodeport.yaml
git commit -m "feat: expose Mimir on NodePort 30090 for WireGuard access from NAS devices"
```

---

## Phase 5: Update K3s Alloy DaemonSet

### Task 5.1: Update Alloy Config to Ship Logs to ASUSTOR Loki

**Files:**
- Modify: `/home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring/templates/alloy-config.yaml`

The existing Alloy DaemonSet ships logs to the in-cluster Loki. Update it to ship to ASUSTOR Loki instead (or both).

**Step 1: Update Loki write endpoint**

Change the `loki.write` block to point to ASUSTOR:

```hcl
loki.write "default" {
  endpoint {
    url = "http://10.0.0.4:3100/loki/api/v1/push"
  }
}
```

**Step 2: Add blackbox probes for home network**

Add to the Alloy config template:

```hcl
// --- Blackbox Probes (VPS -> Home Network) ---
prometheus.exporter.blackbox "home_network" {
  config = "{ modules: { icmp_probe: { prober: icmp, timeout: 5s }, http_2xx: { prober: http, timeout: 10s, http: { valid_http_versions: ['HTTP/1.1', 'HTTP/2.0'], valid_status_codes: [200, 301, 302] } }, tcp_connect: { prober: tcp, timeout: 5s } } }"

  target "home_icmp" {
    address = "YOUR_DDNS_HOSTNAME"
    module  = "icmp_probe"
  }
  target "embeddings_http" {
    address = "https://embeddings.el-jefe.me"
    module  = "http_2xx"
  }
  target "eljefe_http" {
    address = "https://el-jefe.me"
    module  = "http_2xx"
  }
}

prometheus.scrape "blackbox" {
  targets    = prometheus.exporter.blackbox.home_network.targets
  forward_to = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "60s"
}
```

**Step 3: Add host metrics (unix exporter)**

```hcl
prometheus.exporter.unix "node" {
  set_collectors = ["cpu", "diskstats", "filesystem", "loadavg", "meminfo", "netdev", "uname"]
}

prometheus.scrape "node_metrics" {
  targets    = prometheus.exporter.unix.node.targets
  forward_to = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "30s"
}
```

**Step 4: Add systemd journal collection**

```hcl
loki.source.journal "systemd" {
  forward_to = [loki.write.default.receiver]
  labels     = { job = "systemd-journal" }
}
```

**Step 5: Add Mimir remote_write**

```hcl
prometheus.remote_write "mimir" {
  endpoint {
    url = "http://mimir-monolithic.monitoring.svc.cluster.local:8080/api/v1/push"
  }
}
```

Note: K3s Alloy uses the in-cluster Mimir URL (not NodePort) since it's running inside the cluster.

**Step 6: Update Alloy DaemonSet volumes for journal access**

In `values.yaml`, add journal volume mount:

```yaml
alloy:
  alloy:
    mounts:
      varlog: true
      dockercontainers: true
      extra:
        - name: geoip-db
          mountPath: /usr/share/GeoIP
          readOnly: true
        - name: journal
          mountPath: /var/log/journal
          readOnly: true
  controller:
    volumes:
      extra:
        - name: geoip-db
          hostPath:
            path: /usr/share/GeoIP
            type: Directory
        - name: journal
          hostPath:
            path: /var/log/journal
            type: Directory
```

**Step 7: Test by templating the chart**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring
helm template monitoring . --debug 2>&1 | grep -A5 "loki.write"
```

**Step 8: Commit**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add helm-charts/monitoring/
git commit -m "feat: update Alloy DaemonSet to ship logs to ASUSTOR Loki, add blackbox probes and host metrics"
```

---

## Phase 6: CrowdSec Engine on ASUSTOR

### Task 6.1: Deploy CrowdSec LAPI

**Files:**
- Create: `~/observability-stack/crowdsec/acquis.yaml` (on ASUSTOR)
- Modify: `~/observability-stack/docker-compose.yml`

**Step 1: Create CrowdSec acquisition config**

```yaml
# Router syslog (written by Alloy syslog receiver)
filenames:
  - /var/log/syslog-router/*.log
labels:
  type: syslog
---
# AdGuard Home query logs
filenames:
  - /var/log/adguardhome/querylog.json
labels:
  type: adguard
```

**Step 2: Add CrowdSec to docker-compose.yml**

```yaml
  crowdsec:
    image: crowdsecurity/crowdsec:v1.6.8
    container_name: crowdsec
    restart: unless-stopped
    ports:
      - "10.0.0.4:8080:8080"  # LAPI - WireGuard only
      - "6060:6060"           # Prometheus metrics
    environment:
      COLLECTIONS: "crowdsecurity/traefik crowdsecurity/linux crowdsecurity/syslog"
      GID: "1000"
    volumes:
      - ./crowdsec/acquis.yaml:/etc/crowdsec/acquis.yaml:ro
      - crowdsec-config:/etc/crowdsec
      - crowdsec-data:/var/lib/crowdsec/data
      - /var/log/syslog-router:/var/log/syslog-router:ro
      - adguard-data:/var/log/adguardhome:ro

volumes:
  crowdsec-config:
  crowdsec-data:
```

Note: Binding LAPI to `10.0.0.4:8080` ensures it's only reachable over WireGuard.

**Step 3: Start CrowdSec and verify**

```bash
docker compose up -d crowdsec
docker exec crowdsec cscli hub list
docker exec crowdsec cscli metrics
```

**Step 4: Enroll in CrowdSec Console (optional but recommended)**

```bash
docker exec crowdsec cscli console enroll YOUR_ENROLLMENT_KEY
```

Get enrollment key from https://app.crowdsec.net

**Step 5: Register bouncers for VPS Traefik instances**

```bash
# Create bouncer API keys for each VPS node
docker exec crowdsec cscli bouncers add traefik-vmi2951245
docker exec crowdsec cscli bouncers add traefik-vmi3115606
```

Save both bouncer API keys — needed for Phase 8.

**Step 6: Verify LAPI is reachable from VPS**

```bash
# From vmi2951245:
curl -s http://10.0.0.4:8080/v1/decisions | head
```

Expected: JSON response (empty decisions list initially).

---

## Phase 7: CrowdSec Log Processors on VPS

### Task 7.1: Deploy CrowdSec Log Processor DaemonSet

**Files:**
- Create: `/home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring/templates/crowdsec-log-processor-daemonset.yaml`
- Create: `/home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring/templates/crowdsec-log-processor-config.yaml`

**Step 1: Create CrowdSec log processor ConfigMap**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: crowdsec-log-processor-config
  namespace: {{ .Release.Namespace }}
data:
  acquis.yaml: |
    filenames:
      - /var/log/traefik/access.log
    labels:
      type: traefik
  local_api_credentials.yaml: |
    url: http://10.0.0.4:8080
    login: {{ .Values.crowdsec.logProcessor.login }}
    password: {{ .Values.crowdsec.logProcessor.password }}
```

Note: Log processors authenticate to LAPI. You need to register them:
```bash
# On ASUSTOR:
docker exec crowdsec cscli machines add vps-log-processor-1 --password PASSWORD1
docker exec crowdsec cscli machines add vps-log-processor-2 --password PASSWORD2
```

**Step 2: Create DaemonSet**

```yaml
{{- if .Values.crowdsec.logProcessor.enabled }}
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: crowdsec-log-processor
  namespace: {{ .Release.Namespace }}
  labels:
    app: crowdsec-log-processor
spec:
  selector:
    matchLabels:
      app: crowdsec-log-processor
  template:
    metadata:
      labels:
        app: crowdsec-log-processor
    spec:
      # Only run on VPS nodes with Traefik
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: kubernetes.io/hostname
                    operator: In
                    values:
                      - vmi2951245
                      - vmi3115606
      containers:
        - name: crowdsec
          image: crowdsecurity/crowdsec:v1.6.8
          env:
            - name: DISABLE_LOCAL_API
              value: "true"
            - name: AGENT_USERNAME
              valueFrom:
                secretKeyRef:
                  name: crowdsec-log-processor-credentials
                  key: username
            - name: AGENT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: crowdsec-log-processor-credentials
                  key: password
            - name: LOCAL_API_URL
              value: "http://10.0.0.4:8080"
            - name: COLLECTIONS
              value: "crowdsecurity/traefik"
          ports:
            - containerPort: 6060
              name: metrics
          volumeMounts:
            - name: traefik-logs
              mountPath: /var/log/traefik
              readOnly: true
            - name: acquis-config
              mountPath: /etc/crowdsec/acquis.yaml
              subPath: acquis.yaml
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              memory: 256Mi
      volumes:
        - name: traefik-logs
          hostPath:
            path: /var/log/traefik
            type: Directory
        - name: acquis-config
          configMap:
            name: crowdsec-log-processor-config
{{- end }}
```

**Step 3: Create credentials Secret**

```bash
kubectl create secret generic crowdsec-log-processor-credentials \
  -n monitoring \
  --from-literal=username=vps-log-processor \
  --from-literal=password=PASSWORD_FROM_CSCLI
```

Or use ExternalSecrets/Doppler to manage this.

**Step 4: Add values.yaml entries**

```yaml
crowdsec:
  logProcessor:
    enabled: true
    login: "vps-log-processor"
    password: "SET_VIA_HELM_INSTALL"
```

**Step 5: Deploy and verify**

```bash
helm upgrade monitoring helm-charts/monitoring -n monitoring
kubectl get ds crowdsec-log-processor -n monitoring
kubectl logs -l app=crowdsec-log-processor -n monitoring --tail=20
```

Expected: Pods running on vmi2951245 and vmi3115606, tailing Traefik logs.

**Step 6: Verify alerts flow to LAPI**

```bash
# On ASUSTOR:
docker exec crowdsec cscli alerts list
docker exec crowdsec cscli machines list
```

Expected: Both VPS machines registered.

**Step 7: Commit**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add helm-charts/monitoring/
git commit -m "feat: add CrowdSec log processor DaemonSet for VPS Traefik log analysis"
```

---

## Phase 8: Traefik Bouncer Plugin

### Task 8.1: Configure CrowdSec Traefik Bouncer

**Files:**
- Modify: `/home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/k8s/traefik/helmchartconfig.yaml`

**Step 1: Add CrowdSec bouncer plugin to Traefik HelmChartConfig**

The CrowdSec Traefik bouncer is a middleware plugin. Add it to the existing `helmchartconfig.yaml`:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    # --- Existing config (keep all of it) ---
    ports:
      websecure:
        forwardedHeaders:
          trustedIPs:
          # ... (keep existing Cloudflare IPs) ...
    service:
      spec:
        externalTrafficPolicy: Local
    logs:
      access:
        enabled: true
        format: common
        filePath: "/var/log/traefik/access.log"
    deployment:
      additionalVolumes:
      - name: access-logs
        hostPath:
          path: /var/log/traefik
          type: DirectoryOrCreate
      initContainers:
      - name: fix-log-permissions
        image: busybox:1.37
        command: ["sh", "-c", "chown 65532:65532 /var/log/traefik"]
        securityContext:
          runAsUser: 0
          runAsNonRoot: false
        volumeMounts:
        - name: access-logs
          mountPath: /var/log/traefik
    additionalVolumeMounts:
    - name: access-logs
      mountPath: /var/log/traefik

    # --- NEW: CrowdSec Bouncer Plugin ---
    experimental:
      plugins:
        crowdsec-bouncer:
          moduleName: github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin
          version: v1.3.5

    additionalArguments:
      - "--experimental.plugins.crowdsec-bouncer.modulename=github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin"
      - "--experimental.plugins.crowdsec-bouncer.version=v1.3.5"
```

**Step 2: Create CrowdSec bouncer middleware**

Create `/home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/k8s/traefik/crowdsec-bouncer-middleware.yaml`:

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: crowdsec-bouncer
  namespace: kube-system
spec:
  plugin:
    crowdsec-bouncer:
      crowdsecLapiScheme: http
      crowdsecLapiHost: "10.0.0.4:8080"
      crowdsecLapiKey: "BOUNCER_API_KEY_FROM_TASK_6.1"
      updateIntervalSeconds: 15
      defaultDecisionSeconds: 300
      crowdsecMode: live
      forwardedHeadersTrustedIPs:
        - 173.245.48.0/20
        - 103.21.244.0/22
        - 103.22.200.0/22
        - 103.31.4.0/22
        - 141.101.64.0/18
        - 108.162.192.0/18
        - 190.93.240.0/20
        - 188.114.96.0/20
        - 197.234.240.0/22
        - 198.41.128.0/17
        - 162.158.0.0/15
        - 104.16.0.0/13
        - 104.24.0.0/14
        - 172.64.0.0/13
        - 131.0.72.0/22
      forwardedHeadersCustomName: "X-Forwarded-For"
```

Note: The `forwardedHeadersTrustedIPs` must match your Cloudflare IP ranges so the bouncer evaluates the real client IP, not Cloudflare's.

**Step 3: Apply the bouncer middleware to ingress routes**

For each app's Ingress, add the middleware annotation. Example for default IngressRoute-based apps:

```yaml
# In each app's ingress, add:
metadata:
  annotations:
    traefik.ingress.kubernetes.io/router.middlewares: kube-system-crowdsec-bouncer@kubernetescrd
```

Or create a default middleware chain that includes the bouncer.

**Step 4: Apply and verify**

```bash
kubectl apply -f k8s/traefik/helmchartconfig.yaml
kubectl apply -f k8s/traefik/crowdsec-bouncer-middleware.yaml

# Wait for Traefik to reload
kubectl rollout status deployment traefik -n kube-system

# Test: manually ban a test IP and verify it's blocked
# On ASUSTOR:
docker exec crowdsec cscli decisions add --ip 192.0.2.1 --reason "test" --duration 1m

# Verify decision exists:
curl -s http://10.0.0.4:8080/v1/decisions | python3 -m json.tool
```

**Step 5: Commit**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add k8s/traefik/
git commit -m "feat: add CrowdSec Traefik bouncer plugin for automated threat blocking"
```

---

## Phase 9: AdGuard Home

### Task 9.1: Deploy AdGuard Home on ASUSTOR

**Files:**
- Create: `~/observability-stack/adguardhome/` directory (on ASUSTOR)
- Modify: `~/observability-stack/docker-compose.yml`

**Step 1: Create AdGuard Home data directories**

```bash
mkdir -p ~/observability-stack/adguardhome/work ~/observability-stack/adguardhome/conf
```

**Step 2: Add AdGuard Home to docker-compose.yml**

```yaml
  adguardhome:
    image: adguard/adguardhome:v0.107.55
    container_name: adguardhome
    restart: unless-stopped
    ports:
      - "53:53/tcp"      # DNS
      - "53:53/udp"      # DNS
      - "3001:3000/tcp"  # Initial setup WebUI (changes to 3001 after setup)
    volumes:
      - ./adguardhome/work:/opt/adguardhome/work
      - ./adguardhome/conf:/opt/adguardhome/conf
      - adguard-data:/var/log/adguardhome
```

Note: Port 3000 is taken by Grafana, so map AdGuard's web UI to 3001.

**Step 3: Start and run initial setup**

```bash
docker compose up -d adguardhome
```

Access `http://ASUSTOR_LAN_IP:3001` in a browser and complete the setup wizard:
- Listen interface: All interfaces
- DNS port: 53
- Admin username/password: set securely
- Upstream DNS: `https://dns.cloudflare.com/dns-query` (DNS-over-HTTPS)
- Bootstrap DNS: `1.1.1.1`

**Step 4: Configure blocklists**

In AdGuard Home web UI (`Filters > DNS Blocklists`), add:
- OISD Big: `https://big.oisd.nl`
- Steven Black Unified: `https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts`
- (CrowdSec DNS blocklist can be added later via the CrowdSec Console integration)

**Step 5: Enable query logging**

In `Settings > General Settings`:
- Enable Query Log
- Log retention: 90 days (or adjust based on storage)

Verify query log file appears:
```bash
ls -la /var/log/adguardhome/
```

**Step 6: Configure Merlin to use AdGuard DNS**

In the ASUS router web UI:
- `LAN > DHCP Server > DNS Server`: Set to ASUSTOR's LAN IP
- Or: `LAN > DNS Director`: Force all DNS through ASUSTOR

**Step 7: Verify DNS resolution through AdGuard**

```bash
# From any LAN device:
nslookup google.com ASUSTOR_LAN_IP
# Should resolve normally

# Test blocking:
nslookup ads.google.com ASUSTOR_LAN_IP
# Should return 0.0.0.0 or NXDOMAIN
```

---

## Phase 10: Grafana on ASUSTOR

### Task 10.1: Deploy Grafana on ASUSTOR

**Files:**
- Create: `~/observability-stack/grafana/` directory
- Modify: `~/observability-stack/docker-compose.yml`

**Step 1: Create Grafana provisioning config**

Create `~/observability-stack/grafana/provisioning/datasources/datasources.yaml`:

```yaml
apiVersion: 1

datasources:
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    isDefault: true
    editable: true

  - name: Mimir
    type: prometheus
    access: proxy
    url: http://10.0.0.1:30090/prometheus
    editable: true

  # CrowdSec metrics are scraped by Alloy -> Mimir
  # Query CrowdSec metrics via the Mimir datasource
```

**Step 2: Add Grafana to docker-compose.yml**

```yaml
  grafana:
    image: grafana/grafana:11.5.2
    container_name: grafana
    restart: unless-stopped
    ports:
      - "10.0.0.4:3000:3000"  # WireGuard only
    environment:
      GF_SECURITY_ADMIN_PASSWORD: "CHANGE_ME"
      GF_SERVER_ROOT_URL: "http://10.0.0.4:3000"
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro

volumes:
  grafana-data:
```

**Step 3: Start and verify**

```bash
docker compose up -d grafana
# From a machine on the WireGuard mesh:
curl -s http://10.0.0.4:3000/api/health
```

Expected: `{"commit":"...","database":"ok","version":"..."}`

**Step 4: Verify datasources**

Access `http://10.0.0.4:3000` from a WireGuard-connected device. Go to `Connections > Data sources` and test both Loki and Mimir connections.

**Step 5: Import community dashboards**

Recommended dashboard IDs for Grafana.com import:
- Node Exporter Full: 1860
- CrowdSec Overview: 19608
- AdGuard Home: 13330 (or search for latest)
- Blackbox Exporter: 7587
- Loki logs explorer: built-in

---

## Phase 11: VPS CronJobs

### Task 11.1: nmap Perimeter Audit CronJob

**Files:**
- Create: `/home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring/templates/nmap-cronjob.yaml`

**Step 1: Create the CronJob**

```yaml
{{- if .Values.perimeterAudit.enabled }}
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nmap-perimeter-audit
  namespace: {{ .Release.Namespace }}
spec:
  schedule: "0 */6 * * *"  # Every 6 hours
  jobTemplate:
    spec:
      template:
        spec:
          nodeSelector:
            kubernetes.io/hostname: vmi2951245
          containers:
            - name: nmap
              image: instrumentisto/nmap:7.95
              command:
                - /bin/sh
                - -c
                - |
                  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
                  RESULT=$(nmap -Pn -sT --top-ports 1000 {{ .Values.perimeterAudit.ddnsHostname }} -oG -)
                  OPEN_PORTS=$(echo "$RESULT" | grep "Ports:" | grep -oP '\d+/open' || echo "none")
                  echo "{\"timestamp\":\"$TIMESTAMP\",\"target\":\"{{ .Values.perimeterAudit.ddnsHostname }}\",\"open_ports\":\"$OPEN_PORTS\",\"raw\":\"$(echo $RESULT | tr '\n' ' ')\"}"
              resources:
                requests:
                  cpu: 50m
                  memory: 64Mi
                limits:
                  memory: 128Mi
          restartPolicy: OnFailure
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 3
{{- end }}
```

Note: CronJob output goes to stdout, which Alloy's Kubernetes log collection picks up and ships to Loki. Filter by `{container="nmap"}` in Grafana.

**Step 2: Add values**

```yaml
perimeterAudit:
  enabled: true
  ddnsHostname: "YOUR_DDNS_HOSTNAME"
```

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/nmap-cronjob.yaml
git commit -m "feat: add nmap perimeter audit CronJob for home network port scanning"
```

---

### Task 11.2: Speedtest + Traceroute CronJob

**Files:**
- Create: `/home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring/templates/network-quality-cronjob.yaml`

**Step 1: Create the CronJob**

```yaml
{{- if .Values.networkQuality.enabled }}
apiVersion: batch/v1
kind: CronJob
metadata:
  name: network-quality-monitor
  namespace: {{ .Release.Namespace }}
spec:
  schedule: "*/30 * * * *"  # Every 30 minutes
  jobTemplate:
    spec:
      template:
        spec:
          nodeSelector:
            kubernetes.io/hostname: vmi2951245
          containers:
            - name: speedtest
              image: ghcr.io/librespeed/speedtest-cli:v1.0.10
              command:
                - /bin/sh
                - -c
                - |
                  echo "=== SPEEDTEST $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
                  /speedtest --json || echo '{"error":"speedtest failed"}'
                  echo "=== TRACEROUTE ==="
                  traceroute -m 20 {{ .Values.networkQuality.ddnsHostname }} 2>&1 || echo "traceroute failed"
              resources:
                requests:
                  cpu: 50m
                  memory: 64Mi
                limits:
                  memory: 128Mi
          restartPolicy: OnFailure
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 3
{{- end }}
```

**Step 2: Add values**

```yaml
networkQuality:
  enabled: true
  ddnsHostname: "YOUR_DDNS_HOSTNAME"
```

**Step 3: Commit**

```bash
git add helm-charts/monitoring/templates/network-quality-cronjob.yaml
git commit -m "feat: add speedtest and traceroute CronJob for ISP performance monitoring"
```

---

## Phase 12: Synology Setup

### Task 12.1: Deploy Alloy + cAdvisor on Synology

**Files:**
- Modify: `~/observability-stack/docker-compose.yml` (on Synology — already has Garage)

**Step 1: Create Alloy config for Synology**

Create `~/observability-stack/alloy/config.alloy`:

```hcl
// --- Synology System Logs ---
loki.source.file "synology_logs" {
  targets = [{
    __path__ = "/var/log/messages",
    job      = "synology-syslog",
    source   = "synology-ds423",
  }]
  forward_to = [loki.write.asustor.receiver]
}

// --- Host Metrics ---
prometheus.exporter.unix "host" {
  set_collectors = ["cpu", "diskstats", "filesystem", "loadavg", "meminfo", "netdev", "uname"]
}

prometheus.scrape "host_metrics" {
  targets    = prometheus.exporter.unix.host.targets
  forward_to = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "30s"
}

// --- cAdvisor ---
prometheus.scrape "cadvisor" {
  targets = [{
    __address__ = "localhost:8081",
  }]
  forward_to = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "30s"
  job_name = "cadvisor-synology"
}

// --- Garage Metrics ---
prometheus.scrape "garage" {
  targets = [{
    __address__ = "localhost:3903",
  }]
  forward_to = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "60s"
  job_name = "garage-synology"
  metrics_path = "/metrics"
}

// --- Write to Loki on ASUSTOR ---
loki.write "asustor" {
  endpoint {
    url = "http://ASUSTOR_LAN_IP:3100/loki/api/v1/push"
  }
}

// --- Write to Mimir (via VPS NodePort over WireGuard or via ASUSTOR LAN) ---
prometheus.remote_write "mimir" {
  endpoint {
    url = "http://10.0.0.1:30090/api/v1/push"
  }
}
```

Note: Synology is not on the WireGuard mesh. It can reach Loki via LAN (ASUSTOR LAN IP), but for Mimir it needs a route. Options:
1. Route Mimir writes through ASUSTOR (ASUSTOR proxies to WireGuard)
2. Add Synology to WireGuard mesh too
3. Synology sends metrics to Alloy on ASUSTOR, which forwards to Mimir

Option 3 is simplest — change Mimir URL to point to ASUSTOR's Alloy, which already remote-writes to Mimir. But Alloy doesn't natively proxy remote_write.

Simplest: Synology sends metrics to Mimir via ASUSTOR as a SOCKS proxy or NAT. Or just add a WireGuard peer for Synology too. Decide at implementation time based on preference.

Alternative: Synology remote_writes to Mimir through the ASUSTOR's WireGuard IP (if ASUSTOR has IP forwarding enabled for 10.0.0.0/24 traffic). This requires `sysctl net.ipv4.ip_forward=1` on ASUSTOR and appropriate iptables rules.

**Step 2: Add Alloy + cAdvisor to Synology docker-compose.yml**

```yaml
  alloy:
    image: grafana/alloy:v1.8.0
    container_name: alloy
    restart: unless-stopped
    volumes:
      - ./alloy/config.alloy:/etc/alloy/config.alloy:ro
      - /var/log:/var/log:ro
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
    command:
      - run
      - /etc/alloy/config.alloy
      - --storage.path=/var/lib/alloy/data

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.51.0
    container_name: cadvisor
    restart: unless-stopped
    ports:
      - "8081:8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    privileged: true
```

**Step 3: Start and verify**

```bash
docker compose up -d alloy cadvisor
docker logs alloy --tail=20
```

---

## Phase 13: Merlin Router Configuration

### Task 13.1: Configure Syslog Export

**Step 1: Enable remote syslog in Merlin**

In the ASUS router web UI:
- `Administration > System > Remote Log`
- Enable: Yes
- Server IP: ASUSTOR's LAN IP
- Port: 1514 (Alloy's syslog listener)

**Step 2: Enable SNMP in Merlin**

- `Administration > System > SNMP`
- Enable: Yes
- Community: `public` (or a custom string — match in Alloy SNMP config)
- Location/Contact: optional

**Step 3: Verify syslog is flowing**

```bash
# On ASUSTOR:
docker logs alloy --tail=20 | grep syslog
# Or query Loki:
curl -s "http://localhost:3100/loki/api/v1/query?query={job=\"syslog\"}" | python3 -m json.tool
```

**Step 4: Verify SNMP is being collected**

```bash
# On ASUSTOR:
curl -s http://localhost:12345/api/v0/targets | grep snmp
```

---

## Phase 14: End-to-End Testing

### Task 14.1: Security Pipeline Test

**Step 1: Verify CrowdSec detects threats**

Generate a simulated attack from a VPS:
```bash
# From vmi2951245 (or use a test IP):
# This generates Traefik access log entries that CrowdSec should flag
for i in $(seq 1 50); do
  curl -s -o /dev/null -w "%{http_code}" https://el-jefe.me/.env
done
```

**Step 2: Check alerts on LAPI**

```bash
# On ASUSTOR:
docker exec crowdsec cscli alerts list
docker exec crowdsec cscli decisions list
```

Expected: Alert for path traversal / sensitive file probing.

**Step 3: Verify bouncer blocks the banned IP**

```bash
# From the banned IP (or check Traefik logs for 403 responses):
curl -v https://el-jefe.me/
```

Expected: 403 Forbidden (if the source IP was banned).

**Step 4: Remove test decision**

```bash
docker exec crowdsec cscli decisions delete --all
```

---

### Task 14.2: Observability Pipeline Test

**Step 1: Verify logs in Loki**

In Grafana at `10.0.0.4:3000`, go to Explore > Loki:
- `{job="traefik-access-log"}` — Traefik logs from VPS
- `{job="syslog"}` — Router logs
- `{job="adguard"}` — AdGuard query logs
- `{job="systemd-journal"}` — systemd from K3s nodes

**Step 2: Verify metrics in Mimir**

In Grafana > Explore > Mimir:
- `up{job="cadvisor-asustor"}` — ASUSTOR containers
- `probe_success{job="blackbox"}` — Home network probes
- `ifHCInOctets` — Router SNMP bandwidth
- `node_cpu_seconds_total{instance=~".*asustor.*"}` — NAS CPU

**Step 3: Verify DNS blocking**

```bash
# From a LAN device:
nslookup malware-domain-from-blocklist ASUSTOR_LAN_IP
```

Expected: Blocked (0.0.0.0 or NXDOMAIN).

**Step 4: Verify Garage replication**

```bash
# On Synology:
docker exec garage /garage bucket info loki-chunks
```

Expected: Object count matches ASUSTOR's bucket.

---

## Final: Update Alloy Config in K3s Monitoring Chart

### Task 15.1: Consolidate and Deploy

After all components are verified individually:

**Step 1: Update monitoring chart values for all new features**

Add to `helm-charts/monitoring/values.yaml`:

```yaml
crowdsec:
  logProcessor:
    enabled: true

perimeterAudit:
  enabled: true
  ddnsHostname: "YOUR_DDNS_HOSTNAME"

networkQuality:
  enabled: true
  ddnsHostname: "YOUR_DDNS_HOSTNAME"
```

**Step 2: Deploy the full monitoring chart update**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/helm-charts/monitoring
helm dependency update
helm upgrade monitoring . -n monitoring --reuse-values
```

**Step 3: Verify all pods are running**

```bash
kubectl get pods -n monitoring -o wide
kubectl get ds -n monitoring
kubectl get cronjobs -n monitoring
```

**Step 4: Final commit**

```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add .
git commit -m "feat: complete home network security and observability platform

- CrowdSec log processors + Traefik bouncer plugin
- Alloy DaemonSet with blackbox probes, host metrics, journal
- nmap perimeter audit CronJob
- Speedtest/traceroute network quality CronJob
- Mimir NodePort for WireGuard access from NAS devices
- Loki write endpoint updated to ASUSTOR"
```

---

## ASUSTOR Final docker-compose.yml Reference

For reference, the complete ASUSTOR Docker Compose file after all phases:

```yaml
services:
  garage:
    image: dxflrs/garage:v1.1.0
    container_name: garage
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./garage/garage.toml:/etc/garage.toml:ro
      - ./garage/meta:/var/lib/garage/meta
      - ./garage/data:/var/lib/garage/data

  loki:
    image: grafana/loki:3.4.2
    container_name: loki
    restart: unless-stopped
    ports:
      - "3100:3100"
    volumes:
      - ./loki/loki-config.yaml:/etc/loki/config.yaml:ro
      - loki-data:/var/loki
    command: -config.file=/etc/loki/config.yaml
    depends_on:
      - garage

  crowdsec:
    image: crowdsecurity/crowdsec:v1.6.8
    container_name: crowdsec
    restart: unless-stopped
    ports:
      - "10.0.0.4:8080:8080"
      - "6060:6060"
    environment:
      COLLECTIONS: "crowdsecurity/traefik crowdsecurity/linux crowdsecurity/syslog"
      GID: "1000"
    volumes:
      - ./crowdsec/acquis.yaml:/etc/crowdsec/acquis.yaml:ro
      - crowdsec-config:/etc/crowdsec
      - crowdsec-data:/var/lib/crowdsec/data
      - /var/log/syslog-router:/var/log/syslog-router:ro
      - adguard-data:/var/log/adguardhome:ro

  adguardhome:
    image: adguard/adguardhome:v0.107.55
    container_name: adguardhome
    restart: unless-stopped
    ports:
      - "53:53/tcp"
      - "53:53/udp"
      - "3001:3000/tcp"
    volumes:
      - ./adguardhome/work:/opt/adguardhome/work
      - ./adguardhome/conf:/opt/adguardhome/conf
      - adguard-data:/var/log/adguardhome

  grafana:
    image: grafana/grafana:11.5.2
    container_name: grafana
    restart: unless-stopped
    ports:
      - "10.0.0.4:3000:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: "CHANGE_ME"
      GF_SERVER_ROOT_URL: "http://10.0.0.4:3000"
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro

  alloy:
    image: grafana/alloy:v1.8.0
    container_name: alloy
    restart: unless-stopped
    ports:
      - "1514:1514/udp"
      - "12345:12345"
    volumes:
      - ./alloy/config.alloy:/etc/alloy/config.alloy:ro
      - /var/log:/var/log:ro
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
    command:
      - run
      - /etc/alloy/config.alloy
      - --storage.path=/var/lib/alloy/data
    depends_on:
      - loki

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.51.0
    container_name: cadvisor
    restart: unless-stopped
    ports:
      - "8081:8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    privileged: true

volumes:
  loki-data:
  crowdsec-config:
  crowdsec-data:
  adguard-data:
  grafana-data:
```
