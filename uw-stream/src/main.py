"""uw-stream entrypoint.

Wires up Sentry → DB pool → handlers → router → connector → health server,
then awaits everything concurrently. Exits cleanly on SIGTERM (Railway
graceful shutdown signal) or SIGINT.

Phase 1 ships only the flow-alerts handler. Adding a new channel later
is a 3-line change here: import the handler, register it under
``handlers[channel_name] = HandlerInstance()``.
"""

from __future__ import annotations

import asyncio
import contextlib
import signal

from config import settings
from connector import Connector
from db import close_pool, init_pool
from handlers.base import Handler
from handlers.flow_alerts import FlowAlertsHandler
from health import run_server
from logger_setup import log
from router import Router
from sentry_setup import capture_exception, init_sentry
from state import state


def _build_handlers(channels: list[str]) -> dict[str, Handler]:
    """Map channel name → handler instance.

    Raises if the configured channel set contains a channel we have no
    handler for — fail fast on misconfiguration rather than silently
    dropping every payload.
    """
    available: dict[str, Handler] = {
        "flow-alerts": FlowAlertsHandler(),
    }
    selected: dict[str, Handler] = {}
    for ch in channels:
        if ch not in available:
            raise RuntimeError(
                f"WS_CHANNELS contains {ch!r} but no handler is registered. "
                f"Available: {sorted(available)}"
            )
        selected[ch] = available[ch]
        state.channel(ch).subscribed = False
    return selected


async def _run() -> None:
    init_sentry()
    log.info(
        "uw-stream starting",
        extra={
            "channels": settings.channels,
            "queue_size": settings.ws_queue_size,
            "batch_size": settings.ws_batch_size,
            "batch_interval_ms": settings.ws_batch_interval_ms,
            "policy": settings.ws_backpressure_policy,
        },
    )

    await init_pool()

    handlers = _build_handlers(settings.channels)
    router = Router(handlers)
    connector = Connector(channels=settings.channels, on_message=router.dispatch)

    tasks: list[asyncio.Task] = [
        asyncio.create_task(connector.run(), name="connector"),
        asyncio.create_task(run_server(), name="health"),
    ]
    for ch_name, handler in handlers.items():
        tasks.append(
            asyncio.create_task(handler.run(), name=f"handler:{ch_name}")
        )

    # Install signal handlers for clean Railway shutdown. SIGTERM is
    # what Railway sends on deploy / restart; SIGINT is for local Ctrl-C.
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        # add_signal_handler is unavailable on Windows; fine to skip
        # because this runs in macOS dev and Linux containers only.
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)

    # Wait for either a signal or any task to die unexpectedly.
    done_task = asyncio.create_task(stop.wait(), name="stop_wait")
    done, pending = await asyncio.wait(
        [*tasks, done_task],
        return_when=asyncio.FIRST_COMPLETED,
    )

    log.info("shutdown initiated", extra={"reason": _describe_done(done)})

    # Cancel everything still running and wait briefly for them to wind
    # down. We don't await indefinitely because Railway will SIGKILL us
    # after a few seconds anyway.
    for t in pending:
        t.cancel()
    await asyncio.gather(*pending, return_exceptions=True)

    await close_pool()
    log.info("uw-stream stopped")


def _describe_done(done: set) -> str:
    """Render the first completed task's name for the shutdown log."""
    for t in done:
        return t.get_name()
    return "unknown"


def main() -> None:
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        # Already handled by the stop signal flow; just exit quietly.
        pass
    except Exception as exc:
        capture_exception(exc, tags={"component": "main"})
        raise


if __name__ == "__main__":
    main()
