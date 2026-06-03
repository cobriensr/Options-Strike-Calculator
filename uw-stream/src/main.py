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

import notify
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

    # UW caps channels at 50 PER CONNECTION, so the channel universe is sharded
    # across N WS connections (≤45 each). Every connector feeds the SAME
    # receive_queue → one router → shared handlers (the router dispatches by
    # channel name regardless of which socket delivered the frame), so this is
    # purely additive: handlers, router, and DB writes are unchanged. One
    # socket dropping reconnects only its shard; the others keep streaming.
    shards = settings.channel_shards
    connectors = [
        Connector(
            channels=shard,
            receive_queue=receive_queue,
            name=f"conn{i}",
        )
        for i, shard in enumerate(shards)
    ]
    log.info(
        "receive queue + shards configured",
        extra={
            "maxsize": receive_queue_size,
            "shard_count": len(connectors),
            "shard_sizes": [len(s) for s in shards],
        },
    )

    # Producers: every connector (WS receive) + the router (parse + dispatch).
    # These must stop FIRST on shutdown so no new payloads reach the
    # handler queues while their drain loops are emptying them.
    producer_tasks: list[asyncio.Task] = [
        asyncio.create_task(c.run(), name=f"connector:{c.name}") for c in connectors
    ]
    producer_tasks.append(
        asyncio.create_task(router.run(receive_queue), name="router"),
    )
    # Background services that aren't part of the data pipeline.
    background_tasks: list[asyncio.Task] = [
        asyncio.create_task(run_server(), name="health"),
    ]
    # Spawn one drain task per UNIQUE handler instance — many channels
    # can share one handler (e.g. every option_trades:<TICKER> entry
    # points at the same OptionTradesHandler) so iterating over
    # handlers.items() would spawn duplicate drains on the same queue.
    handler_tasks: list[asyncio.Task] = []
    seen_handlers: set[int] = set()
    for ch_name, handler in handlers.items():
        if id(handler) in seen_handlers:
            continue
        seen_handlers.add(id(handler))
        handler_tasks.append(
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
    done, _pending = await asyncio.wait(
        [*producer_tasks, *handler_tasks, *background_tasks, done_task],
        return_when=asyncio.FIRST_COMPLETED,
    )

    log.info("shutdown initiated", extra={"reason": _describe_done(done)})

    unique_handlers = list({id(h): h for h in handlers.values()}.values())
    await _shutdown(
        producer_tasks=producer_tasks,
        handlers=unique_handlers,
        other_tasks=[*handler_tasks, *background_tasks, done_task],
    )

    await close_pool()
    log.info("uw-stream stopped")


async def _shutdown(
    *,
    producer_tasks: list[asyncio.Task],
    handlers: list[Handler],
    other_tasks: list[asyncio.Task],
) -> None:
    """Graceful shutdown sequence — ORDER MATTERS.

    1. Cancel the producers (connector + router) first so no new payloads
       can reach a handler queue. Draining the consumers while the router
       is still alive races it: the router could ``enqueue`` a payload
       AFTER a handler's drain loop has already emptied its queue, and
       that row would be lost.
    2. Drain the consumer handlers against a now-static queue. Railway
       sends SIGTERM on every deploy; without the drain any rows still in
       the per-channel queue or in-memory batch are silently lost
       (~hundreds of tape rows per deploy). Concurrent across handlers,
       bounded by each handler's own deadline.
    3. Flush any in-flight fire-and-forget push notifications (the final
       drained batch's ``schedule_notify`` tasks) before the loop tears
       down, then close the shared HTTP session.
    4. Cancel the remaining background tasks (handler drain loops, health
       server, signal waiter). We don't await indefinitely — Railway
       SIGKILLs us after its grace window regardless.
    """
    # 1. Stop inflow.
    for t in producer_tasks:
        t.cancel()
    await asyncio.gather(*producer_tasks, return_exceptions=True)

    # 2. Drain consumers.
    drain_results = await asyncio.gather(
        *(h.drain() for h in handlers),
        return_exceptions=True,
    )
    for handler, result in zip(handlers, drain_results, strict=True):
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

    # 3. Flush in-flight push notifications, then close the HTTP session.
    await notify.drain_pending()
    await notify.close_session()

    # 4. Cancel everything still running.
    for t in other_tasks:
        t.cancel()
    await asyncio.gather(*other_tasks, return_exceptions=True)


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
