"""HTTP server exposing /healthz and /metrics for Railway and ops.

Tiny aiohttp app started in a background task by main. Reads `state`
directly — no shared lock because asyncio is single-threaded.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from aiohttp import web

from config import settings
from logger_setup import log
from state import state

# A connection is healthy if the process is up AND we've heard from at
# least one channel within this window. Conservative; tighten if false
# positives ever happen.
HEALTH_STALE_AFTER = timedelta(minutes=5)

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

    if not state.ws_connected:
        return web.json_response({"status": "ws_disconnected"}, status=503)

    if state.last_message_ts is None:
        # Past the startup grace window without any message — fail.
        return web.json_response({"status": "no_messages"}, status=503)

    if now - state.last_message_ts > HEALTH_STALE_AFTER:
        return web.json_response({"status": "stale"}, status=503)

    return web.json_response({"status": "ok"}, status=200)


async def metrics(_request: web.Request) -> web.Response:
    """JSON snapshot of per-channel counters and global state."""
    now = datetime.now(UTC)
    body = {
        "uptime_seconds": int((now - state.started_at).total_seconds()),
        "ws_connected": state.ws_connected,
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
