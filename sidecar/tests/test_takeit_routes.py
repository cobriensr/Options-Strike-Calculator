"""Tests for the /takeit/* routes wired into HealthHandler.

Mirrors test_health.py's pattern of driving HealthHandler directly via a
fake request socket. Doesn't load actual ML deps — `takeit_server` is
patched so the routes don't pull in xgboost/shap (those are gated by
TAKEIT_SERVER_ENABLED + dep-import checks).
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from health import HealthHandler  # noqa: E402


class _FakeRequest:
    def __init__(self, method: str, path: str, body: bytes = b"") -> None:
        self.path = path
        # Minimal HTTP/1.1 request — Content-Length set when body present so
        # BaseHTTPRequestHandler's headers parser picks it up.
        if body:
            self.raw = (
                f"{method} {path} HTTP/1.1\r\n"
                f"Host: localhost\r\n"
                f"Content-Length: {len(body)}\r\n"
                f"Content-Type: application/json\r\n"
                f"Authorization: Bearer test-secret\r\n"
                f"\r\n"
            ).encode() + body
        else:
            self.raw = (
                f"{method} {path} HTTP/1.1\r\nHost: localhost\r\n\r\n"
            ).encode()

    def makefile(self, mode: str, *_args: object) -> io.BytesIO:
        return io.BytesIO(self.raw) if "r" in mode else io.BytesIO()


def _drive(method: str, path: str, body: bytes = b"") -> tuple[int, dict]:
    req = _FakeRequest(method=method, path=path, body=body)
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
    status_line, *_ = raw.split("\r\n", 1)
    status = int(status_line.split()[1])
    _, _, body_text = raw.partition("\r\n\r\n")
    try:
        return status, json.loads(body_text) if body_text else {}
    except json.JSONDecodeError:
        return status, {"_raw": body_text}


# ── GET /takeit/health ─────────────────────────────────────────────────


def test_takeit_health_returns_200_with_status_and_enabled_flag() -> None:
    """Health probe always returns 200 — `enabled` reflects gate state."""
    with patch("takeit_server.is_enabled", return_value=False):
        status, body = _drive("GET", "/takeit/health")
    assert status == 200
    assert body["status"] == "ok"
    assert body["enabled"] is False
    assert isinstance(body["bundles_loaded"], list)


def test_takeit_health_reports_enabled_when_dep_check_passes() -> None:
    with patch("takeit_server.is_enabled", return_value=True):
        status, body = _drive("GET", "/takeit/health")
    assert status == 200
    assert body["enabled"] is True


# ── POST /takeit/explain ───────────────────────────────────────────────


def test_takeit_explain_503_when_server_disabled() -> None:
    """When takeit_server is disabled, explain returns 503 without touching
    handle_explain_payload — the cheap gate short-circuits."""
    with (
        patch("takeit_server.is_enabled", return_value=False),
        patch("takeit_server.handle_explain_payload") as mock_handle,
    ):
        status, body = _drive(
            "POST",
            "/takeit/explain",
            body=json.dumps({"alert_type": "lottery", "rows": []}).encode(),
        )
    assert status == 503
    assert "disabled" in body["error"]
    mock_handle.assert_not_called()


def test_takeit_explain_400_on_empty_body() -> None:
    """Content-Length: 0 → 400 short-circuit, never invokes handler."""
    with (
        patch("takeit_server.is_enabled", return_value=True),
        patch("takeit_server.handle_explain_payload") as mock_handle,
    ):
        # _FakeRequest with body=b"" omits Content-Length so we synthesize
        # a POST with zero-length body explicitly.
        req = _FakeRequest("POST", "/takeit/explain", body=b"")
        # Inject Content-Length: 0 by patching the raw bytes.
        req.raw = (
            b"POST /takeit/explain HTTP/1.1\r\n"
            b"Host: localhost\r\n"
            b"Content-Length: 0\r\n"
            b"\r\n"
        )
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
        status = int(raw.split()[1])
    assert status == 400
    mock_handle.assert_not_called()


def test_takeit_explain_forwards_body_to_handler_when_enabled() -> None:
    """Happy path: body + Authorization header reach handle_explain_payload,
    and its (status, body) return tuple becomes the HTTP response."""
    payload = {"alert_type": "lottery", "rows": [{"alert_id": 1, "features": {}}]}
    with (
        patch("takeit_server.is_enabled", return_value=True),
        patch(
            "takeit_server.handle_explain_payload",
            return_value=(200, {"results": [{"alert_id": 1, "top_positive": [], "top_negative": []}]}),
        ) as mock_handle,
    ):
        status, body = _drive(
            "POST",
            "/takeit/explain",
            body=json.dumps(payload).encode(),
        )
    assert status == 200
    assert body["results"][0]["alert_id"] == 1
    mock_handle.assert_called_once()
    body_bytes, auth = mock_handle.call_args[0]
    assert json.loads(body_bytes) == payload
    assert auth == "Bearer test-secret"


def test_takeit_explain_propagates_handler_error_status() -> None:
    """A 401 from the auth check inside handle_explain_payload surfaces as
    an HTTP 401, with the JSON body forwarded verbatim."""
    with (
        patch("takeit_server.is_enabled", return_value=True),
        patch(
            "takeit_server.handle_explain_payload",
            return_value=(401, {"error": "unauthorized"}),
        ),
    ):
        status, body = _drive(
            "POST",
            "/takeit/explain",
            body=json.dumps({"alert_type": "lottery", "rows": []}).encode(),
        )
    assert status == 401
    assert body == {"error": "unauthorized"}
