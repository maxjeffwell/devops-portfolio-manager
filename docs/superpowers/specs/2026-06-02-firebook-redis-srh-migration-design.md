# Firebook Redis Migration: Upstash Cloud → In-Cluster Redis via SRH — Design Spec

**Date:** 2026-06-02
**Status:** Approved (design)
**Components:** new `k8s/firebook-redis-srh` (devops-portfolio-manager), `bookmarks-capstone-api` (Firebase Functions secrets)

## 1. Summary

Firebook's backend (Firebase Cloud Functions, `bookmarks-capstone-api/functions`) currently uses **Upstash cloud Redis** as a cache (URL-metadata caching via `lib/cache`, the `@upstash/redis` REST client). This migrates it to the **existing in-cluster Redis** (`redis.default.svc.cluster.local:6379`) **without changing firebook's code**, by deploying **`serverless-redis-http` (SRH)** — an Upstash-REST-API-compatible proxy — in front of the in-cluster Redis and repointing firebook's Firebase secrets at it.

Firebook stays on Firebase Functions (external/Google Cloud); only its Redis target changes.

## 2. Goals / Non-Goals

### Goals
- Firebook caches against in-cluster `redis.default` instead of Upstash cloud.
- **No firebook code changes** — keep the `@upstash/redis` REST client; SRH speaks the same API.
- Isolate firebook to its own Redis logical DB (index `1`), separate from code-talk's DB `0` on the shared instance.
- Reversible cutover (it's a cache; flip two Firebase secrets to roll back).

### Non-Goals
- Moving firebook's backend off Firebase Functions (stays external).
- Rewriting firebook's cache layer to a native Redis client (`ioredis`).
- Migrating/seeding existing Upstash cache data (a cache repopulates; cold start is acceptable).
- Touching code-talk or other consumers of `redis.default`.

## 3. Constraints & Context

- **Consumer is external:** Firebase Functions run on Google Cloud, so the adapter must be reachable over the **public internet** (no private path). Firebase egress IPs are not static → no IP allowlist; security rests on a strong bearer token + HTTPS.
- **Shared Redis:** `redis.default` (StatefulSet, password-protected via `REDIS_PASSWORD`) is shared with code-talk. Firebook is confined to **DB index 1** via the SRH connection string.
- **Cache only:** firebook uses Redis for URL-metadata caching with TTL; cache miss → refetch. Low migration risk, graceful degradation.
- **Routing pattern:** `*-k8s.el-jefe.me` Traefik ingresses (cert-manager TLS) behind a Cloudflare Tunnel (`cloudflared-ai-gateway` in `default`). New hostnames follow this pattern.
- **GitOps:** ArgoCD; infra under `k8s/<app>` as directory apps (e.g. `k8s/ovms`), secrets via External Secrets Operator (ESO) + Doppler.

## 4. Architecture

```
Firebase Functions (firebook, external)
  │  @upstash/redis REST client
  │  UPSTASH_REDIS_REST_URL = https://firebook-redis.el-jefe.me
  │  UPSTASH_REDIS_REST_TOKEN = <SRH_TOKEN>
  ▼  HTTPS
Cloudflare Tunnel ──▶ Traefik ingress (firebook-redis.el-jefe.me, TLS)
  ▼
Service firebook-redis-srh:80
  ▼
SRH pod (hiett/serverless-redis-http)  — stateless
  │  SRH_CONNECTION_STRING = redis://:<REDIS_PASSWORD>@redis:6379/1
  ▼
redis.default:6379  (DB index 1)
```

All durable state stays in `redis.default`; SRH is stateless and disposable.

### New units (`k8s/firebook-redis-srh/`)
Deployed in the **`default` namespace** (so `redis:6379` resolves directly and the
existing default-ns netpols apply — see §6/§9). No new namespace.

| File | Responsibility |
|---|---|
| `deployment.yaml` | SRH pod: `SRH_MODE=env`, `SRH_TOKEN` + `SRH_CONNECTION_STRING` from secret |
| `service.yaml` | `firebook-redis-srh` ClusterIP :80 → SRH :80 |
| `ingress.yaml` | Traefik ingress `firebook-redis.el-jefe.me` → service, cert-manager TLS |
| `external-secret.yaml` | ESO `ExternalSecret` → K8s secret with `SRH_TOKEN`, `REDIS_PASSWORD` (from Doppler) |
| `kustomization.yaml` | bundles the above |
| `gitops/applications/firebook-redis-srh.yaml` | ArgoCD Application (path `k8s/firebook-redis-srh`, branch `main`) |

## 5. Data Flow

- **Cache read/write:** firebook calls `https://firebook-redis.el-jefe.me` with the Upstash REST verbs + bearer token → SRH translates to Redis commands against DB 1 → returns Upstash-shaped JSON. Identical contract to Upstash cloud, so `@upstash/redis` works unmodified.
- **No migration of existing data:** DB 1 starts empty; firebook repopulates on cache misses.

## 6. Security

- **Bearer token:** strong random `SRH_TOKEN` (≥32 bytes). Firebook sends it as `UPSTASH_REDIS_REST_TOKEN`; SRH rejects requests without it.
- **HTTPS only** via Traefik/cert-manager + Cloudflare.
- **DB-index isolation:** the `/1` in the connection string confines all firebook traffic to DB 1 — a leaked token cannot reach code-talk's DB 0.
- **Blast radius:** non-sensitive URL-metadata cache; worst case on token leak is read/write of firebook's own cache keys.
- Optional hardening (not in scope): Cloudflare Access service-token in front — deferred because the `@upstash/redis` client only sends a bearer token and would need custom headers.

## 7. Configuration / Secrets

| Key | Source | Use |
|---|---|---|
| `SRH_TOKEN` | new, generated; stored in Doppler → ESO | SRH bearer auth + firebook's `UPSTASH_REDIS_REST_TOKEN` |
| `REDIS_PASSWORD` | existing in-cluster redis secret → Doppler/ESO | SRH connection string auth |
| `SRH_CONNECTION_STRING` | composed in the deployment from `REDIS_PASSWORD` | `redis://:<pw>@redis:6379/1` |

Firebase side (`bookmarks-capstone-api`): `UPSTASH_REDIS_REST_URL` → `https://firebook-redis.el-jefe.me`, `UPSTASH_REDIS_REST_TOKEN` → `SRH_TOKEN`, set via `firebase functions:secrets:set` then functions redeploy.

## 8. Cutover & Rollback

1. Deploy SRH + service + ingress; confirm the Cloudflare Tunnel routes `firebook-redis.el-jefe.me` (wildcard vs explicit — verify `cloudflared-ai-gateway` config; add route/DNS if needed).
2. Verify externally: `curl -H "Authorization: Bearer <SRH_TOKEN>" https://firebook-redis.el-jefe.me/get/<k>` returns Upstash-shaped JSON; SRH `/health` (or a SET/GET round-trip) green.
3. Update the two Firebase secrets + redeploy functions (`bookmarks-capstone-api`).
4. Verify: firebook traffic populates `redis.default` DB 1 (`redis-cli -n 1 --scan` shows firebook keys); no errors in function logs; Upstash cloud dashboard shows traffic stop.
5. **Rollback:** revert the two Firebase secrets to the Upstash values + redeploy. Instant; no data to unwind (cache).

## 9. Open Implementation Questions (resolve during plan execution)
- **NetworkPolicy (default ns has `default-deny-all`):** verify SRH→Redis egress is covered by the existing `allow-redis-external` (egress :6379 to 0.0.0.0/0) + `allow-dns`, and Traefik→SRH ingress by `allow-traefik-ingress`. Add a targeted netpol only if those don't select the SRH pod.
- **Cloudflare Tunnel routing:** confirm whether `*.el-jefe.me` is wildcarded to Traefik or needs an explicit ingress rule in the `cloudflared-ai-gateway` config + a Cloudflare DNS record for `firebook-redis.el-jefe.me`.
- **firebase CLI auth:** confirm `firebase` is authenticated on marmoset for `bookmarks-capstone-api`; else run the secret-set/deploy via `! firebase …`.
- **REDIS_PASSWORD retrieval:** source the existing in-cluster redis password (from its K8s secret) into Doppler so ESO can inject it into the SRH connection string.

## 10. Testing / Verification
- SRH SET/GET round-trip via the public HTTPS endpoint with the bearer token.
- Confirm keys land in DB 1 only (not DB 0).
- Firebook function logs show cache hits/sets succeeding post-cutover; Upstash cloud traffic ceases.
- Rollback rehearsal: confirm reverting the two secrets restores Upstash behavior.
