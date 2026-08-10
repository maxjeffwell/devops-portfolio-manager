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
