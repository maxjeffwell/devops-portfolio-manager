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


def test_errors_exactly_at_threshold_passes():
    # Inclusive upper bound: equal to the threshold is acceptable.
    v = evaluate_backup([run("Completed", 10, 1)], now=NOW, window_hours=26, max_errors=10)
    assert v.ok is True


def test_errors_one_over_threshold_fails():
    v = evaluate_backup([run("Completed", 11, 1)], now=NOW, window_hours=26, max_errors=10)
    assert v.ok is False


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
