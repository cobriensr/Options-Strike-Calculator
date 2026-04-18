"""Tests for health — the sidecar's /health HTTP endpoint.

Exercises the HealthHandler class directly rather than spinning up a
real HTTPServer. The handler's GET path writes status + headers + body
via `self.send_response` / `self.end_headers` / `self.wfile.write`,
which we intercept with a tiny fake wfile so we can assert JSON shape.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from health import HealthHandler  # noqa: E402


class _FakeRequest:
    """Minimal request stub BaseHTTPRequestHandler expects."""

    def __init__(self, path: str = "/health") -> None:
        self.path = path
        self.raw = (
            f"GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n".encode()
        )

    def makefile(self, mode: str, *_args: object) -> io.BytesIO:
        if "r" in mode:
            return io.BytesIO(self.raw)
        return io.BytesIO()


def _run_request(path: str = "/health") -> tuple[int, dict]:
    """Drive HealthHandler for one request; return (status, body_obj)."""
    req = _FakeRequest(path=path)
    # Write buffer lives on the instance as `wfile` once BaseHTTPRequestHandler
    # runs setup(). We capture everything it writes for later parsing.
    output = io.BytesIO()

    class _H(HealthHandler):
        def setup(self_inner) -> None:  # noqa: N805
            self_inner.rfile = req.makefile("rb")
            self_inner.wfile = output

        def finish(self_inner) -> None:  # noqa: N805
            pass

        def log_message(self_inner, *_a: object, **_kw: object) -> None:  # noqa: N805
            pass

    _H(req, ("127.0.0.1", 0), None)  # type: ignore[arg-type]
    raw = output.getvalue().decode()
    # First line: HTTP/1.x <status> <reason>
    status_line, *rest = raw.split("\r\n", 1)
    status = int(status_line.split()[1])
    # Body is everything after the empty separator line.
    _, _, body_text = raw.partition("\r\n\r\n")
    if not body_text:
        return status, {}
    try:
        return status, json.loads(body_text)
    except json.JSONDecodeError:
        return status, {"_raw": body_text}


@pytest.fixture(autouse=True)
def reset_handler_state() -> None:
    """Clear class-level callables between tests."""
    # Force Theta reporters off by default so tests are deterministic.
    HealthHandler.theta_is_running = None
    HealthHandler.theta_last_ready_at = None
    HealthHandler.theta_last_error = None
    yield


@pytest.fixture
def configure_base_callables() -> None:
    """Install connected/db-healthy/non-stale reporters that return OK."""
    HealthHandler.is_connected = staticmethod(lambda: True)
    HealthHandler.last_bar_at = staticmethod(lambda: 9e18)  # "recent"
    HealthHandler.is_db_healthy = staticmethod(lambda: True)


def test_health_returns_200_when_all_ok(configure_base_callables) -> None:
    # Data-freshness logic only runs when _is_data_expected() is True;
    # force False to avoid weekday/hour dependency in tests.
    with patch("health._is_data_expected", return_value=False):
        status, body = _run_request()

    assert status == 200
    assert body["status"] == "ok"
    assert body["checks"] == {"databento": True, "data_fresh": True, "db": True}
    # No Theta block when reporters aren't configured.
    assert "theta" not in body


def test_health_returns_503_when_db_down(configure_base_callables) -> None:
    HealthHandler.is_db_healthy = staticmethod(lambda: False)
    with patch("health._is_data_expected", return_value=False):
        status, body = _run_request()

    assert status == 503
    assert body["status"] == "degraded"
    assert body["checks"]["db"] is False


def test_health_returns_404_for_unknown_path(configure_base_callables) -> None:
    status, body = _run_request(path="/foo")
    assert status == 404


def test_health_includes_theta_block_when_configured(
    configure_base_callables,
) -> None:
    HealthHandler.theta_is_running = staticmethod(lambda: True)
    HealthHandler.theta_last_ready_at = staticmethod(lambda: 1776549000.0)
    HealthHandler.theta_last_error = staticmethod(lambda: None)

    with patch("health._is_data_expected", return_value=False):
        status, body = _run_request()

    assert status == 200
    assert "theta" in body
    assert body["theta"] == {
        "running": True,
        "last_ready_at": 1776549000.0,
        "last_error": None,
    }


def test_health_theta_never_downgrades_overall_status(
    configure_base_callables,
) -> None:
    # Theta is additive — if Theta is dead but Databento + DB are fine,
    # overall status stays 'ok' / 200.
    HealthHandler.theta_is_running = staticmethod(lambda: False)
    HealthHandler.theta_last_ready_at = staticmethod(lambda: 0.0)
    HealthHandler.theta_last_error = staticmethod(
        lambda: "Theta HTTP server failed to come up"
    )

    with patch("health._is_data_expected", return_value=False):
        status, body = _run_request()

    assert status == 200
    assert body["status"] == "ok"
    assert body["theta"]["running"] is False
    assert body["theta"]["last_ready_at"] is None  # 0.0 coerced to None
    assert body["theta"]["last_error"] == "Theta HTTP server failed to come up"


def test_health_handles_theta_reporter_exceptions(
    configure_base_callables,
) -> None:
    # If a Theta reporter raises (e.g. race during shutdown), handler
    # must still respond rather than 500. Last-ready → 0.0, last-error → None.
    def boom() -> float:
        raise RuntimeError("boom")

    HealthHandler.theta_is_running = staticmethod(lambda: True)
    HealthHandler.theta_last_ready_at = staticmethod(boom)
    HealthHandler.theta_last_error = staticmethod(boom)  # type: ignore[arg-type]

    with patch("health._is_data_expected", return_value=False):
        status, body = _run_request()

    assert status == 200
    assert body["theta"]["running"] is True
    assert body["theta"]["last_ready_at"] is None
    assert body["theta"]["last_error"] is None
