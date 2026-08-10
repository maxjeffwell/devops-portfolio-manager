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
        return self.cronjobs.get((namespace, name))


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
            ("default", "postgresql-backup"): NOW - timedelta(hours=3),
            ("default", "mongodb-backup"): NOW - timedelta(hours=99),
            ("default", "mongodb-backup-educationelly"): NOW - timedelta(hours=3),
            ("default", "mongodb-backup-educationelly-graphql"): NOW - timedelta(hours=3),
            ("default", "mongodb-backup-microservices"): NOW - timedelta(hours=3),
            ("default", "mongodb-backup-vertex-platform"): NOW - timedelta(hours=3),
            ("monitoring", "influxdb-backup"): NOW - timedelta(hours=3),
            ("vertex-platform", "influxdb-backup"): NOW - timedelta(hours=3),
        }
    )
    pinger = FakePinger()
    results = run_all(client, pinger, {"db-backups": "uuid-db"}, NOW)
    db = [r for r in results if r[0] == "db-backups"][0]
    assert db[1].ok is False
    assert "mongodb-backup" in db[1].reason
