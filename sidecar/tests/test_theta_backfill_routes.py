"""Tests for the /admin/theta-backfill routes wired into HealthHandler.

Drives HealthHandler directly through a fake request socket (the same
pattern as test_theta_index_routes.py and test_health.py's POST drivers),
so no HTTP server, no Theta Terminal and no Postgres are involved.
`theta_fetcher` is stubbed for the route-contract tests; one end-to-end
test lets the real single-flight machinery run with `_fetch_root_range`
replaced, which is the only place a worker thread is spawned.

The auth matrix is the point of the first section: EVERY rejection path
(Theta reporters not wired, ARCHIVE_SEED_TOKEN unset, wrong token,
missing header) must produce a byte-identical 401, or the admin surface
becomes an enumeration oracle — see `_handle_seed_archive`, which this
mirrors.
"""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import time
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

# Required env vars for config.py's pydantic-settings validation (imported
# transitively by theta_fetcher). Throwaway values — psycopg2 is mocked in
# conftest.py so no connection is ever attempted.
os.environ.setdefault("DATABENTO_API_KEY", "test-key")
os.environ.setdefault("DATABASE_URL", "postgresql://test:" + "fakefixture" + "@localhost/test")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest

from health import HealthHandler

_TOKEN = "test-admin-token"
_AUTH = {"X-Admin-Token": _TOKEN}
_PATH = "/admin/theta-backfill"
_UNAUTHORIZED = {"error": "unauthorized"}


# ---------------------------------------------------------------------------
# Request drivers
# ---------------------------------------------------------------------------


def _drive(raw_request: bytes, body: bytes = b"") -> tuple[int, dict]:
    """Run one request through HealthHandler; return (status, body_obj)."""
    output = io.BytesIO()
    body_stream = io.BytesIO(body)

    class _H(HealthHandler):
        def setup(self_inner) -> None:  # noqa: N805
            self_inner.rfile = io.BytesIO(raw_request)
            self_inner.wfile = output

        def parse_request(self_inner) -> bool:  # noqa: N805
            ok = super().parse_request()
            # Swap in the body stream only after the request line +
            # headers have been consumed from the head-only stream.
            self_inner.rfile = body_stream
            return ok

        def finish(self_inner) -> None:  # noqa: N805
            pass

        def log_message(self_inner, *_a: object, **_kw: object) -> None:  # noqa: N805
            pass

    _H(object(), ("127.0.0.1", 0), None)  # type: ignore[arg-type]
    raw = output.getvalue().decode()
    status_line, *_ = raw.split("\r\n", 1)
    status = int(status_line.split()[1])
    _, _, body_text = raw.partition("\r\n\r\n")
    if not body_text:
        return status, {}
    try:
        return status, json.loads(body_text)
    except json.JSONDecodeError:
        return status, {"_raw": body_text}


def _post(
    payload: object = None,
    headers: dict[str, str] | None = None,
    *,
    path: str = _PATH,
    raw_body: bytes | None = None,
    declared_length: int | None = None,
) -> tuple[int, dict]:
    """POST `payload` as JSON (or `raw_body` verbatim) to `path`."""
    if raw_body is None:
        raw_body = b"" if payload is None else json.dumps(payload).encode()
    length = declared_length if declared_length is not None else len(raw_body)
    header_lines = "Host: localhost\r\n"
    for key, value in (headers or {}).items():
        header_lines += f"{key}: {value}\r\n"
    head = f"POST {path} HTTP/1.1\r\n{header_lines}Content-Length: {length}\r\n\r\n".encode()
    return _drive(head, raw_body)


def _get(headers: dict[str, str] | None = None, *, path: str = _PATH) -> tuple[int, dict]:
    """GET `path` with optional request headers."""
    header_lines = "Host: localhost\r\n"
    for key, value in (headers or {}).items():
        header_lines += f"{key}: {value}\r\n"
    head = f"GET {path} HTTP/1.1\r\n{header_lines}\r\n".encode()
    return _drive(head)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def admin_env():
    """Theta configured on this sidecar + the admin token set.

    Individual tests unset either half to exercise a rejection path.
    """
    HealthHandler.theta_is_running = staticmethod(lambda: True)
    os.environ["ARCHIVE_SEED_TOKEN"] = _TOKEN
    yield
    HealthHandler.theta_is_running = None
    HealthHandler.theta_last_ready_at = None
    HealthHandler.theta_last_error = None
    os.environ.pop("ARCHIVE_SEED_TOKEN", None)


@pytest.fixture
def stub_fetcher():
    """Patch both theta_fetcher entry points; yield the (start, status) mocks."""
    plan = {"roots": ["VIX"], "start": "2026-08-18", "end": "2026-08-19", "days": 2}
    status = {"state": "idle", "roots": [], "results": []}
    with (
        patch("theta_fetcher.start_targeted_backfill", return_value=plan) as start,
        patch("theta_fetcher.targeted_backfill_status", return_value=status) as status_fn,
    ):
        yield MagicMock(start=start, status=status_fn, plan=plan, status_body=status)


def _past(days_ago: int) -> str:
    """Return an ISO date `days_ago` before today (requests end before today)."""
    return (date.today() - timedelta(days=days_ago)).isoformat()  # noqa: DTZ011


def _valid_body() -> dict:
    return {"roots": ["VIX"], "start": _past(3), "end": _past(2)}


# ---------------------------------------------------------------------------
# Auth matrix — every rejection is the same flat 401
# ---------------------------------------------------------------------------


class TestAdminAuth:
    def _rejection_cases(self, call) -> list[tuple[int, dict]]:
        """Drive `call` once per rejection reason; return the responses."""
        results = []
        # 1. No X-Admin-Token header at all.
        results.append(call(None))
        # 2. Wrong token.
        results.append(call({"X-Admin-Token": "wrong"}))
        # 3. Correct-looking token but ARCHIVE_SEED_TOKEN unset (endpoint
        #    effectively disabled — absent token means "off", like the seeder).
        os.environ.pop("ARCHIVE_SEED_TOKEN", None)
        results.append(call(_AUTH))
        os.environ["ARCHIVE_SEED_TOKEN"] = _TOKEN
        # 4. Health server started without the Theta reporters at all.
        HealthHandler.theta_is_running = None
        results.append(call(_AUTH))
        HealthHandler.theta_is_running = staticmethod(lambda: True)
        return results

    def test_post_rejections_are_identical_401s(self, stub_fetcher) -> None:
        responses = self._rejection_cases(lambda h: _post(_valid_body(), h))

        assert all(status == 401 for status, _ in responses)
        assert all(body == _UNAUTHORIZED for _, body in responses)
        stub_fetcher.start.assert_not_called()

    def test_get_rejections_are_identical_401s(self, stub_fetcher) -> None:
        responses = self._rejection_cases(_get)

        assert all(status == 401 for status, _ in responses)
        assert all(body == _UNAUTHORIZED for _, body in responses)
        stub_fetcher.status.assert_not_called()

    def test_auth_runs_before_the_body_is_parsed(self, stub_fetcher) -> None:
        """A malformed body from an unauthenticated caller is still a 401 —
        the handler must not leak parse detail to an unauthorized probe."""
        status, body = _post(raw_body=b"{not json", headers={"X-Admin-Token": "wrong"})

        assert status == 401
        assert body == _UNAUTHORIZED
        stub_fetcher.start.assert_not_called()

    def test_correct_token_is_accepted(self, stub_fetcher) -> None:
        status, _body = _post(_valid_body(), _AUTH)

        assert status == 202
        stub_fetcher.start.assert_called_once()


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


class TestRouting:
    def test_post_to_a_prefix_lookalike_is_404(self, stub_fetcher) -> None:
        """Admin routes are matched EXACTLY — a prefix match would route
        /admin/theta-backfill-typo into the admin handler."""
        status, _body = _post(_valid_body(), _AUTH, path="/admin/theta-backfill-typo")

        assert status == 404
        stub_fetcher.start.assert_not_called()

    def test_get_to_a_prefix_lookalike_is_404(self, stub_fetcher) -> None:
        status, _body = _get(_AUTH, path="/admin/theta-backfill-typo")

        assert status == 404
        stub_fetcher.status.assert_not_called()

    def test_seed_archive_post_still_routes(self) -> None:
        """The POST dispatch refactor must not drop the existing route."""
        HealthHandler.seed_archive = staticmethod(lambda: {"failed": 0, "downloaded": 2})
        HealthHandler.seed_is_busy = staticmethod(lambda: False)
        try:
            status, body = _post(path="/admin/seed-archive", headers=_AUTH, raw_body=b"")
        finally:
            HealthHandler.seed_archive = None
            HealthHandler.seed_is_busy = None

        assert status == 200
        assert body == {"failed": 0, "downloaded": 2}


# ---------------------------------------------------------------------------
# Request validation — 400 before any work, fetcher never invoked
# ---------------------------------------------------------------------------


class TestValidation:
    @pytest.mark.parametrize(
        ("raw_body", "needle"),
        [
            (b"", "empty body"),
            (b"{not json", "invalid JSON"),
            (b"[1, 2]", "JSON object"),
            (b'"a string"', "JSON object"),
        ],
        ids=["absent", "malformed", "array", "scalar"],
    )
    def test_bad_body_is_400_not_500(self, stub_fetcher, raw_body, needle) -> None:
        status, body = _post(raw_body=raw_body, headers=_AUTH)

        assert status == 400
        assert needle in body["error"]
        stub_fetcher.start.assert_not_called()

    def test_non_numeric_content_length_is_400(self, stub_fetcher) -> None:
        head = (
            f"POST {_PATH} HTTP/1.1\r\nHost: localhost\r\n"
            f"X-Admin-Token: {_TOKEN}\r\nContent-Length: banana\r\n\r\n"
        ).encode()
        status, body = _drive(head, b"{}")

        assert status == 400
        assert "Content-Length" in body["error"]
        stub_fetcher.start.assert_not_called()

    def test_oversized_body_is_413_and_never_read(self, stub_fetcher) -> None:
        """Rejected by DECLARED length — the server binds 0.0.0.0, so an
        unbounded read is a remote-OOM vector (same rule as /takeit)."""
        import health

        status, body = _post(
            raw_body=b"{}",
            headers=_AUTH,
            declared_length=health.MAX_BODY_BYTES + 1,
        )

        assert status == 413
        assert "too large" in body["error"]
        stub_fetcher.start.assert_not_called()

    @pytest.mark.parametrize(
        ("payload", "needle"),
        [
            ({"start": _past(3), "end": _past(2)}, "roots"),
            ({"roots": "VIX", "start": _past(3), "end": _past(2)}, "roots"),
            ({"roots": [1, 2], "start": _past(3), "end": _past(2)}, "roots"),
            ({"roots": ["VIX"], "end": _past(2)}, "start"),
            ({"roots": ["VIX"], "start": _past(3)}, "end"),
            ({"roots": ["VIX"], "start": 20260818, "end": _past(2)}, "start"),
            ({"roots": ["VIX"], "start": "08/18/2026", "end": _past(2)}, "YYYY-MM-DD"),
            ({"roots": ["VIX"], "start": _past(3), "end": "not-a-date"}, "YYYY-MM-DD"),
            ({"roots": ["VIX"], "start": "2026-13-01", "end": _past(2)}, "YYYY-MM-DD"),
        ],
        ids=[
            "roots-missing",
            "roots-not-a-list",
            "roots-not-strings",
            "start-missing",
            "end-missing",
            "start-not-a-string",
            "start-wrong-format",
            "end-unparseable",
            "start-impossible-month",
        ],
    )
    def test_field_validation_is_400(self, stub_fetcher, payload, needle) -> None:
        status, body = _post(payload, _AUTH)

        assert status == 400
        assert needle in body["error"]
        stub_fetcher.start.assert_not_called()

    def test_domain_rejection_is_surfaced_verbatim_as_400(self, stub_fetcher) -> None:
        """theta_fetcher owns the root allowlist / span / not-today rules;
        the route returns its message so curl output is actionable."""
        import theta_fetcher

        stub_fetcher.start.side_effect = theta_fetcher.ThetaBackfillRequestError(
            "unknown root 'SPY'; allowed roots are SPXW, VIX, VIXW, NDXP"
        )
        status, body = _post({"roots": ["SPY"], "start": _past(3), "end": _past(2)}, _AUTH)

        assert status == 400
        assert body["error"] == "unknown root 'SPY'; allowed roots are SPXW, VIX, VIXW, NDXP"

    def test_busy_is_423(self, stub_fetcher) -> None:
        import theta_fetcher

        stub_fetcher.start.side_effect = theta_fetcher.ThetaBackfillBusyError("running")
        status, body = _post(_valid_body(), _AUTH)

        assert status == 423
        assert "in progress" in body["error"]

    def test_unexpected_failure_is_500(self, stub_fetcher) -> None:
        stub_fetcher.start.side_effect = RuntimeError("thread pool exhausted")
        status, body = _post(_valid_body(), _AUTH)

        assert status == 500
        assert "thread pool exhausted" in body["error"]


# ---------------------------------------------------------------------------
# Accepted plan + status
# ---------------------------------------------------------------------------


class TestAcceptedPlanAndStatus:
    def test_post_returns_202_with_the_accepted_plan(self, stub_fetcher) -> None:
        payload = {"roots": ["VIX", "VIXW"], "start": _past(3), "end": _past(2)}
        status, body = _post(payload, _AUTH)

        assert status == 202
        assert body == {"accepted": True, **stub_fetcher.plan}

        # Parsed dates are handed to the fetcher as `date` objects.
        args = stub_fetcher.start.call_args.args
        assert args[0] == ["VIX", "VIXW"]
        assert args[1] == date.fromisoformat(payload["start"])
        assert args[2] == date.fromisoformat(payload["end"])

    def test_get_returns_the_status_snapshot(self, stub_fetcher) -> None:
        stub_fetcher.status.return_value = {
            "state": "running",
            "roots": ["VIX"],
            "results": [{"root": "VIX", "rows": 12, "status": "ok", "error": None}],
        }
        status, body = _get(_AUTH)

        assert status == 200
        assert body == stub_fetcher.status.return_value

    def test_status_failure_is_500_not_a_dropped_connection(self, stub_fetcher) -> None:
        stub_fetcher.status.side_effect = RuntimeError("status exploded")
        status, body = _get(_AUTH)

        assert status == 500
        assert "status exploded" in body["error"]

    @pytest.mark.parametrize("verb", ["post", "get"])
    def test_unimportable_fetcher_is_500_not_a_dropped_connection(self, verb) -> None:
        """A broken deploy must still answer. Raising out of the handler
        would close the socket with no response at all."""
        # `None` in sys.modules makes `import theta_fetcher` raise ImportError.
        with patch.dict(sys.modules, {"theta_fetcher": None}):
            status, body = _post(_valid_body(), _AUTH) if verb == "post" else _get(_AUTH)

        assert status == 500
        assert "theta_fetcher unavailable" in body["error"]


# ---------------------------------------------------------------------------
# End to end — POST spawns the worker, GET tracks running → done
# ---------------------------------------------------------------------------


class TestEndToEnd:
    @pytest.fixture
    def clean_backfill_state(self):
        import theta_fetcher

        theta_fetcher._clear_backfill_state_for_tests()
        yield
        theta_fetcher._clear_backfill_state_for_tests()

    def test_post_then_poll_reports_running_then_done(
        self, clean_backfill_state, monkeypatch
    ) -> None:
        import theta_fetcher

        monkeypatch.setattr(theta_fetcher.settings, "theta_roots", "SPXW,VIX,VIXW,NDXP")
        gate = threading.Event()

        def gated_fetch(_client, root, _start, _end) -> int:
            gate.wait(timeout=5)
            return 11 if root == "VIX" else 22

        monkeypatch.setattr(theta_fetcher, "_fetch_root_range", gated_fetch)

        payload = {"roots": ["VIX", "VIXW"], "start": _past(3), "end": _past(2)}
        with patch("theta_fetcher.ThetaClient", return_value=MagicMock()):
            try:
                status, body = _post(payload, _AUTH)
                assert status == 202
                assert body["accepted"] is True
                assert body["roots"] == ["VIX", "VIXW"]
                assert body["days"] == 2

                # The POST returned while the worker is still blocked —
                # a ~2h job must never be answered synchronously.
                running_status, running = _get(_AUTH)
                assert running_status == 200
                assert running["state"] == "running"
                assert running["finished_at"] is None

                # Single-flight: a second POST is refused while running.
                busy_status, busy = _post(payload, _AUTH)
                assert busy_status == 423
                assert "in progress" in busy["error"]
            finally:
                gate.set()

            done = self._poll_until_done()

        assert done["state"] == "done"
        assert done["rows"] == 33
        assert done["results"] == [
            {"root": "VIX", "rows": 11, "status": "ok", "error": None},
            {"root": "VIXW", "rows": 22, "status": "ok", "error": None},
        ]
        assert done["finished_at"] is not None

    def test_root_failure_is_reported_per_root_and_overall(
        self, clean_backfill_state, monkeypatch
    ) -> None:
        import theta_fetcher

        monkeypatch.setattr(theta_fetcher.settings, "theta_roots", "SPXW,VIX,VIXW,NDXP")
        monkeypatch.setattr(theta_fetcher, "capture_exception", MagicMock())
        monkeypatch.setattr(theta_fetcher, "capture_message", MagicMock())

        def fetch(_client, root, _start, _end) -> int:
            if root == "VIXW":
                raise RuntimeError("theta terminal hung up")
            return 9

        monkeypatch.setattr(theta_fetcher, "_fetch_root_range", fetch)

        payload = {"roots": ["VIX", "VIXW", "NDXP"], "start": _past(3), "end": _past(2)}
        with patch("theta_fetcher.ThetaClient", return_value=MagicMock()):
            assert _post(payload, _AUTH)[0] == 202
            done = self._poll_until_done()

        assert done["state"] == "failed"
        assert {r["root"]: r["status"] for r in done["results"]} == {
            "VIX": "ok",
            "VIXW": "error",
            "NDXP": "ok",
        }
        assert done["rows"] == 18
        assert "theta terminal hung up" in done["error"]

    @staticmethod
    def _poll_until_done(timeout: float = 5.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            _status, body = _get(_AUTH)
            if body.get("state") != "running":
                return body
            time.sleep(0.01)
        raise AssertionError("targeted backfill never left the running state")
