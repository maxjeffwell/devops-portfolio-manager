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
            "vertex-platform/influxdb-backup",
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
