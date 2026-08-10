# healthchecks.io Verifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy an hourly verifier that reports Kubernetes-API-queryable backup health to healthchecks.io by inspecting artifacts rather than runner exit codes, plus an independent cluster heartbeat.

**Architecture:** A Python CronJob in namespace `monitoring` reads Velero `Backup` CRs and `CronJob.status.lastSuccessfulTime` through the in-cluster Kubernetes REST API, evaluates each against a per-check error threshold and freshness window, then pings a healthchecks.io check URL on success or its `/fail` endpoint on failure. Evaluation logic is a pure function with no I/O so it is unit-testable without a cluster. A separate, trivial heartbeat CronJob pings directly and depends on nothing.

**Tech Stack:** Python 3.12 (standard library only — no pip installs), `python:3.12-alpine` image, Kustomize `configMapGenerator`, External Secrets Operator, ArgoCD, pytest (dev-only).

## Scope

This plan implements **9 of the spec's 18 checks**: the 7 answerable through the Kubernetes API (`velero-daily`, `velero-weekly`, `velero-nas-local`, `db-backups`, `dns-doppler-backups`, `restore-tests`, `garage-offsite-sync`), plus `k3s-cluster-heartbeat` and the `healthchecks-verifier` self-check.

**Deferred to a follow-on plan** — 6 checks forming a separate subsystem that needs restic/kopia binaries, repository credentials and garage admin API access, i.e. a different container image and credential set: `restic-asustor`, `restic-synology`, `restic-zenbook`, `kopia-repos`, `garage-cluster-health`, and the `home-site-heartbeat` host cron on debian-marmoset. The 3 Tier-3 inline curls also land there, as they require edits on routers and the VPS rather than in-cluster changes.

Budget: 9 + 6 + 3 = 18 of 20, leaving 2 spare.

This plan is independently useful — it delivers cluster-death detection and Velero verification, the two highest-value items.

**On task ordering:** the spec's rollout puts heartbeats first, but here the heartbeat lands in Task 5 because it consumes the Secret created in Task 4. Nothing is lost: Task 4 deploys the verifier in dry-run mode, which pings nothing and therefore carries no alerting risk.

## Global Constraints

- Target: **healthchecks.io SaaS free tier, 20 checks maximum.** This plan consumes 9; the follow-on consumes 9 (6 repo-query checks + 3 inline curls); 2 remain spare. Do not add checks beyond the registry without re-checking this arithmetic.
- **Warnings are ignored entirely.** Only `errors` is thresholded. Velero emits ~200 warnings per run routinely.
- **Default error threshold: 5. Velero checks: 10.** Thresholds are inclusive upper bounds — `errors > max_errors` fails.
- **A `PartiallyFailed` Velero backup with errors within threshold is a PASS.** Only phase `Failed`/`InProgress`/`FailedValidation`, a missing run, or errors above threshold fail.
- **Freshness windows: 26 h for daily checks, 8 d (192 h) for weekly checks.**
- Secrets come from Doppler via `ClusterSecretStore/doppler-secret-store`, API version `external-secrets.io/v1`, `creationPolicy: Owner`, `refreshInterval: 1h`. Never commit a check UUID to git.
- Verifier runs hourly; every check is configured in healthchecks.io with **period 1 h, grace 2 h**.
- Verifier must **exit non-zero and log loudly** if it cannot read its secret. It must never silently no-op.
- Python standard library only. No `pip install` in the image.
- Commit directly to `main` (repo convention). No AI attribution or `Co-Authored-By` trailers in commit messages.

---

### Task 1: Pure evaluation logic

The heart of the system: a function that decides healthy-or-not from plain data. No network, no Kubernetes, no clock — `now` is injected so tests are deterministic.

**Files:**
- Create: `scripts/healthchecks/__init__.py`
- Create: `scripts/healthchecks/evaluate.py`
- Create: `tests/healthchecks/__init__.py`
- Test: `tests/healthchecks/test_evaluate.py`
- Create: `pyproject.toml`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `Verdict` frozen dataclass with fields `ok: bool`, `reason: str`
  - `evaluate_backup(runs: list[dict], *, now: datetime, window_hours: int, max_errors: int) -> Verdict` — each run dict has keys `phase: str`, `errors: int | None`, `completion: datetime | None`
  - `evaluate_cronjob(last_successful: datetime | None, *, now: datetime, window_hours: int) -> Verdict`
  - `aggregate(verdicts: list[tuple[str, Verdict]]) -> Verdict`

- [ ] **Step 1: Create the pytest scaffolding**

`pyproject.toml`:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
```

Create empty `scripts/healthchecks/__init__.py` and `tests/healthchecks/__init__.py`.

- [ ] **Step 2: Write the failing tests**

`tests/healthchecks/test_evaluate.py`:

```python
from datetime import datetime, timedelta, timezone

from scripts.healthchecks.evaluate import (
    Verdict,
    aggregate,
    evaluate_backup,
    evaluate_cronjob,
)

NOW = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)


def run(phase, errors, hours_ago):
    return {
        "phase": phase,
        "errors": errors,
        "completion": NOW - timedelta(hours=hours_ago),
    }


def test_clean_recent_backup_passes():
    v = evaluate_backup([run("Completed", 0, 2)], now=NOW, window_hours=26, max_errors=10)
    assert v.ok is True


def test_partiallyfailed_within_threshold_passes():
    # "Allow some errors": 3 errors under a threshold of 10 is healthy.
    v = evaluate_backup([run("PartiallyFailed", 3, 2)], now=NOW, window_hours=26, max_errors=10)
    assert v.ok is True


def test_the_known_velero_bug_fails():
    # The chronic 76-error PartiallyFailed run must NOT pass.
    v = evaluate_backup([run("PartiallyFailed", 76, 2)], now=NOW, window_hours=26, max_errors=10)
    assert v.ok is False
    assert "76" in v.reason


def test_stale_backup_fails():
    v = evaluate_backup([run("Completed", 0, 30)], now=NOW, window_hours=26, max_errors=10)
    assert v.ok is False
    assert "26h" in v.reason


def test_no_runs_fails():
    v = evaluate_backup([], now=NOW, window_hours=26, max_errors=10)
    assert v.ok is False


def test_failed_phase_fails():
    v = evaluate_backup([run("Failed", 0, 1)], now=NOW, window_hours=26, max_errors=10)
    assert v.ok is False


def test_inprogress_is_not_success():
    v = evaluate_backup([run("InProgress", None, 1)], now=NOW, window_hours=26, max_errors=10)
    assert v.ok is False


def test_newest_run_wins():
    runs = [run("PartiallyFailed", 90, 20), run("Completed", 0, 1)]
    assert evaluate_backup(runs, now=NOW, window_hours=26, max_errors=10).ok is True


def test_null_errors_treated_as_zero():
    v = evaluate_backup([run("Completed", None, 1)], now=NOW, window_hours=26, max_errors=5)
    assert v.ok is True


def test_run_missing_completion_is_ignored():
    runs = [{"phase": "InProgress", "errors": None, "completion": None}]
    assert evaluate_backup(runs, now=NOW, window_hours=26, max_errors=5).ok is False


def test_cronjob_recent_success_passes():
    assert evaluate_cronjob(NOW - timedelta(hours=3), now=NOW, window_hours=26).ok is True


def test_cronjob_never_ran_fails():
    v = evaluate_cronjob(None, now=NOW, window_hours=26)
    assert v.ok is False
    assert "never" in v.reason


def test_cronjob_stale_fails():
    assert evaluate_cronjob(NOW - timedelta(hours=40), now=NOW, window_hours=26).ok is False


def test_aggregate_all_ok():
    assert aggregate([("a", Verdict(True, "fine")), ("b", Verdict(True, "fine"))]).ok is True


def test_aggregate_reports_every_failure():
    v = aggregate([
        ("a", Verdict(True, "fine")),
        ("b", Verdict(False, "boom")),
        ("c", Verdict(False, "bang")),
    ])
    assert v.ok is False
    assert "b: boom" in v.reason
    assert "c: bang" in v.reason


def test_aggregate_of_nothing_fails():
    # An empty group means we queried nothing — that is a bug, not health.
    assert aggregate([]).ok is False
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager && python -m pytest tests/healthchecks/test_evaluate.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'scripts.healthchecks.evaluate'`

- [ ] **Step 4: Write the implementation**

`scripts/healthchecks/evaluate.py`:

```python
"""Pure decision logic for healthchecks verification.

No I/O, no clock, no Kubernetes. Everything is injected so the rules can be
tested exhaustively without a cluster.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta

# Velero phases that represent a run that actually finished and produced data.
# PartiallyFailed is included deliberately: whether it is acceptable is decided
# by the error threshold, not by the phase.
TERMINAL_SUCCESS_PHASES = ("Completed", "PartiallyFailed")


@dataclass(frozen=True)
class Verdict:
    ok: bool
    reason: str


def evaluate_backup(runs, *, now: datetime, window_hours: int, max_errors: int) -> Verdict:
    """Judge the most recent backup run inside the freshness window."""
    cutoff = now - timedelta(hours=window_hours)
    recent = [r for r in runs if r["completion"] is not None and r["completion"] >= cutoff]
    if not recent:
        return Verdict(False, f"no run completed in last {window_hours}h")

    newest = max(recent, key=lambda r: r["completion"])
    phase = newest["phase"]
    if phase not in TERMINAL_SUCCESS_PHASES:
        return Verdict(False, f"phase={phase}")

    errors = newest["errors"] or 0
    if errors > max_errors:
        return Verdict(False, f"errors={errors} exceeds max {max_errors} (phase={phase})")

    return Verdict(True, f"phase={phase} errors={errors}")


def evaluate_cronjob(last_successful, *, now: datetime, window_hours: int) -> Verdict:
    """Judge a Kubernetes CronJob by its last successful completion time."""
    if last_successful is None:
        return Verdict(False, "never succeeded")
    if last_successful < now - timedelta(hours=window_hours):
        hours = int((now - last_successful).total_seconds() // 3600)
        return Verdict(False, f"last success {hours}h ago, exceeds {window_hours}h")
    return Verdict(True, f"last success {last_successful.isoformat()}")


def aggregate(verdicts) -> Verdict:
    """Combine several verdicts into one. Every member must pass."""
    if not verdicts:
        return Verdict(False, "no members evaluated")
    failed = [(name, v) for name, v in verdicts if not v.ok]
    if failed:
        return Verdict(False, "; ".join(f"{name}: {v.reason}" for name, v in failed))
    return Verdict(True, f"all {len(verdicts)} members ok")
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m pytest tests/healthchecks/test_evaluate.py -v`
Expected: PASS, 16 passed

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml scripts/healthchecks/ tests/healthchecks/
git commit -m "feat(healthchecks): pure evaluation logic for backup verification"
```

---

### Task 2: Kubernetes reader and healthchecks ping client

Two thin I/O modules. Both are injectable so Task 3 can be exercised without a cluster or network.

**Files:**
- Create: `scripts/healthchecks/k8s.py`
- Create: `scripts/healthchecks/ping.py`
- Test: `tests/healthchecks/test_k8s.py`
- Test: `tests/healthchecks/test_ping.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `parse_ts(value: str | None) -> datetime | None` — parses RFC3339 (`2026-08-09T17:23:48Z`) into an aware datetime
  - `K8sClient(base_url: str, token: str, ca_path: str | None, opener=None)` with methods
    `list_velero_backups(schedule_name: str) -> list[dict]` (returns run dicts shaped for `evaluate_backup`)
    and `cronjob_last_success(namespace: str, name: str) -> datetime | None`
  - `Pinger(base: str = "https://hc-ping.com", opener=None, dry_run: bool = False)` with
    `send(uuid: str, ok: bool, note: str) -> bool`

- [ ] **Step 1: Write the failing tests**

`tests/healthchecks/test_k8s.py`:

```python
import json
from datetime import datetime, timezone

from scripts.healthchecks.k8s import K8sClient, parse_ts


class FakeOpener:
    """Stands in for urllib's opener. Records URLs, returns canned JSON."""

    def __init__(self, payloads):
        self.payloads = payloads
        self.urls = []

    def open(self, request, timeout=None):
        self.urls.append(request.full_url)
        body = json.dumps(self.payloads.pop(0)).encode()

        class R:
            def read(self_inner):
                return body

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *a):
                return False

        return R()


def test_parse_ts_handles_rfc3339_z():
    assert parse_ts("2026-08-09T17:23:48Z") == datetime(
        2026, 8, 9, 17, 23, 48, tzinfo=timezone.utc
    )


def test_parse_ts_handles_none():
    assert parse_ts(None) is None


def test_list_velero_backups_shapes_runs():
    payload = {
        "items": [
            {
                "metadata": {"name": "daily-backup-20260809020038"},
                "status": {
                    "phase": "PartiallyFailed",
                    "errors": 76,
                    "completionTimestamp": "2026-08-09T06:10:43Z",
                },
            }
        ]
    }
    opener = FakeOpener([payload])
    client = K8sClient("https://k8s.local", "tok", None, opener=opener)
    runs = client.list_velero_backups("daily-backup")

    assert len(runs) == 1
    assert runs[0]["phase"] == "PartiallyFailed"
    assert runs[0]["errors"] == 76
    assert runs[0]["completion"] == datetime(2026, 8, 9, 6, 10, 43, tzinfo=timezone.utc)
    assert "labelSelector" in opener.urls[0]


def test_list_velero_backups_tolerates_missing_status():
    payload = {"items": [{"metadata": {"name": "x"}}]}
    client = K8sClient("https://k8s.local", "tok", None, opener=FakeOpener([payload]))
    runs = client.list_velero_backups("daily-backup")
    assert runs[0]["phase"] == "Unknown"
    assert runs[0]["completion"] is None


def test_cronjob_last_success():
    payload = {"status": {"lastSuccessfulTime": "2026-08-10T05:30:00Z"}}
    client = K8sClient("https://k8s.local", "tok", None, opener=FakeOpener([payload]))
    assert client.cronjob_last_success("default", "postgresql-backup") == datetime(
        2026, 8, 10, 5, 30, 0, tzinfo=timezone.utc
    )


def test_cronjob_never_succeeded_returns_none():
    client = K8sClient("https://k8s.local", "tok", None, opener=FakeOpener([{"status": {}}]))
    assert client.cronjob_last_success("default", "never-ran") is None
```

`tests/healthchecks/test_ping.py`:

```python
from scripts.healthchecks.ping import Pinger


class RecordingOpener:
    def __init__(self):
        self.urls = []
        self.bodies = []

    def open(self, request, timeout=None):
        self.urls.append(request.full_url)
        self.bodies.append(request.data)

        class R:
            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *a):
                return False

            def read(self_inner):
                return b"OK"

        return R()


def test_success_pings_bare_uuid():
    op = RecordingOpener()
    Pinger(opener=op).send("abc-123", ok=True, note="phase=Completed errors=0")
    assert op.urls == ["https://hc-ping.com/abc-123"]
    assert b"errors=0" in op.bodies[0]


def test_failure_pings_fail_endpoint():
    op = RecordingOpener()
    Pinger(opener=op).send("abc-123", ok=False, note="errors=76 exceeds max 10")
    assert op.urls == ["https://hc-ping.com/abc-123/fail"]


def test_dry_run_sends_nothing():
    op = RecordingOpener()
    sent = Pinger(opener=op, dry_run=True).send("abc-123", ok=False, note="boom")
    assert op.urls == []
    assert sent is False
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/healthchecks/test_k8s.py tests/healthchecks/test_ping.py -v`
Expected: FAIL — `ModuleNotFoundError` for `scripts.healthchecks.k8s`

- [ ] **Step 3: Write the Kubernetes reader**

`scripts/healthchecks/k8s.py`:

```python
"""Minimal read-only Kubernetes API client using only the standard library."""

import json
import ssl
import urllib.parse
import urllib.request
from datetime import datetime, timezone

TIMEOUT_SECONDS = 30


def parse_ts(value):
    """Parse an RFC3339 timestamp into an aware datetime, or None."""
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


class K8sClient:
    def __init__(self, base_url, token, ca_path, opener=None):
        self.base_url = base_url.rstrip("/")
        self.token = token
        if opener is not None:
            self.opener = opener
        else:
            context = ssl.create_default_context(cafile=ca_path) if ca_path else None
            self.opener = urllib.request.build_opener(
                urllib.request.HTTPSHandler(context=context)
            )

    def _get(self, path, params=None):
        url = f"{self.base_url}{path}"
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(url, method="GET")
        request.add_header("Authorization", f"Bearer {self.token}")
        request.add_header("Accept", "application/json")
        with self.opener.open(request, timeout=TIMEOUT_SECONDS) as response:
            return json.loads(response.read())

    def list_velero_backups(self, schedule_name):
        """Return run dicts for one Velero schedule, shaped for evaluate_backup."""
        data = self._get(
            "/apis/velero.io/v1/namespaces/velero/backups",
            {"labelSelector": f"velero.io/schedule-name={schedule_name}"},
        )
        runs = []
        for item in data.get("items", []):
            status = item.get("status", {})
            runs.append(
                {
                    "phase": status.get("phase", "Unknown"),
                    "errors": status.get("errors"),
                    "completion": parse_ts(status.get("completionTimestamp")),
                }
            )
        return runs

    def cronjob_last_success(self, namespace, name):
        data = self._get(f"/apis/batch/v1/namespaces/{namespace}/cronjobs/{name}")
        return parse_ts(data.get("status", {}).get("lastSuccessfulTime"))
```

- [ ] **Step 4: Write the ping client**

`scripts/healthchecks/ping.py`:

```python
"""healthchecks.io ping client. Success pings the UUID, failure pings /fail."""

import urllib.request

TIMEOUT_SECONDS = 15


class Pinger:
    def __init__(self, base="https://hc-ping.com", opener=None, dry_run=False):
        self.base = base.rstrip("/")
        self.dry_run = dry_run
        self.opener = opener or urllib.request.build_opener()

    def send(self, uuid, ok, note):
        """Ping a check. Returns True if a request was actually sent."""
        if self.dry_run:
            return False
        url = f"{self.base}/{uuid}" if ok else f"{self.base}/{uuid}/fail"
        request = urllib.request.Request(url, data=note.encode()[:10000], method="POST")
        with self.opener.open(request, timeout=TIMEOUT_SECONDS):
            return True
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m pytest tests/healthchecks/ -v`
Expected: PASS, 25 passed (16 from Task 1, 6 in test_k8s.py, 3 in test_ping.py)

- [ ] **Step 6: Commit**

```bash
git add scripts/healthchecks/k8s.py scripts/healthchecks/ping.py tests/healthchecks/test_k8s.py tests/healthchecks/test_ping.py
git commit -m "feat(healthchecks): stdlib kubernetes reader and ping client"
```

---

### Task 3: Verifier entrypoint and check registry

Wires the pieces together and defines exactly which checks exist.

**Files:**
- Create: `scripts/healthchecks/checks.py`
- Create: `scripts/healthchecks/verifier.py`
- Test: `tests/healthchecks/test_verifier.py`

**Interfaces:**
- Consumes: `evaluate_backup`, `evaluate_cronjob`, `aggregate`, `Verdict` from Task 1; `K8sClient`, `Pinger` from Task 2.
- Produces:
  - `CHECKS: list[Check]` where `Check` is a frozen dataclass with fields
    `slug: str`, `kind: str` (`"velero"` or `"cronjobs"`), `targets: tuple[str, ...]`, `window_hours: int`, `max_errors: int`
  - `run_all(client, pinger, uuids: dict[str, str], now: datetime) -> list[tuple[str, Verdict, bool]]`
    returning `(slug, verdict, was_sent)` per check
  - `main() -> int` — process exit code

- [ ] **Step 1: Write the failing test**

`tests/healthchecks/test_verifier.py`:

```python
from datetime import datetime, timedelta, timezone

from scripts.healthchecks.checks import CHECKS
from scripts.healthchecks.verifier import run_all

NOW = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)


class FakeClient:
    def __init__(self, backups=None, cronjobs=None):
        self.backups = backups or {}
        self.cronjobs = cronjobs or {}

    def list_velero_backups(self, schedule_name):
        return self.backups.get(schedule_name, [])

    def cronjob_last_success(self, namespace, name):
        return self.cronjobs.get(name)


class FakePinger:
    def __init__(self):
        self.sent = []

    def send(self, uuid, ok, note):
        self.sent.append((uuid, ok, note))
        return True


def test_check_slugs_are_unique():
    slugs = [c.slug for c in CHECKS]
    assert len(slugs) == len(set(slugs))


def test_plan_stays_within_free_tier():
    # Budget guard. 7 registry checks + cluster heartbeat + verifier self-check
    # = 9 here; 6 follow-on; 3 inline = 18 of 20. Raising this number without
    # raising the plan's budget is how a free-tier account silently overflows.
    assert len(CHECKS) == 7


def test_velero_daily_failure_pings_fail():
    client = FakeClient(
        backups={
            "daily-backup": [
                {"phase": "PartiallyFailed", "errors": 76, "completion": NOW - timedelta(hours=6)}
            ]
        }
    )
    pinger = FakePinger()
    results = run_all(client, pinger, {"velero-daily": "uuid-daily"}, NOW)

    daily = [r for r in results if r[0] == "velero-daily"][0]
    assert daily[1].ok is False
    assert ("uuid-daily", False, daily[1].reason) in pinger.sent


def test_clean_velero_daily_pings_success():
    client = FakeClient(
        backups={
            "daily-backup": [
                {"phase": "Completed", "errors": 0, "completion": NOW - timedelta(hours=6)}
            ]
        }
    )
    pinger = FakePinger()
    run_all(client, pinger, {"velero-daily": "uuid-daily"}, NOW)
    assert pinger.sent[0][1] is True


def test_check_without_uuid_is_skipped_not_crashed():
    client = FakeClient()
    pinger = FakePinger()
    results = run_all(client, pinger, {}, NOW)
    assert pinger.sent == []
    assert all(sent is False for _, _, sent in results)


def test_grouped_cronjob_check_fails_if_one_member_stale():
    client = FakeClient(
        cronjobs={
            "postgresql-backup": NOW - timedelta(hours=3),
            "mongodb-backup": NOW - timedelta(hours=99),
            "mongodb-backup-educationelly": NOW - timedelta(hours=3),
            "mongodb-backup-educationelly-graphql": NOW - timedelta(hours=3),
            "mongodb-backup-microservices": NOW - timedelta(hours=3),
            "mongodb-backup-vertex-platform": NOW - timedelta(hours=3),
            "influxdb-backup": NOW - timedelta(hours=3),
        }
    )
    pinger = FakePinger()
    results = run_all(client, pinger, {"db-backups": "uuid-db"}, NOW)
    db = [r for r in results if r[0] == "db-backups"][0]
    assert db[1].ok is False
    assert "mongodb-backup" in db[1].reason
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/healthchecks/test_verifier.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'scripts.healthchecks.checks'`

- [ ] **Step 3: Write the check registry**

`scripts/healthchecks/checks.py`:

```python
"""Registry of every check this verifier owns.

`slug` must exactly match the key used in the Doppler secret and the check
name in healthchecks.io.
"""

from dataclasses import dataclass

DAILY_WINDOW_HOURS = 26
WEEKLY_WINDOW_HOURS = 192  # 8 days
DEFAULT_MAX_ERRORS = 5
VELERO_MAX_ERRORS = 10


@dataclass(frozen=True)
class Check:
    slug: str
    kind: str  # "velero" | "cronjobs"
    targets: tuple
    window_hours: int
    max_errors: int


CHECKS = [
    Check("velero-daily", "velero", ("daily-backup",), DAILY_WINDOW_HOURS, VELERO_MAX_ERRORS),
    Check(
        "velero-weekly",
        "velero",
        ("weekly-backup", "weekly-backup-local", "weekly-offsite"),
        WEEKLY_WINDOW_HOURS,
        VELERO_MAX_ERRORS,
    ),
    Check(
        "velero-nas-local",
        "velero",
        ("daily-backup-nas-local",),
        DAILY_WINDOW_HOURS,
        VELERO_MAX_ERRORS,
    ),
    Check(
        "db-backups",
        "cronjobs",
        (
            "default/postgresql-backup",
            "default/mongodb-backup",
            "default/mongodb-backup-educationelly",
            "default/mongodb-backup-educationelly-graphql",
            "default/mongodb-backup-microservices",
            "default/mongodb-backup-vertex-platform",
            "monitoring/influxdb-backup",
        ),
        DAILY_WINDOW_HOURS,
        DEFAULT_MAX_ERRORS,
    ),
    Check(
        "dns-doppler-backups",
        "cronjobs",
        ("default/dns-zone-backup", "default/doppler-secrets-backup"),
        DAILY_WINDOW_HOURS,
        DEFAULT_MAX_ERRORS,
    ),
    Check(
        "restore-tests",
        "cronjobs",
        (
            "default/mongodb-restore-test",
            "default/postgresql-restore-test",
            "default/dns-zone-restore-test",
            "default/doppler-secrets-restore-test",
        ),
        DAILY_WINDOW_HOURS,
        DEFAULT_MAX_ERRORS,
    ),
    Check(
        "garage-offsite-sync",
        "cronjobs",
        ("default/garage-offsite-sync",),
        WEEKLY_WINDOW_HOURS,
        DEFAULT_MAX_ERRORS,
    ),
]

# Not a member of CHECKS: the verifier's own liveness check, pinged by main()
# after a completed pass. Kept separate so a bug in the registry loop cannot
# make the verifier report itself healthy.
SELF_CHECK_SLUG = "healthchecks-verifier"
```

**Deliberately excluded.** `asustor-zfs-snapshot`, `cnpg-snapshot-pruner` and `channels-dvr-db-sync` are all queryable and tempting to add, but the spec's budget is fully allocated: 9 here + 6 follow-on + 3 inline = 18, leaving 2 spare of 20. Adding these would reach 21 and exceed the free tier. Spend the 2 spare slots deliberately, after seeing which checks prove noisy.

- [ ] **Step 4: Write the verifier**

`scripts/healthchecks/verifier.py`:

```python
"""Hourly verifier: read state, judge it, report to healthchecks.io."""

import json
import os
import sys
from datetime import datetime, timezone

from scripts.healthchecks.checks import CHECKS, SELF_CHECK_SLUG
from scripts.healthchecks.evaluate import aggregate, evaluate_backup, evaluate_cronjob
from scripts.healthchecks.k8s import K8sClient
from scripts.healthchecks.ping import Pinger

SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
UUID_FILE = "/etc/healthchecks/uuids.json"


def _judge(check, client, now):
    if check.kind == "velero":
        members = [
            (
                schedule,
                evaluate_backup(
                    client.list_velero_backups(schedule),
                    now=now,
                    window_hours=check.window_hours,
                    max_errors=check.max_errors,
                ),
            )
            for schedule in check.targets
        ]
    else:
        members = []
        for target in check.targets:
            namespace, name = target.split("/", 1)
            members.append(
                (
                    name,
                    evaluate_cronjob(
                        client.cronjob_last_success(namespace, name),
                        now=now,
                        window_hours=check.window_hours,
                    ),
                )
            )
    return aggregate(members)


def run_all(client, pinger, uuids, now):
    """Evaluate every check. Returns (slug, verdict, was_sent) per check."""
    results = []
    for check in CHECKS:
        try:
            verdict = _judge(check, client, now)
        except Exception as exc:  # a read failure is a failed check, not a crash
            from scripts.healthchecks.evaluate import Verdict

            verdict = Verdict(False, f"evaluation error: {exc}")

        uuid = uuids.get(check.slug)
        sent = False
        if uuid:
            try:
                sent = pinger.send(uuid, verdict.ok, verdict.reason)
            except Exception as exc:
                print(f"WARN {check.slug}: ping failed: {exc}", file=sys.stderr)
        else:
            print(f"WARN {check.slug}: no UUID configured, skipping ping", file=sys.stderr)

        status = "OK  " if verdict.ok else "FAIL"
        print(f"{status} {check.slug}: {verdict.reason} (pinged={sent})")
        results.append((check.slug, verdict, sent))
    return results


def main():
    dry_run = os.environ.get("HC_DRY_RUN", "false").lower() == "true"

    try:
        with open(UUID_FILE) as handle:
            uuids = json.load(handle)
    except (OSError, ValueError) as exc:
        print(f"FATAL: cannot read {UUID_FILE}: {exc}", file=sys.stderr)
        return 1
    if not uuids:
        print(f"FATAL: {UUID_FILE} contained no check UUIDs", file=sys.stderr)
        return 1

    with open(f"{SA_DIR}/token") as handle:
        token = handle.read().strip()

    host = os.environ["KUBERNETES_SERVICE_HOST"]
    port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
    client = K8sClient(f"https://{host}:{port}", token, f"{SA_DIR}/ca.crt")
    pinger = Pinger(dry_run=dry_run)

    if dry_run:
        print("DRY RUN: evaluating only, no pings will be sent")

    results = run_all(client, pinger, uuids, datetime.now(timezone.utc))
    failed = [slug for slug, verdict, _ in results if not verdict.ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks healthy")

    # Self-liveness: a completed pass pings the verifier's own check. If the
    # verifier dies or crashes before here, this check goes quiet and its
    # 2h grace period fires -- which is what tells you the other checks'
    # silence means "not evaluated" rather than "healthy".
    self_uuid = uuids.get(SELF_CHECK_SLUG)
    if self_uuid:
        try:
            pinger.send(self_uuid, True, f"{len(results) - len(failed)}/{len(results)} healthy")
        except Exception as exc:
            print(f"WARN self-check ping failed: {exc}", file=sys.stderr)
    else:
        print(f"WARN no UUID for {SELF_CHECK_SLUG}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Run all tests to verify they pass**

Run: `python -m pytest tests/healthchecks/ -v`
Expected: PASS, 31 passed (25 from Tasks 1-2, 6 in test_verifier.py)

- [ ] **Step 6: Commit**

```bash
git add scripts/healthchecks/checks.py scripts/healthchecks/verifier.py tests/healthchecks/test_verifier.py
git commit -m "feat(healthchecks): verifier entrypoint and check registry"
```

---

### Task 4: Kubernetes manifests, deployed in dry-run mode

Deploys the verifier with `HC_DRY_RUN=true` so it evaluates and logs without pinging. This is rollout phase 2 from the spec.

**Files:**
- Create: `k8s/healthchecks/kustomization.yaml`
- Create: `k8s/healthchecks/rbac.yaml`
- Create: `k8s/healthchecks/external-secret.yaml`
- Create: `k8s/healthchecks/verifier-cronjob.yaml`

**Interfaces:**
- Consumes: the Python package from Tasks 1–3, mounted at `/app/scripts/healthchecks` via `configMapGenerator`.
- Produces: ServiceAccount `healthchecks-verifier` in `monitoring`; Secret `healthchecks-uuids` with key `uuids.json`; CronJob `healthchecks-verifier`.

- [ ] **Step 1: Create the Doppler secret**

In Doppler, add key `HEALTHCHECKS_UUIDS_JSON` whose value is a JSON object mapping slug to UUID. Start with only the checks you have created in healthchecks.io — unmapped slugs are skipped with a warning rather than failing:

```json
{"velero-daily":"REPLACE-WITH-UUID","velero-weekly":"REPLACE-WITH-UUID"}
```

- [ ] **Step 2: Write the RBAC manifest**

`k8s/healthchecks/rbac.yaml`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: healthchecks-verifier
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: healthchecks-verifier
rules:
- apiGroups: ["velero.io"]
  resources: ["backups"]
  verbs: ["get", "list"]
- apiGroups: ["batch"]
  resources: ["cronjobs"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: healthchecks-verifier
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: healthchecks-verifier
subjects:
- kind: ServiceAccount
  name: healthchecks-verifier
  namespace: monitoring
```

- [ ] **Step 3: Write the ExternalSecret**

`k8s/healthchecks/external-secret.yaml`:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: healthchecks-uuids-eso
  namespace: monitoring
  labels:
    app: healthchecks-verifier
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: doppler-secret-store
  target:
    name: healthchecks-uuids
    creationPolicy: Owner
  data:
  # Full map for the verifier, which needs every slug.
  - secretKey: uuids.json
    remoteRef:
      key: HEALTHCHECKS_UUIDS_JSON
  # Single UUID extracted for the heartbeat, so a shell script never has to
  # parse JSON. `property` selects one field out of the JSON secret value.
  - secretKey: k3s-cluster-heartbeat
    remoteRef:
      key: HEALTHCHECKS_UUIDS_JSON
      property: k3s-cluster-heartbeat
```

- [ ] **Step 4: Write the CronJob**

`k8s/healthchecks/verifier-cronjob.yaml`:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: healthchecks-verifier
  namespace: monitoring
spec:
  schedule: "7 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 1
      template:
        spec:
          restartPolicy: OnFailure
          serviceAccountName: healthchecks-verifier
          securityContext:
            runAsNonRoot: true
            runAsUser: 65534
          containers:
          - name: verifier
            image: python:3.12-alpine
            command: ["python", "-m", "scripts.healthchecks.verifier"]
            workingDir: /app
            env:
            - name: HC_DRY_RUN
              value: "true"
            - name: PYTHONPATH
              value: /app
            resources:
              requests:
                cpu: 25m
                memory: 64Mi
              limits:
                memory: 128Mi
            volumeMounts:
            - name: code
              mountPath: /app/scripts/healthchecks
              readOnly: true
            - name: uuids
              mountPath: /etc/healthchecks
              readOnly: true
          volumes:
          - name: code
            configMap:
              name: healthchecks-code
          - name: uuids
            secret:
              secretName: healthchecks-uuids
```

- [ ] **Step 5: Write the kustomization**

`k8s/healthchecks/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: monitoring
resources:
- rbac.yaml
- external-secret.yaml
- verifier-cronjob.yaml
configMapGenerator:
- name: healthchecks-code
  files:
  - __init__.py=../../scripts/healthchecks/__init__.py
  - evaluate.py=../../scripts/healthchecks/evaluate.py
  - k8s.py=../../scripts/healthchecks/k8s.py
  - ping.py=../../scripts/healthchecks/ping.py
  - checks.py=../../scripts/healthchecks/checks.py
  - verifier.py=../../scripts/healthchecks/verifier.py
generatorOptions:
  disableNameSuffixHash: true
```

- [ ] **Step 6: Verify the manifests render**

Run: `kubectl kustomize k8s/healthchecks | head -40`
Expected: valid YAML including a `ConfigMap` named `healthchecks-code` containing the Python source.

- [ ] **Step 7: Commit**

```bash
git add k8s/healthchecks/
git commit -m "feat(healthchecks): verifier manifests in dry-run mode"
```

- [ ] **Step 8: Apply and confirm dry-run output**

```bash
kubectl apply -k k8s/healthchecks
kubectl create job -n monitoring hc-manual-1 --from=cronjob/healthchecks-verifier
kubectl wait --for=condition=complete -n monitoring job/hc-manual-1 --timeout=180s
kubectl logs -n monitoring job/hc-manual-1
```

Expected: a line per check reading `OK`/`FAIL` with a reason, `DRY RUN` at the top, and `pinged=False` throughout. Record which checks report FAIL — those are the thresholds to revisit before arming.

---

### Task 5: Cluster heartbeat and arming the verifier

Adds the independent heartbeat and switches the verifier out of dry-run.

**Files:**
- Create: `k8s/healthchecks/heartbeat-cronjob.yaml`
- Modify: `k8s/healthchecks/kustomization.yaml`
- Modify: `k8s/healthchecks/verifier-cronjob.yaml` (`HC_DRY_RUN` → `"false"`)
- Create: `gitops/applications/healthchecks.yaml`

**Interfaces:**
- Consumes: Secret `healthchecks-uuids` from Task 4.
- Produces: CronJob `healthchecks-heartbeat`; ArgoCD Application `healthchecks`.

- [ ] **Step 1: Write the heartbeat CronJob**

`k8s/healthchecks/heartbeat-cronjob.yaml`. It deliberately shares nothing with the verifier — a plain curl, so verifier bugs cannot suppress it:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: healthchecks-heartbeat
  namespace: monitoring
spec:
  schedule: "*/5 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 0
      template:
        spec:
          restartPolicy: Never
          securityContext:
            runAsNonRoot: true
            runAsUser: 65534
          containers:
          - name: heartbeat
            image: curlimages/curl:8.11.1
            command:
            - sh
            - -c
            - |
              # ESO extracts this single UUID into its own key, so there is no
              # JSON to parse here. A missing file must fail loudly, not ping.
              UUID=$(cat /etc/healthchecks/k3s-cluster-heartbeat)
              if [ -z "$UUID" ]; then echo "FATAL: no k3s-cluster-heartbeat UUID"; exit 1; fi
              exec curl -fsS -m 20 --retry 3 "https://hc-ping.com/$UUID"
            resources:
              requests:
                cpu: 10m
                memory: 16Mi
              limits:
                memory: 32Mi
            volumeMounts:
            - name: uuids
              mountPath: /etc/healthchecks
              readOnly: true
          volumes:
          - name: uuids
            secret:
              secretName: healthchecks-uuids
```

- [ ] **Step 2: Add the heartbeat to the kustomization**

In `k8s/healthchecks/kustomization.yaml`, add `- heartbeat-cronjob.yaml` to the `resources` list, after `verifier-cronjob.yaml`.

- [ ] **Step 3: Add the heartbeat UUID to Doppler and verify it pings**

Create the `k3s-cluster-heartbeat` check in healthchecks.io with **period 5 min, grace 15 min**, alerting by email/push and **not** via the Gotify webhook. Add its UUID to `HEALTHCHECKS_UUIDS_JSON`, then:

```bash
kubectl annotate externalsecret -n monitoring healthchecks-uuids-eso force-sync=$(date +%s) --overwrite
kubectl apply -k k8s/healthchecks
kubectl create job -n monitoring hb-manual-1 --from=cronjob/healthchecks-heartbeat
kubectl wait --for=condition=complete -n monitoring job/hb-manual-1 --timeout=60s
```

Expected: job completes, and the check shows "up" in the healthchecks.io UI.

- [ ] **Step 4: Verify the dead-man's-switch property**

```bash
kubectl patch cronjob -n monitoring healthchecks-heartbeat -p '{"spec":{"suspend":true}}'
```

Wait 20 minutes. Expected: healthchecks.io alerts by email/push that `k3s-cluster-heartbeat` is down. Then re-enable:

```bash
kubectl patch cronjob -n monitoring healthchecks-heartbeat -p '{"spec":{"suspend":false}}'
```

This is the single most important test in the plan — it proves the alert path works when the cluster cannot help.

- [ ] **Step 5: Arm the verifier**

Only after reviewing 48 h of dry-run logs from Task 4 and adjusting any wrong thresholds in `checks.py`. In `verifier-cronjob.yaml` change:

```yaml
            - name: HC_DRY_RUN
              value: "false"
```

Create the remaining checks in healthchecks.io (period 1 h, grace 2 h, Gotify webhook) and add their UUIDs to Doppler.

- [ ] **Step 6: Write the ArgoCD Application**

`gitops/applications/healthchecks.yaml`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: healthchecks
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/maxjeffwell/devops-portfolio-manager.git
    targetRevision: main
    path: k8s/healthchecks
  destination:
    server: https://kubernetes.default.svc
    namespace: monitoring
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - CreateNamespace=false
```

- [ ] **Step 7: Commit and confirm ArgoCD syncs**

```bash
git add k8s/healthchecks/ gitops/applications/healthchecks.yaml
git commit -m "feat(healthchecks): cluster heartbeat, argocd application, arm verifier"
git push origin main
kubectl apply -f gitops/applications/healthchecks.yaml
kubectl get application -n argocd healthchecks -o jsonpath='{.status.sync.status} {.status.health.status}{"\n"}'
```

Expected: `Synced Healthy`

---

## Follow-on work (separate plan)

`restic-asustor`, `restic-synology`, `restic-zenbook`, `kopia-repos`, `garage-cluster-health`, the three Tier-3 inline curls, and the `home-site-heartbeat` host cron on debian-marmoset. These need restic/kopia binaries, repository credentials, and garage admin API access — a different image and a different credential set, which is why they are not in this plan.

`restic-zenbook` is the highest-value item remaining and should lead that plan.
