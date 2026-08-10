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
