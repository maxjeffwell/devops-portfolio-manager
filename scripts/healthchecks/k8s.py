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
