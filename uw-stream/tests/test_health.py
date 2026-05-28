"""Unit tests for src/health.py — Phase 3.1 (H3) startup grace.

Phase 3 of the uw-stream-hardening spec extended ``/healthz`` so the
container survives a UW outage at deploy time: when no message has ever
arrived AND the process is younger than ``HEALTH_STARTUP_GRACE_S``,
return 200 ``starting`` regardless of ``ws_connected``.

Without this, Railway's container restart-loop can kill the daemon
forever — the first connect never completes during the upstream outage,
``/healthz`` reports 503, the orchestrator restarts, and the cycle
repeats.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from config import settings
from health import HEALTH_STARTUP_GRACE_S, healthz, metrics
from state import state


@pytest.fixture(autouse=True)
def _reset_state():
    """Snapshot + restore the state singleton around each test."""
    snapshot = (
        state.started_at,
        state.ws_connected,
        state.last_message_ts,
    )
    yield
    state.started_at, state.ws_connected, state.last_message_ts = snapshot


async def _read_json(resp) -> dict:
    """Pull the JSON body out of an aiohttp Response without a server."""
    body = resp.body
    if isinstance(body, (bytes, bytearray)):
        return json.loads(body.decode())
    return json.loads(body)


async def test_healthz_returns_200_during_startup_grace():
    """Within HEALTH_STARTUP_GRACE_S of start, no message + no WS → 200."""
    state.started_at = datetime.now(UTC) - timedelta(seconds=60)
    state.ws_connected = False
    state.last_message_ts = None

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 200
    assert body == {"status": "starting"}


async def test_healthz_falls_back_to_503_after_grace_expires():
    """Past HEALTH_STARTUP_GRACE_S with no message and no WS → 503."""
    # 6 minutes ago — well past the 300s grace window.
    state.started_at = datetime.now(UTC) - timedelta(seconds=HEALTH_STARTUP_GRACE_S + 60)
    state.ws_connected = False
    state.last_message_ts = None

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 503
    assert body == {"status": "ws_disconnected"}


async def test_healthz_ws_connected_no_message_during_grace_returns_starting():
    """During grace, a successfully-connected WS that hasn't yielded a
    message yet still reports ``starting`` (not ``ok``) so dashboards
    can distinguish "joined but silent" from "data flowing".
    """
    state.started_at = datetime.now(UTC) - timedelta(seconds=10)
    state.ws_connected = True
    state.last_message_ts = None

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 200
    assert body == {"status": "starting"}


async def test_healthz_ws_connected_no_message_post_grace_is_no_messages():
    """Past grace, WS connected but never received a message → 503 with
    the existing ``no_messages`` status preserved.
    """
    state.started_at = datetime.now(UTC) - timedelta(seconds=HEALTH_STARTUP_GRACE_S + 60)
    state.ws_connected = True
    state.last_message_ts = None

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 503
    assert body == {"status": "no_messages"}


async def test_healthz_returns_ok_when_recent_message():
    """Steady state: WS connected and a message arrived within
    HEALTH_STALE_AFTER → 200 ``ok``.
    """
    state.started_at = datetime.now(UTC) - timedelta(hours=1)
    state.ws_connected = True
    state.last_message_ts = datetime.now(UTC) - timedelta(seconds=5)

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 200
    assert body == {"status": "ok"}


async def test_healthz_returns_stale_when_message_gap_too_large():
    """Steady state: last message older than HEALTH_STALE_AFTER → 503."""
    state.started_at = datetime.now(UTC) - timedelta(hours=1)
    state.ws_connected = True
    state.last_message_ts = datetime.now(UTC) - timedelta(minutes=10)

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 503
    assert body == {"status": "stale"}


# ── /metrics auth gate ───────────────────────────────────────


class _StubRequest:
    """Minimal stand-in for aiohttp.web.Request — `metrics()` only
    consults ``request.headers.get(name, default)``.
    """

    def __init__(self, headers: dict[str, str] | None = None):
        self.headers = headers or {}


@pytest.fixture
def _restore_metrics_token():
    saved = settings.internal_metrics_token
    yield
    settings.internal_metrics_token = saved


async def test_metrics_open_when_token_env_unset(_restore_metrics_token):
    """Default deployment: no INTERNAL_METRICS_TOKEN → /metrics returns
    200 without any header so operator scrape scripts keep working.
    """
    settings.internal_metrics_token = ""
    resp = await metrics(_StubRequest())  # type: ignore[arg-type]
    assert resp.status == 200


async def test_metrics_requires_token_when_configured(_restore_metrics_token):
    """With INTERNAL_METRICS_TOKEN set, a request without the matching
    X-Metrics-Token header is rejected 401.
    """
    settings.internal_metrics_token = "expected-token"
    resp = await metrics(_StubRequest())  # type: ignore[arg-type]
    assert resp.status == 401


async def test_metrics_rejects_wrong_token(_restore_metrics_token):
    """With INTERNAL_METRICS_TOKEN set, a mismatched header is rejected."""
    settings.internal_metrics_token = "expected-token"
    resp = await metrics(
        _StubRequest({"X-Metrics-Token": "wrong"}),  # type: ignore[arg-type]
    )
    assert resp.status == 401


async def test_metrics_accepts_matching_token(_restore_metrics_token):
    """With INTERNAL_METRICS_TOKEN set, a matching header passes through."""
    settings.internal_metrics_token = "expected-token"
    resp = await metrics(
        _StubRequest({"X-Metrics-Token": "expected-token"}),  # type: ignore[arg-type]
    )
    assert resp.status == 200
