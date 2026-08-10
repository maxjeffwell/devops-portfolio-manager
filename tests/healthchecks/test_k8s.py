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
