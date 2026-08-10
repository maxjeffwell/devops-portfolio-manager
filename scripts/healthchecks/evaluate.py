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
