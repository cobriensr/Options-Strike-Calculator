"""uw-stream entrypoint.

Wires up Sentry → DB pool → handlers → router → connector → health server,
then awaits everything concurrently. Exits cleanly on SIGTERM (Railway
graceful shutdown signal) or SIGINT.

Adding a new channel: register its name → handler-class entry in
``channel_registry.py``. ``_build_handlers`` here picks it up
automatically (one instance per handler class, shared across every
channel that maps to the same class).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal

from channel_registry import handler_class_for_channel
from config import settings
from connector import Connector
from db import close_pool, init_pool
from handlers.base import Handler
from health import run_server
from logger_setup import log
from router import Router
from sentry_setup import capture_exception, init_sentry
from state import state

# Bounded buffer between the connector (WS receive) and the router
# (parse + dispatch). At ~10k msgs/sec peak this gives ~1s of headroom
# before drop-oldest kicks in. Override via WS_RECEIVE_QUEUE_SIZE for
# load testing without a code change.
RECEIVE_QUEUE_SIZE = 10_000


def _receive_queue_size() -> int:
    """Read WS_RECEIVE_QUEUE_SIZE env var or fall back to the default."""
    raw = os.environ.get("WS_RECEIVE_QUEUE_SIZE")
    if raw is None or not raw.strip():
        return RECEIVE_QUEUE_SIZE
    try:
        value = int(raw)
    except ValueError:
        log.warning(
            "ignoring invalid WS_RECEIVE_QUEUE_SIZE",
            extra={"value": raw, "fallback": RECEIVE_QUEUE_SIZE},
        )
        return RECEIVE_QUEUE_SIZE
    if value <= 0:
        log.warning(
            "ignoring non-positive WS_RECEIVE_QUEUE_SIZE",
            extra={"value": raw, "fallback": RECEIVE_QUEUE_SIZE},
        )
        return RECEIVE_QUEUE_SIZE
    return value


def _build_handlers(channels: list[str]) -> dict[str, Handler]:
    """Map channel name → handler instance.

    Channel-name → handler-class lookups go through ``channel_registry``
    (the single source of truth — see that module's docstring). Every
    channel sharing a handler class also shares a single handler
    INSTANCE so the queue, batch, and DB write loop are pooled (e.g. one
    OptionTradesHandler services every ``option_trades:<TICKER>``
    subscription, so backpressure applies across the universe rather
    than per-ticker).

    Raises ``RuntimeError`` if a channel slips past
    ``Settings._validate_channels_known`` somehow — defense in depth, not
    the primary error surface.
    """
    instances: dict[type[Handler], Handler] = {}
    selected: dict[str, Handler] = {}
    for ch in channels:
        try:
            handler_cls = handler_class_for_channel(ch)
        except KeyError as exc:
            raise RuntimeError(
                f"WS_CHANNELS contains {ch!r} but no handler is registered "
                "in channel_registry.py. This should have been rejected "
                "at Settings() construction — file a bug."
            ) from exc
        if handler_cls not in instances:
            instances[handler_cls] = handler_cls()
        selected[ch] = instances[handler_cls]
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
    receive_queue_size = _receive_queue_size()
    receive_queue: asyncio.Queue = asyncio.Queue(maxsize=receive_queue_size)
    connector = Connector(channels=settings.channels, receive_queue=receive_queue)
    log.info(
        "receive queue configured",
        extra={"maxsize": receive_queue_size},
    )

    tasks: list[asyncio.Task] = [
        asyncio.create_task(connector.run(), name="connector"),
        asyncio.create_task(router.run(receive_queue), name="router"),
        asyncio.create_task(run_server(), name="health"),
    ]
    # Spawn one drain task per UNIQUE handler instance — many channels
    # can share one handler (e.g. every option_trades:<TICKER> entry
    # points at the same OptionTradesHandler) so iterating over
    # handlers.items() would spawn duplicate drains on the same queue.
    seen_handlers: set[int] = set()
    for ch_name, handler in handlers.items():
        if id(handler) in seen_handlers:
            continue
        seen_handlers.add(id(handler))
        tasks.append(
            asyncio.create_task(handler.run(), name=f"handler:{handler.name}"),
        )
        log.info("started handler drain", extra={"handler": handler.name, "first_channel": ch_name})

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

    # Drain in-flight handler batches BEFORE cancelling tasks. Railway
    # sends SIGTERM on every deploy; without this, any rows still in
    # the per-channel queue or in the in-memory batch are silently lost
    # (~hundreds of tape rows per deploy). Drain is concurrent across
    # handlers and bounded by each handler's deadline.
    unique_handlers = list({id(h): h for h in handlers.values()}.values())
    drain_results = await asyncio.gather(
        *(h.drain() for h in unique_handlers),
        return_exceptions=True,
    )
    for handler, result in zip(unique_handlers, drain_results, strict=True):
        if isinstance(result, BaseException):
            log.error(
                "handler drain raised",
                extra={"handler": handler.name, "err": str(result)},
            )
        else:
            log.info(
                "handler drained",
                extra={"handler": handler.name, "rows_attempted": result},
            )

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
