"""HTTP server exposing /healthz and /metrics for Railway and ops.

Tiny aiohttp app started in a background task by main. Reads `state`
directly — no shared lock because asyncio is single-threaded.
"""

from __future__ import annotations

import hmac
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from aiohttp import web

from config import settings
from logger_setup import log
from state import state

# A connection is healthy if the process is up AND we've heard from at
# least one channel within this window. Conservative; tighten if false
# positives ever happen.
HEALTH_STALE_AFTER = timedelta(minutes=5)

# Trading-hours window for the "connected but no recent data" check.
# Spans the widest of the products we stream: equities open 09:30 ET and
# SPX/SPXW index options run to 16:15 ET. OUTSIDE this window (overnight,
# weekends) the upstream channels are legitimately silent, so a connected
# socket with no recent message is healthy, not stalled — see
# ``_is_trading_hours``. Market holidays are deliberately NOT modelled
# (no holiday calendar in this daemon): on a holiday weekday a connected
# daemon reports "stale", which is harmless while no healthcheckPath is
# wired (Railway ignores /healthz today — it only flips the Docker
# HEALTHCHECK status, not restarts).
_ET = ZoneInfo("America/New_York")
_RTH_OPEN_ET = time(9, 30)
_RTH_CLOSE_ET = time(16, 15)


def _is_trading_hours(now: datetime) -> bool:
    """True if ``now`` (UTC-aware) is within US equity/index RTH.

    Mon-Fri, 09:30-16:15 ET (half-open). DST is handled by ZoneInfo.
    """
    et = now.astimezone(_ET)
    if et.weekday() >= 5:  # Saturday / Sunday
        return False
    return _RTH_OPEN_ET <= et.time() < _RTH_CLOSE_ET

# Window after process start during which /healthz returns 200 even when
# the WS hasn't connected yet AND no message has arrived. Without this,
# a UW outage at deploy time keeps Railway's container restart-loop in
# a perpetual 503 — the daemon never gets past the first connect attempt
# because the orchestrator kills it. 5 minutes matches HEALTH_STALE_AFTER
# so the grace window and the steady-state "stale" window are symmetric.
HEALTH_STARTUP_GRACE_S = 300


async def healthz(_request: web.Request) -> web.Response:
    """200 if WS connected and recent message; 503 otherwise.

    Within the first ``HEALTH_STARTUP_GRACE_S`` seconds after process
    start AND while no message has ever arrived, returns 200 ``starting``
    regardless of ``ws_connected`` so a transient UW outage at deploy
    time doesn't trigger Railway's restart-loop before the connector has
    had a chance to back off and retry.
    """
    now = datetime.now(UTC)

    # Startup grace: keep the orchestrator from killing us during the
    # first few minutes, even if the upstream WS is down. This branch
    # MUST run before the 503 branches below — otherwise a UW outage at
    # deploy time → Railway restart-loops the container forever.
    if (
        state.last_message_ts is None
        and (now - state.started_at).total_seconds() < HEALTH_STARTUP_GRACE_S
    ):
        return web.json_response({"status": "starting"}, status=200)

    # 503 only on a TOTAL disconnect (no shard up). With N sharded sockets a
    # single shard mid-reconnect is routine — gating on ws_connected ("all
    # shards up") would flap the daemon red on every per-shard reconnect. A
    # shard that silently stays unsubscribed is surfaced by the subscription
    # watchdog, not by this check.
    if not state.ws_any_connected:
        return web.json_response({"status": "ws_disconnected"}, status=503)

    # Data flowing within the window is unambiguously healthy, any hour.
    if (
        state.last_message_ts is not None
        and now - state.last_message_ts <= HEALTH_STALE_AFTER
    ):
        return web.json_response({"status": "ok"}, status=200)

    # Past here the socket is connected but no recent data has arrived
    # (either none ever, or the last message is older than the stale
    # window). That is only a FAILURE during trading hours. Outside RTH —
    # overnight, weekends — the upstream channels are legitimately silent,
    # so reporting 503 would needlessly fail the check the whole time the
    # market is closed (and drive a Railway restart loop the moment a
    # healthcheckPath is ever added). Treat connected-but-quiet as healthy
    # when the market is closed.
    if not _is_trading_hours(now):
        return web.json_response({"status": "ok_market_closed"}, status=200)

    if state.last_message_ts is None:
        # In-hours, past the startup grace, never received a message.
        return web.json_response({"status": "no_messages"}, status=503)

    # In-hours and the last message is older than the stale window.
    return web.json_response({"status": "stale"}, status=503)


async def metrics(request: web.Request) -> web.Response:
    """JSON snapshot of per-channel counters and global state.

    Optionally gated on ``INTERNAL_METRICS_TOKEN``: when set, the
    request must carry a matching ``X-Metrics-Token`` header. When
    unset, the endpoint is open (backward compatible with existing
    operator scrape scripts). The comparison is constant-time to
    prevent timing-based token guessing.
    """
    expected = settings.internal_metrics_token
    if expected:
        got = request.headers.get("X-Metrics-Token", "")
        if not hmac.compare_digest(got, expected):
            return web.json_response({"error": "unauthorized"}, status=401)
    now = datetime.now(UTC)
    body = {
        "uptime_seconds": int((now - state.started_at).total_seconds()),
        "ws_connected": state.ws_connected,
        # Per-shard connection state so an operator can see WHICH shard is down
        # during a partial outage (the aggregate ws_connected can't localize it).
        "connections": dict(state.connections),
        "last_message_ts": _iso(state.last_message_ts),
        "reconnects_last_hour": state.reconnects_last_hour(),
        "receive_queue_depth": state.receive_queue_depth,
        "receive_queue_drops": state.receive_queue_drops,
        "channels": {
            name: {
                "subscribed": ch.subscribed,
                "last_message_ts": _iso(ch.last_message_ts),
                "queue_depth": ch.queue_depth,
                "drop_count": ch.drop_count,
                "write_attempted": ch.write_attempted,
                "write_count": ch.write_count,
            }
            for name, ch in state.channels.items()
        },
    }
    return web.json_response(body)


def _iso(ts: datetime | None) -> str | None:
    return ts.isoformat() if ts else None


def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/metrics", metrics)
    return app


async def run_server() -> None:
    """Start the health server. Runs forever."""
    app = build_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host="0.0.0.0", port=settings.port)
    await site.start()
    log.info("health server listening", extra={"port": settings.port})
    # The runner cleans up on cancellation when main exits via signal.
    try:
        # Park forever; the asyncio.gather in main keeps the loop alive.
        import asyncio

        await asyncio.Event().wait()
    finally:
        await runner.cleanup()
