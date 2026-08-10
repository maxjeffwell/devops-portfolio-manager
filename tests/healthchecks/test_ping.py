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
