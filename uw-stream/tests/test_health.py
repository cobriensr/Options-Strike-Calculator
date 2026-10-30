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
from aiohttp.test_utils import TestClient, TestServer

from config import Settings, settings
from health import HEALTH_STARTUP_GRACE_S, _is_trading_hours, build_app, healthz, metrics
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


async def test_healthz_ws_connected_no_message_post_grace_is_no_messages(monkeypatch):
    """Past grace, IN TRADING HOURS, WS connected but never received a
    message → 503 with the existing ``no_messages`` status preserved.
    """
    monkeypatch.setattr("health._is_trading_hours", lambda _now: True)
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


async def test_healthz_returns_stale_when_message_gap_too_large(monkeypatch):
    """In trading hours: last message older than HEALTH_STALE_AFTER → 503."""
    monkeypatch.setattr("health._is_trading_hours", lambda _now: True)
    state.started_at = datetime.now(UTC) - timedelta(hours=1)
    state.ws_connected = True
    state.last_message_ts = datetime.now(UTC) - timedelta(minutes=10)

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 503
    assert body == {"status": "stale"}


async def test_healthz_market_closed_no_message_is_healthy(monkeypatch):
    """OUTSIDE trading hours, a connected socket with no message is
    healthy — the upstream channels are legitimately silent overnight /
    on weekends, so we must NOT 503 (which would restart-loop the daemon
    if a healthcheckPath were wired up).
    """
    monkeypatch.setattr("health._is_trading_hours", lambda _now: False)
    state.started_at = datetime.now(UTC) - timedelta(seconds=HEALTH_STARTUP_GRACE_S + 60)
    state.ws_connected = True
    state.last_message_ts = None

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 200
    assert body == {"status": "ok_market_closed"}


async def test_healthz_market_closed_stale_is_healthy(monkeypatch):
    """Outside trading hours, a stale last-message gap is expected, not a
    failure → 200.
    """
    monkeypatch.setattr("health._is_trading_hours", lambda _now: False)
    state.started_at = datetime.now(UTC) - timedelta(hours=1)
    state.ws_connected = True
    state.last_message_ts = datetime.now(UTC) - timedelta(minutes=30)

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 200
    assert body == {"status": "ok_market_closed"}


async def test_healthz_disconnected_is_503_even_when_market_closed(monkeypatch):
    """ws_disconnected is always unhealthy — the market-closed allowance
    only relaxes the data-flow checks, never the connection check.
    """
    monkeypatch.setattr("health._is_trading_hours", lambda _now: False)
    state.started_at = datetime.now(UTC) - timedelta(hours=1)
    state.ws_connected = False
    state.last_message_ts = datetime.now(UTC) - timedelta(minutes=30)

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 503
    assert body == {"status": "ws_disconnected"}


async def test_healthz_ok_when_recent_message_even_if_market_closed(monkeypatch):
    """Recent data == healthy regardless of clock; the trading-hours gate
    is only consulted when there's no recent message.
    """
    monkeypatch.setattr("health._is_trading_hours", lambda _now: False)
    state.started_at = datetime.now(UTC) - timedelta(hours=1)
    state.ws_connected = True
    state.last_message_ts = datetime.now(UTC) - timedelta(seconds=5)

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 200
    assert body == {"status": "ok"}


async def test_healthz_partial_outage_one_shard_up_is_200(monkeypatch):
    """Partial outage: one shard down, one up → ws_any_connected True → 200.

    With N sharded sockets a single shard mid-reconnect is routine. /healthz
    gates on ws_any_connected, so it must NOT flap the daemon red while another
    shard is still streaming data.
    """
    monkeypatch.setattr("health._is_trading_hours", lambda _now: True)
    state.started_at = datetime.now(UTC) - timedelta(seconds=HEALTH_STARTUP_GRACE_S + 60)
    state.connections = {}
    state.set_connection("conn0", False)  # one shard mid-reconnect
    state.set_connection("conn1", True)  # the rest still up
    state.last_message_ts = datetime.now(UTC) - timedelta(seconds=5)

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 200
    assert body == {"status": "ok"}


async def test_healthz_all_shards_down_is_503(monkeypatch):
    """Total outage: every shard down → ws_any_connected False → 503.

    Only when NO shard is up does /healthz report ws_disconnected.
    """
    monkeypatch.setattr("health._is_trading_hours", lambda _now: True)
    state.started_at = datetime.now(UTC) - timedelta(seconds=HEALTH_STARTUP_GRACE_S + 60)
    state.connections = {}
    state.set_connection("conn0", False)
    state.set_connection("conn1", False)
    state.last_message_ts = None

    resp = await healthz(None)  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 503
    assert body == {"status": "ws_disconnected"}


# ── _is_trading_hours ────────────────────────────────────────


def test_is_trading_hours_true_midday_weekday():
    # 2026-05-28 is a Thursday. 15:00 UTC → 11:00 ET (EDT) → in RTH.
    assert _is_trading_hours(datetime(2026, 5, 28, 15, 0, tzinfo=UTC)) is True


def test_is_trading_hours_false_overnight_weekday():
    # 2026-05-28 06:00 UTC → 02:00 ET → outside RTH.
    assert _is_trading_hours(datetime(2026, 5, 28, 6, 0, tzinfo=UTC)) is False


def test_is_trading_hours_false_weekend():
    # 2026-05-30 is a Saturday. 15:00 UTC → 11:00 ET but weekend.
    assert _is_trading_hours(datetime(2026, 5, 30, 15, 0, tzinfo=UTC)) is False


def test_is_trading_hours_false_after_close():
    # 2026-05-28 (Thu) 20:30 UTC → 16:30 ET → past the 16:15 close.
    assert _is_trading_hours(datetime(2026, 5, 28, 20, 30, tzinfo=UTC)) is False


# ── /metrics auth gate ───────────────────────────────────────

_TOKEN = "expected-token"
_UNAUTHORIZED = {"error": "unauthorized"}


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


@pytest.fixture
def metrics_warnings(monkeypatch) -> list[str]:
    """Capture ``health.log.warning`` messages and reset the log-once flag.

    The project logger sets ``propagate=False``, so ``caplog`` never sees
    its records. Patching the bound ``log.warning`` is the direct contract
    check (as in ``test_handlers._record_warnings``).
    """
    import health as health_mod

    captured: list[str] = []

    def _warning(msg, *args, **_kwargs):
        captured.append(msg % args if args else msg)

    monkeypatch.setattr(health_mod.log, "warning", _warning)
    monkeypatch.setattr(health_mod, "_metrics_token_unset_logged", False)
    return captured


async def test_metrics_refuses_when_token_unset(_restore_metrics_token, metrics_warnings):
    """No INTERNAL_METRICS_TOKEN → 401 with the refusal body and none of
    the metrics fields, plus a warning that names the variable.
    """
    settings.internal_metrics_token = ""
    resp = await metrics(_StubRequest())  # type: ignore[arg-type]

    assert resp.status == 401
    assert await _read_json(resp) == _UNAUTHORIZED
    assert len(metrics_warnings) == 1
    assert "INTERNAL_METRICS_TOKEN" in metrics_warnings[0]


async def test_metrics_refuses_empty_header_when_token_unset(
    _restore_metrics_token, metrics_warnings
):
    """An empty X-Metrics-Token header never matches an unset token."""
    settings.internal_metrics_token = ""
    resp = await metrics(
        _StubRequest({"X-Metrics-Token": ""}),  # type: ignore[arg-type]
    )

    assert resp.status == 401
    assert await _read_json(resp) == _UNAUTHORIZED


async def test_metrics_unset_token_warning_logs_once(_restore_metrics_token, metrics_warnings):
    """Repeated requests with the token unset all get 401, but the warning
    is written once per process, not once per request.
    """
    settings.internal_metrics_token = ""
    for _ in range(3):
        resp = await metrics(_StubRequest())  # type: ignore[arg-type]
        assert resp.status == 401

    assert len(metrics_warnings) == 1


async def test_metrics_requires_token_when_configured(_restore_metrics_token, metrics_warnings):
    """With INTERNAL_METRICS_TOKEN set, a request without the
    X-Metrics-Token header is rejected 401.
    """
    settings.internal_metrics_token = _TOKEN
    resp = await metrics(_StubRequest())  # type: ignore[arg-type]

    assert resp.status == 401
    assert await _read_json(resp) == _UNAUTHORIZED
    assert metrics_warnings == []


async def test_metrics_rejects_wrong_token(_restore_metrics_token, metrics_warnings):
    """With INTERNAL_METRICS_TOKEN set, a mismatched header is rejected 401."""
    settings.internal_metrics_token = _TOKEN
    resp = await metrics(
        _StubRequest({"X-Metrics-Token": "wrong"}),  # type: ignore[arg-type]
    )

    assert resp.status == 401
    assert await _read_json(resp) == _UNAUTHORIZED


async def test_metrics_rejects_non_ascii_token_with_401(_restore_metrics_token, metrics_warnings):
    """aiohttp decodes header bytes as UTF-8 with surrogateescape, so a
    header can carry non-ASCII text. It is a 401 like any other mismatch.
    """
    settings.internal_metrics_token = _TOKEN
    for value in ("tökén", "\udcff"):
        resp = await metrics(
            _StubRequest({"X-Metrics-Token": value}),  # type: ignore[arg-type]
        )
        assert resp.status == 401
        assert await _read_json(resp) == _UNAUTHORIZED


async def test_metrics_accepts_matching_token(_restore_metrics_token, metrics_warnings):
    """With INTERNAL_METRICS_TOKEN set, a matching header gets the JSON."""
    settings.internal_metrics_token = _TOKEN
    resp = await metrics(
        _StubRequest({"X-Metrics-Token": _TOKEN}),  # type: ignore[arg-type]
    )
    body = await _read_json(resp)

    assert resp.status == 200
    assert {"uptime_seconds", "ws_connected", "channels", "handlers"} <= body.keys()
    assert metrics_warnings == []


def test_settings_boot_without_metrics_token(monkeypatch):
    """Settings constructs with INTERNAL_METRICS_TOKEN absent: the token
    defaults empty, so the service boots and only /metrics refuses.
    """
    monkeypatch.delenv("INTERNAL_METRICS_TOKEN", raising=False)
    s = Settings(
        _env_file=None,  # type: ignore[call-arg]
        database_url="postgresql://test",
        uw_api_key="test",
        kv_rest_api_url="https://test.upstash.io",
        kv_rest_api_token="test-token",
    )

    assert s.internal_metrics_token == ""


# ── Routing through build_app() ──────────────────────────────


@pytest.fixture
async def app_client():
    """The real aiohttp app on a loopback test server."""
    async with TestClient(TestServer(build_app())) as client:
        yield client


@pytest.mark.parametrize("token", ["", _TOKEN])
async def test_healthz_route_needs_no_header(app_client, _restore_metrics_token, token):
    """/healthz answers without an X-Metrics-Token header whether or not
    the metrics token is configured.
    """
    settings.internal_metrics_token = token
    state.started_at = datetime.now(UTC) - timedelta(seconds=60)
    state.last_message_ts = None

    resp = await app_client.get("/healthz")

    assert resp.status == 200
    assert await resp.json() == {"status": "starting"}


async def test_metrics_route_requires_header(app_client, _restore_metrics_token, metrics_warnings):
    """Through the app's router: no header → 401, matching header → 200."""
    settings.internal_metrics_token = _TOKEN

    missing = await app_client.get("/metrics")
    assert missing.status == 401
    assert await missing.json() == _UNAUTHORIZED

    ok = await app_client.get("/metrics", headers={"X-Metrics-Token": _TOKEN})
    assert ok.status == 200
    assert "handlers" in await ok.json()


async def test_metrics_route_refuses_when_token_unset(
    app_client, _restore_metrics_token, metrics_warnings
):
    """Through the app's router with the token unset: 401 even for a
    request carrying an empty header.
    """
    settings.internal_metrics_token = ""

    resp = await app_client.get("/metrics", headers={"X-Metrics-Token": ""})

    assert resp.status == 401
    assert await resp.json() == _UNAUTHORIZED
    assert len(metrics_warnings) == 1


# ── /metrics shape: channels vs handlers (E5) ────────────────


@pytest.fixture
def _isolated_channel_handler_state():
    """Run against empty channel/handler maps, then restore the originals."""
    saved_channels = dict(state.channels)
    saved_handlers = dict(state.handlers)
    state.channels.clear()
    state.handlers.clear()
    yield
    state.channels.clear()
    state.channels.update(saved_channels)
    state.handlers.clear()
    state.handlers.update(saved_handlers)


async def test_metrics_reports_handler_counters_under_handlers(
    monkeypatch, _restore_metrics_token, _isolated_channel_handler_state
):
    """The real shared NetFlowHandler's counters increment through the base
    Handler paths and surface under ``handlers`` keyed by the family name,
    while ``channels`` carries only real channels' subscription fields.
    """
    import db
    from handlers.net_flow import NetFlowHandler

    async def _one_conflict_skip(*, rows, **_kwargs) -> int:
        return len(rows) - 1

    monkeypatch.setattr(db, "bulk_insert_ignore_conflict", _one_conflict_skip)
    monkeypatch.setattr(settings, "ws_queue_size", 1)
    monkeypatch.setattr(settings, "ws_backpressure_policy", "drop_newest")
    settings.internal_metrics_token = _TOKEN

    state.channel("net_flow:TSLA").subscribed = True
    h = NetFlowHandler()
    await h.enqueue({"seq": 1})  # queue_depth 1
    await h.enqueue({"seq": 2})  # queue full → drop_newest → drop_count 1
    await h._safe_flush([(1,), (2,), (3,)])  # attempted 3, written 2

    resp = await metrics(_StubRequest({"X-Metrics-Token": _TOKEN}))  # type: ignore[arg-type]
    body = await _read_json(resp)

    assert resp.status == 200
    assert body["handlers"] == {
        "net_flow": {
            "queue_depth": 1,
            "drop_count": 1,
            "write_attempted": 3,
            "write_count": 2,
        },
    }
    assert body["channels"] == {
        "net_flow:TSLA": {"subscribed": True, "last_message_ts": None},
    }
    assert "net_flow" not in body["channels"]


@pytest.mark.parametrize(
    ("started_ago_s", "connected", "last_msg_ago_s", "expected"),
    [
        (60, False, None, (200, {"status": "starting"})),
        (HEALTH_STARTUP_GRACE_S + 60, False, None, (503, {"status": "ws_disconnected"})),
        (3600, True, 5, (200, {"status": "ok"})),
    ],
)
async def test_healthz_does_not_read_channel_or_handler_state(
    _isolated_channel_handler_state, started_ago_s, connected, last_msg_ago_s, expected
):
    """/healthz output is identical whether the channel/handler maps are empty
    or full of unsubscribed channels, phantom keys, and non-zero counters.
    """
    now = datetime.now(UTC)
    state.started_at = now - timedelta(seconds=started_ago_s)
    state.ws_connected = connected
    state.last_message_ts = (
        None if last_msg_ago_s is None else now - timedelta(seconds=last_msg_ago_s)
    )

    empty_resp = await healthz(None)  # type: ignore[arg-type]
    empty = (empty_resp.status, await _read_json(empty_resp))

    state.channel("net_flow:TSLA").subscribed = False
    state.channel("net_flow").subscribed = False  # legacy phantom shape
    counters = state.handler("net_flow")
    counters.queue_depth, counters.drop_count = 7, 3
    counters.write_attempted, counters.write_count = 100, 90

    populated_resp = await healthz(None)  # type: ignore[arg-type]
    populated = (populated_resp.status, await _read_json(populated_resp))

    assert empty == populated == expected


async def test_metrics_lists_constructed_handler_with_zeroed_counters(
    _restore_metrics_token, _isolated_channel_handler_state
):
    """A handler built at boot shows a zeroed ``handlers`` row before any
    traffic, and constructing it mints no ``channels`` entry.
    """
    from handlers.flow_alerts import FlowAlertsHandler

    settings.internal_metrics_token = _TOKEN
    FlowAlertsHandler()

    body = await _read_json(
        await metrics(_StubRequest({"X-Metrics-Token": _TOKEN}))  # type: ignore[arg-type]
    )

    assert body["handlers"] == {
        "flow-alerts": {
            "queue_depth": 0,
            "drop_count": 0,
            "write_attempted": 0,
            "write_count": 0,
        },
    }
    assert body["channels"] == {}
