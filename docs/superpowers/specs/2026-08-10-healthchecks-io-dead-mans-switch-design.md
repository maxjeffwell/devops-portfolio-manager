# healthchecks.io Dead-Man's-Switch Monitoring — Design

**Date:** 2026-08-10
**Status:** Approved, not yet implemented

## Problem

The existing Prometheus/Alertmanager/Gotify stack reports on things that *run and emit metrics*. It is structurally blind to three failure classes:

1. **Jobs that silently lie about success.** The Zenbook restic task exits 0 while never producing a snapshot; it went undetected for weeks. Every exit-code-based monitor would have reported it green.
2. **Jobs that stop firing entirely.** A cron that is never scheduled emits no metric, so there is nothing for an alert rule to fire on.
3. **Death of the monitoring stack itself.** In-cluster monitoring cannot report that the cluster is down. This is not hypothetical — a headscale-in-k3s circular dependency produced an 11-day outage.

Off-cluster scheduled work (router crons, NAS restic/kopia, the kine WAL checkpoint on vmi2951245) is entirely outside Prometheus' view.

## Goals

- Detect whole-cluster and site-level death from outside the failure domain.
- Verify backups by inspecting **artifacts**, not runner exit codes.
- Catch silent failures of off-cluster scheduled jobs.

**Non-goal:** blanket coverage of all 23 k8s CronJobs. Scope is deliberately capped to stay within the free tier.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Hosting | **SaaS healthchecks.io, free tier (20 checks)** | Third-party independence is the entire point of infra-death detection. Self-hosting in k3s recreates the headscale circular dependency; self-hosting on debian-marmoset survives cluster death but not host/site death. |
| Instrumentation | **Hybrid (verifier + inline curl)** | Inline-only would have reported the Zenbook failure green, because a lying runner lies to healthchecks too. |
| Success rule | **Per-check absolute error threshold; default 5, velero 10. Warnings ignored.** | Must retain margin against the known 76–85-error velero bug. Velero emits ~200 warnings per run routinely, so warnings carry no signal. |
| Secrets | **Doppler via External Secrets Operator** | Matches the existing `ClusterSecretStore/doppler-secret-store` pattern (Valid, 206d) already used by ~20 `ExternalSecret` resources. |
| Alerting | **Split by severity** | Gotify runs in the `monitoring` namespace; routing infra-death alerts through it would recreate the circular dependency on the notification path. |

## Architecture

Three components:

### 1. Verifier CronJob (`healthchecks-verifier`, namespace `monitoring`)

Runs **hourly**. For each Tier-2 item it evaluates authoritative state, then pings either the check URL (success) or its `/fail` endpoint.

Evaluation rule, uniform across backups:

> A run completed within its expected window (26 h for dailies, 8 d for weeklies) **and** reported errors ≤ the check's threshold.

A clean daily therefore holds the check green all day and flips it red 26 h after the last good run.

**Explicit `/fail` is what makes this responsive** — bad state alerts on the next hourly pass rather than waiting out a grace period. The 1 h period / 2 h grace then serves a second purpose: detecting the death of the verifier itself.

State sources: Velero `Backup` CRs (`.status.phase`, `.status.errors`, `.status.completionTimestamp`); restic/kopia repository snapshot timestamps queried directly against the repo; garage admin API; k8s `CronJob.status.lastSuccessfulTime`.

### 2. Inline `curl`

For jobs with no inspectable artifact, where "it ran" *is* the signal:

```sh
cmd && curl -fsS "$HC_URL" || curl -fsS "$HC_URL/fail"
```

### 3. Heartbeats

Two independent pings that bypass the verifier, alerting externally by email/push and never through Gotify.

## Check budget — 18 of 20 (2 spare)

### Tier 1 — Heartbeats (external alerting)

| Check | Source | Period / Grace |
|---|---|---|
| `k3s-cluster-heartbeat` | in-cluster CronJob | 5 min / 15 min |
| `home-site-heartbeat` | debian-marmoset host cron | 5 min / 15 min |
| `healthchecks-verifier` | verifier liveness | 1 h / 2 h |

The first two are diagnostic in combination: both silent ⇒ power or ISP; cluster-only silent ⇒ k3s.

### Tier 2 — Verifier-evaluated (Gotify alerting)

`velero-daily` (≤10 errors, 26 h) · `velero-weekly` (all three weekly schedules clean, 8 d) · `velero-nas-local` · `restic-asustor` · `restic-synology` · `restic-zenbook` · `kopia-repos` · `garage-offsite-sync` · `garage-cluster-health` (6 nodes up, 0 block errors) · `db-backups` (5 × mongodb + postgresql + influxdb) · `dns-doppler-backups` · `restore-tests` (all 4 restore-test CronJobs)

**`restic-zenbook` is the motivating case.** The verifier queries the restic *repository* for a recent snapshot from that host and never inspects the Windows task's exit code, which is the component that has been lying.

### Tier 3 — Inline curl (Gotify alerting)

`router-backupmon` · `router-config-backup` · `kine-wal-checkpoint`

## Secrets

One `ExternalSecret` → `ClusterSecretStore/doppler-secret-store` → Secret `healthchecks-uuids`, mounted into the verifier. Check UUIDs are stored in Doppler.

The three Tier-3 hosts (two routers, vmi2951245) have no ESO, so their ping URL is written into the host script directly. These URLs are capability tokens: possession permits pinging a check and nothing else — no read access, no account access.

## Failure modes

| Failure | Behavior | Mitigation |
|---|---|---|
| Internet/ISP down | healthchecks.io sees no pings; alerts server-side to email/push, reaching you over cellular | Tiered grace: only the two 15-min heartbeats trip on a short blip; everything else has ≥2 h, so no 18-alert storm |
| Verifier crashes | Backup checks go quiet rather than green | `healthchecks-verifier` check trips within 2 h |
| ESO/Doppler sync fails | Verifier has no UUIDs, cannot ping | ESO caches last good Secret, so this bites only on fresh deploy; verifier must exit non-zero and log loudly, never silently no-op |
| healthchecks.io itself down | Pings fail; no false "all clear" | Accepted risk of SaaS. Verifier logs ping failures; absence of alerts is not treated as health |
| Threshold set wrong | False alerts, or masked failures | Phase 2 log-only mode surfaces this before alerts are armed |

## Rollout

Phased, to avoid a day-one alert flood:

1. **Heartbeats only** (3 checks). Immediate value, zero risk, proves the alerting split works.
2. **Verifier in log-only mode**, ~48 h. Evaluates everything, logs verdicts, pings nothing. This is where wrong thresholds are found *before* they wake anyone.
3. **Enable pinging** for checks clean in step 2. Hold back noisy ones until the underlying issue is fixed or the threshold adjusted.
4. **Inline curls last** — the only part requiring edits on routers and the VPS.

Step 2 matters concretely: velero is currently PartiallyFailed on every run, and a fix (kine VACUUM + repo-maintenance reduction, 2026-08-09) is still being verified against the 02:00Z daily. Log-only mode allows observing real values for two days before committing to a threshold.

## Testing

- **Verifier logic:** unit-test the evaluation rule against recorded fixtures — a clean Velero backup, a PartiallyFailed one with 76 errors, one outside the 26 h window, and a missing backup. Each must produce the expected verdict.
- **Ping path:** point the verifier at a scratch check and confirm both success and `/fail` transitions register.
- **Alert split:** deliberately trip one Tier-1 and one Tier-2 check; confirm Tier-1 arrives by email/push and Tier-2 in Gotify.
- **Dead-man's property:** scale the verifier to zero and confirm `healthchecks-verifier` trips within its grace window.
- **The Zenbook case:** confirm `restic-zenbook` reports failure while the Windows task is still exiting 0. This is the regression test for the bug that motivated the project.

## Deferred to implementation

- Exact Doppler key names for the 18 check UUIDs.

`garage-cluster-health` is Tier 2 with Gotify alerting. It reads as infrastructure rather than backup, but garage degradation is not an outage you need woken for — it self-heals on quorum recovery — so it belongs with the routine-failure traffic, not the external-page traffic.
