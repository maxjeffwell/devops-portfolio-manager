# CrowdSec LAPI In-Cluster Migration — Design

**Date:** 2026-06-03
**Status:** Approved (design)
**Repos touched:** `devops-portfolio-manager` (primary), `asustor-observability-stack` (decommission)

## Problem

The Traefik CrowdSec **bouncer** and the in-cluster **agents** (`crowdsec-log-processor`
DaemonSet) both talk to a CrowdSec **LAPI** that runs as a Docker container on the
ASUSTOR NAS at `10.0.0.4:8080`, reached over **WireGuard**. That hop is the only
CrowdSec link that traverses WG-to-NAS, and it is fragile:

- On 2026-06-03 the LAPI hung (TCP accept, no HTTP reply) during an ASUSTOR network
  flap → the bouncer (then `live` mode) failed closed → **HTTP 403 on every protected
  route**, breaking Vaultwarden/Bitwarden sign-in. (Mitigated by PR #15: bouncer →
  `stream` mode + `updateMaxFailure: -1` fail-open.)
- Even after the LAPI container was restarted, the **cloud nodes** (where Traefik/the
  bouncer run: `vmi2951245`, `vmi3115606`) **still cannot reach `10.0.0.4:8080`** over
  WG, while the on-prem node `marmoset` can — a per-node WG asymmetry. So enforcement
  is currently silently off (fail-open allowing all traffic).

The root cause is **architectural**: a cluster security control depends on a NAS
reachable only over a flaky WireGuard path.

## Goals

1. Move the CrowdSec **LAPI** into the k3s cluster so every node reaches it over
   ordinary pod networking (the same path Traefik already uses to serve the
   `vaultwarden` pod on `debian-marmoset`). **No WireGuard on the bouncer→LAPI hop.**
2. Repoint the agents and the bouncer to the in-cluster LAPI.
3. Add lightweight alerting so a future LAPI/enforcement outage is **not silent**.
4. Decommission the ASUSTOR LAPI.

## Non-goals

- True multi-replica LAPI HA (Postgres-backed). Out of scope — single in-cluster
  replica + fail-open + reconstructible DB already removes the failure mode that bit us.
- Changing what the agents parse (still Traefik access logs).
- Migrating existing decisions/bans (decision: **start fresh**; community blocklist
  re-syncs, agents re-register).

## Current architecture

```
Traefik bouncer (kube-system, cloud nodes) ─┐
                                            ├─ WG ─→ ASUSTOR Docker LAPI 10.0.0.4:8080 (SQLite)
crowdsec-log-processor agents (DaemonSet) ──┘
```

- LAPI: `crowdsecurity/crowdsec:v1.7.6`, volumes `crowdsec-config:/etc/crowdsec`,
  `crowdsec-data:/var/lib/crowdsec/data`; online/CAPI enabled (community blocklist).
  Defined in `asustor-observability-stack/docker-compose.yml`.
- Agents: `helm-charts/monitoring` chart, `DISABLE_LOCAL_API=true`,
  `LOCAL_API_URL=http://10.0.0.4:8080`, creds from `crowdsec-log-processor-credentials`,
  `DISABLE_ONLINE_API=true`, parse `/var/log/traefik/access.log`.
- Bouncer: Traefik plugin `crowdsec-bouncer` Middleware (two copies:
  `k8s/traefik/crowdsec-bouncer-middleware.yaml` in `kube-system`, and
  `k8s/jellyfin/crowdsec-bouncer-middleware.yaml` in `jellyfin`), `crowdsecLapiHost:
  10.0.0.4:8080`, key from Doppler ExternalSecret `crowdsec-bouncer-lapi-key`.

## Target architecture

```
Traefik bouncer (kube-system) ─┐
                               ├─ pod network ─→ Service crowdsec-lapi.monitoring:8080 ─→ LAPI pod (SQLite on mayastor PVC)
agents (DaemonSet) ────────────┘                                                              │
                                                                                   CAPI (community blocklist, egress to api.crowdsec.net)
```

## Component design (new, in `helm-charts/monitoring`)

All resources gated behind a new `crowdsec.lapi.enabled` value.

### 1. `crowdsec-lapi` Deployment (1 replica)
- Image `crowdsecurity/crowdsec:v1.7.6` (match agents + ASUSTOR).
- **LAPI-only:** `DISABLE_AGENT=true` (no local log parsing; the DaemonSet agents do that).
- **Online/CAPI enabled** (do NOT set `DISABLE_ONLINE_API`) so the community blocklist
  re-syncs on the fresh DB. Requires egress to `api.crowdsec.net` (host aliases as in the
  ASUSTOR compose, if DNS to those hosts is unreliable). *Verify at implementation.*
- Env bootstrap:
  - `BOUNCER_KEY_traefik` = value of the Doppler bouncer key (pre-registers the `traefik`
    bouncer with the key the Traefik plugin already uses). *The crowdsec image supports
    `BOUNCER_KEY_<name>`; verify.*
  - Agent machine registration: the agents run with `DISABLE_LOCAL_API=true` and expect
    to **log in** to a pre-existing machine. Add an **idempotent bootstrap** (postStart
    lifecycle hook or initContainer) that runs
    `cscli machines add "$AGENT_USERNAME" --password "$AGENT_PASSWORD" --force` against the
    local LAPI, reading creds from the mounted `crowdsec-log-processor-credentials` secret.
- Volume mounts: PVC at `/var/lib/crowdsec/data`; `/etc/crowdsec` from image defaults
  (emptyDir or chart-managed config). *Confirm the image initializes `/etc/crowdsec` when
  only the data dir is persisted.*
- Probes: readiness/liveness on `GET /health` (8080).
- Resources: requests ~`50m`/`128Mi`, limit `256Mi` (mirror agents).
- Scheduling: no hard node pin required (ClusterIP is node-agnostic); mayastor
  single-replica volume will bind on a mayastor pool node (`debian-marmoset` or
  `marmoset`) and the pod schedules where the replica is attachable.

### 2. `crowdsec-lapi` Service
- `ClusterIP`, port `8080` → `8080`. DNS `crowdsec-lapi.monitoring.svc.cluster.local`.

### 3. PVC `crowdsec-lapi-data`
- `storageClassName: mayastor-single-replica`, `1Gi`, `ReadWriteOnce`.

### 4. Secrets
- Add an ExternalSecret (Doppler) for the bouncer key **into `monitoring`** (or mount the
  existing one) so the LAPI's `BOUNCER_KEY_traefik` matches what Traefik uses. The key
  must be identical on both sides.
- Reuse existing `crowdsec-log-processor-credentials` (username/password) for the agent
  machine bootstrap.

### 5. NetworkPolicy
- If `monitoring` is default-deny, add a NetworkPolicy allowing ingress to `crowdsec-lapi`
  on 8080 from (a) `kube-system` (Traefik bouncer) and (b) the `monitoring` namespace
  (agents), plus egress for CAPI. *Verify the ns policy posture at implementation.*

## Cutover (repoint)

1. Deploy the LAPI (above) with `crowdsec.lapi.enabled=true`; verify it is healthy and
   has the bouncer + agent machine registered and a non-zero blocklist.
2. Agents: change `LOCAL_API_URL` → `http://crowdsec-lapi.monitoring.svc.cluster.local:8080`
   (chart value; rolls the DaemonSet).
3. Bouncer: change `crowdsecLapiHost` → `crowdsec-lapi.monitoring.svc.cluster.local:8080`
   in **both** Middlewares (`k8s/traefik/` and `k8s/jellyfin/`). These are applied via the
   same path as PR #15 (the kube-system Middleware is `kubectl apply`-managed; the jellyfin
   one is ArgoCD-managed → via git/PR to `main`).

## Resilience

A LAPI pod restart → k8s reschedules; PVC persists. During the blip the bouncer is
already `stream` + `updateMaxFailure: -1` (fail-open), so **no request is blocked**.
In-cluster move removes the WG SPOF; fail-open covers transient restarts. Defense in depth.

## Lighter alerting

One `PrometheusRule` (in `helm-charts/monitoring`) → existing Alertmanager →
`alertmanager-gotify-bridge` → gotify:
- **`CrowdsecLapiDown`**: `kube_deployment_status_replicas_available{deployment="crowdsec-lapi"} == 0`
  for > 5m (warning/critical).
- Optional: a blackbox HTTP probe (`blackbox-exporter` already deployed) of
  `crowdsec-lapi.monitoring.svc:8080/health`; alert on probe failure. Use an **HTTP**
  probe (not tcp_connect) so the "accepts TCP but won't answer HTTP" hang is detected.

## Decommission ASUSTOR LAPI

After verification: stop/remove the `crowdsec` service in
`asustor-observability-stack/docker-compose.yml`; remove `10.0.0.4` references. Keep the
container dormant briefly as rollback, then delete.

## Verification

- LAPI pod `Ready`; `cscli bouncers list` shows `traefik`, `cscli machines list` shows the
  agents, blocklist decisions count > 0.
- Agents' logs: connected to the new LAPI, no auth errors.
- From a Traefik pod: `wget http://crowdsec-lapi.monitoring.svc.cluster.local:8080/health`
  returns promptly (no timeout); a test scenario produces a ban that the bouncer enforces.
- Vaultwarden stays `200`; jellyfin login + podrick `/devops-api` still protected.
- Nothing references `10.0.0.4` (grep repos + live manifests).
- Alert fires when the LAPI Deployment is scaled to 0 (test), clears when restored.

## Risks & rollback

- **Bootstrap mechanism uncertainty** (agent machine / bouncer key env): if the declarative
  env/postStart approach doesn't register cleanly, fall back to a one-shot `cscli` Job.
- **CAPI enrollment** may need outbound DNS/host-aliases; if the community blocklist won't
  sync, the LAPI still serves locally-detected decisions (acceptable).
- **Rollback:** revert agents' `LOCAL_API_URL` and the bouncer `crowdsecLapiHost` to
  `10.0.0.4:8080` and restart the ASUSTOR container. Fail-open means traffic is unaffected
  during any cutover hiccup.

## Files

**New (`helm-charts/monitoring/templates/`):** `crowdsec-lapi-deployment.yaml`,
`crowdsec-lapi-service.yaml`, `crowdsec-lapi-pvc.yaml`, bootstrap (configmap/script or
lifecycle hook), `crowdsec-lapi-externalsecret.yaml` (bouncer key in monitoring),
`crowdsec-lapi-networkpolicy.yaml` (if needed), `crowdsec-lapi-alerts.yaml` (PrometheusRule).
**Modified:** `helm-charts/monitoring/values.yaml` (`crowdsec.lapi.*`,
`crowdsec.logProcessor.localApiUrl`), `crowdsec-log-processor-daemonset.yaml`
(`LOCAL_API_URL` → templated), `k8s/traefik/crowdsec-bouncer-middleware.yaml`,
`k8s/jellyfin/crowdsec-bouncer-middleware.yaml` (`crowdsecLapiHost`).
**Decommission:** `asustor-observability-stack/docker-compose.yml`.
