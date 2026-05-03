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


async def healthz(_request: web.Request) -> web.Response:
    """200 if WS connected and recent message; 503 otherwise."""
    if not state.ws_connected:
        return web.json_response({"status": "ws_disconnected"}, status=503)

    if state.last_message_ts is None:
        # Just started; give the connector a grace period.
        if datetime.now(UTC) - state.started_at > HEALTH_STALE_AFTER:
            return web.json_response({"status": "no_messages"}, status=503)
        return web.json_response({"status": "starting"}, status=200)

    if datetime.now(UTC) - state.last_message_ts > HEALTH_STALE_AFTER:
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
        "channels": {
            name: {
                "subscribed": ch.subscribed,
                "last_message_ts": _iso(ch.last_message_ts),
                "queue_depth": ch.queue_depth,
                "drop_count": ch.drop_count,
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
