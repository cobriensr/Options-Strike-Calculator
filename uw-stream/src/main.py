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
from uuid import uuid4

import aiohttp

import notify
from channel_registry import handler_class_for_channel
from config import settings
from connector import Connector
from db import close_pool, init_pool
from handlers.base import Handler
from health import run_server
from logger_setup import log
from router import Router
from sentry_setup import capture_exception, capture_message, init_sentry
from state import state
from subscription_watchdog import run_subscription_watchdog
from ws_lease import WsLease

# Total request budget for the lease's dedicated aiohttp session. Upstash
# REST round-trips are sub-100ms; 5s gives generous headroom for a slow
# acquire/renew without letting a wedged request hang the daemon. Mirrors
# notify.py's single-purpose ClientTimeout(total=…) style.
_LEASE_HTTP_TIMEOUT_S = 5.0

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

    # Acquire the WS connection lease BEFORE building any Connector, so a
    # booting deploy waits for the prior generation to release (or for its
    # TTL to lapse) before opening any UW socket — never exceeding UW's
    # 10-connection cap during the Railway handoff. The lease owns its own
    # aiohttp session (independent of notify's) so its lifetime is bound to
    # the lease, not the push path. ``lease``/``lease_session`` stay None
    # when the kill switch (WS_LEASE_ENABLED=false) is off.
    #
    # Everything after the lease is created lives inside the try so the
    # finally is GUARANTEED to release a held lease and close the session +
    # pool on ANY exit path — not just graceful shutdown. The two paths that
    # bypass _shutdown and would otherwise leak are: (1) lease.acquire()
    # *raising* (bad token / Upstash 5xx → WsLeaseError), and (2) a crash
    # AFTER a successful acquire but before/within the run loop, which would
    # leave the lease HELD in Upstash and block the next generation's boot
    # for the full TTL. On the normal path _shutdown already released the
    # lease and closed its session; release() no-ops once owns()==False and
    # the closes are guarded, so the finally is idempotent.
    lease: WsLease | None = None
    lease_session: aiohttp.ClientSession | None = None
    try:
        if settings.ws_lease_enabled:
            lease_session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=_LEASE_HTTP_TIMEOUT_S),
            )
            lease = WsLease(
                session=lease_session,
                base_url=settings.kv_rest_api_url,
                token=settings.kv_rest_api_token,
                key=settings.ws_lease_key,
                instance_id=uuid4().hex,
                ttl_ms=settings.ws_lease_ttl_ms,
                renew_ms=settings.ws_lease_renew_ms,
            )
            log.info(
                "acquiring ws connection lease",
                extra={
                    "key": settings.ws_lease_key,
                    "timeout_s": settings.ws_lease_acquire_timeout_s,
                },
            )
            acquired = await lease.acquire(settings.ws_lease_acquire_timeout_s)
            if not acquired:
                # A prior generation still holds the lease past our timeout
                # (likely a wedged old process). We do NOT force-steal —
                # stealing re-introduces the connection overlap the lease
                # exists to prevent. Exit non-zero so Railway restarts and
                # retries once the slot frees; SystemExit(1) propagates
                # through asyncio.run cleanly. The finally tears down the
                # session + pool (the lease was never acquired → no release).
                log.error(
                    "ws lease acquire timed out — refusing to open sockets; "
                    "exiting for Railway to restart + retry",
                    extra={
                        "key": settings.ws_lease_key,
                        "timeout_s": settings.ws_lease_acquire_timeout_s,
                    },
                )
                # SystemExit is a BaseException, so main()'s `except Exception`
                # never sees it — without this the acquire-timeout crash loop is
                # Sentry-silent (AUD-H2). Report explicitly before exiting.
                capture_message(
                    "uw-stream ws lease acquire timed out — exiting for restart",
                    level="error",
                    tags={"component": "main", "reason": "lease_acquire_timeout"},
                    context={
                        "key": settings.ws_lease_key,
                        "timeout_s": settings.ws_lease_acquire_timeout_s,
                    },
                )
                raise SystemExit(1)

        handlers = _build_handlers(settings.channels)
        router = Router(handlers)
        receive_queue_size = _receive_queue_size()
        receive_queue: asyncio.Queue = asyncio.Queue(maxsize=receive_queue_size)

        # UW caps channels at 50 PER CONNECTION, so the channel universe is
        # sharded across N WS connections (≤45 each). Every connector feeds the
        # SAME receive_queue → one router → shared handlers (the router
        # dispatches by channel name regardless of which socket delivered the
        # frame), so this is purely additive: handlers, router, and DB writes
        # are unchanged. One socket dropping reconnects only its shard; the
        # others keep streaming.
        shards = settings.channel_shards
        connectors = [
            Connector(
                channels=shard,
                receive_queue=receive_queue,
                name=f"conn{i}",
            )
            for i, shard in enumerate(shards)
        ]
        # Pre-register every shard as down so ws_connected ("all up") and
        # ws_any_connected are honest from boot — without this, the connections
        # dict is empty until the first shard connects, which would read
        # ws_connected=True off a single connected shard (false green).
        for c in connectors:
            state.set_connection(c.name, False)
        log.info(
            "receive queue + shards configured",
            extra={
                "maxsize": receive_queue_size,
                "shard_count": len(connectors),
                "shard_sizes": [len(s) for s in shards],
            },
        )

        # Producers: every connector (WS receive) + the router (parse +
        # dispatch). These must stop FIRST on shutdown so no new payloads
        # reach the handler queues while their drain loops are emptying them.
        producer_tasks: list[asyncio.Task] = [
            asyncio.create_task(c.run(), name=f"connector:{c.name}")
            for c in connectors
        ]
        producer_tasks.append(
            asyncio.create_task(router.run(receive_queue), name="router"),
        )
        # Background services that aren't part of the data pipeline.
        background_tasks: list[asyncio.Task] = [
            asyncio.create_task(run_server(), name="health"),
            asyncio.create_task(
                run_subscription_watchdog(), name="subscription_watchdog"
            ),
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
            log.info(
                "started handler drain",
                extra={"handler": handler.name, "first_channel": ch_name},
            )

        # Install signal handlers for clean Railway shutdown. SIGTERM is
        # what Railway sends on deploy / restart; SIGINT is for local Ctrl-C.
        #
        # ``lease_lost`` distinguishes the two shutdown triggers: a confirmed
        # lease loss (set below via on_lost) must exit NON-ZERO so Railway's
        # ON_FAILURE policy restarts the container and it re-acquires the lease;
        # a normal SIGTERM (deploy supersession) leaves ``lease_lost`` unset →
        # clean exit 0 (no restart loop on every deploy). Created before
        # ``stop`` so the on_lost callback can set both.
        lease_lost = asyncio.Event()
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            # add_signal_handler is unavailable on Windows; fine to skip
            # because this runs in macOS dev and Linux containers only.
            with contextlib.suppress(NotImplementedError):
                loop.add_signal_handler(sig, stop.set)

        # Renew the lease for the process lifetime. A confirmed loss of
        # ownership (CAS sees another gen's id, or Upstash is unreachable
        # across the full TTL) routes into the SAME graceful-shutdown path as
        # a SIGTERM — the daemon closes its sockets and drains — but ALSO marks
        # ``lease_lost`` so _run exits NON-ZERO afterward, letting Railway
        # restart it to re-acquire when the slot frees. Added after `stop` +
        # `lease_lost` exist so on_lost can set both.
        def _on_lease_lost() -> None:
            lease_lost.set()
            stop.set()

        if lease is not None:
            background_tasks.append(
                asyncio.create_task(
                    lease.run_renewal(on_lost=_on_lease_lost),
                    name="ws_lease_renewal",
                ),
            )

        # Wait for either a signal or any task to die unexpectedly.
        done_task = asyncio.create_task(stop.wait(), name="stop_wait")
        done, _pending = await asyncio.wait(
            [*producer_tasks, *handler_tasks, *background_tasks, done_task],
            return_when=asyncio.FIRST_COMPLETED,
        )

        # Detect unexpected task death. asyncio.wait(FIRST_COMPLETED) wakes on
        # the stop signal OR on any pipeline/background task finishing — and it
        # does NOT retrieve exceptions. Without this, an unhandled crash in the
        # router, a handler drain, the health server or the watchdog would flow
        # straight into graceful shutdown and exit 0; Railway's ON_FAILURE
        # policy then does NOT restart, so ingestion silently stops (the same
        # failure class as the 2026-06-09 lease incident, previously fixed only
        # for the renewal task — AUD-H1). Any non-stop task in `done` is
        # unexpected: these are meant to run until cancelled in _shutdown.
        crashed_tasks = [t for t in done if t is not done_task]
        for t in crashed_tasks:
            exc = t.exception()
            if exc is not None:
                capture_exception(
                    exc, tags={"component": "main", "task": t.get_name()}
                )

        log.info("shutdown initiated", extra={"reason": _describe_done(done)})

        unique_handlers = list({id(h): h for h in handlers.values()}.values())
        await _shutdown(
            producer_tasks=producer_tasks,
            handlers=unique_handlers,
            other_tasks=[*handler_tasks, *background_tasks, done_task],
            lease=lease,
            lease_session=lease_session,
        )
        log.info("uw-stream stopped")
        # A confirmed lease loss drained gracefully above; now exit non-zero so
        # Railway's ON_FAILURE restart policy relaunches the container (it will
        # re-acquire the lease once the slot frees). A normal SIGTERM leaves
        # ``lease_lost`` unset → falls through to a clean exit 0 (no restart
        # loop on deploys). The SystemExit propagates AFTER the finally below
        # runs its idempotent best-effort cleanup, which is correct.
        # Exit non-zero (→ Railway restart) on a confirmed lease loss OR any
        # unexpected task death, so neither silently stops ingestion at exit 0.
        if lease_lost.is_set() or crashed_tasks:
            raise SystemExit(1)
    finally:
        # Best-effort cleanup for ANY exit path that bypassed _shutdown
        # (acquire raised/timed out, or a mid-boot crash). Idempotent with the
        # normal _shutdown path: release() no-ops once owns()==False and the
        # session close is guarded. Releasing a still-HELD lease here is what
        # stops a mid-boot failure from blocking the next generation for a
        # full TTL. Suppress errors so cleanup never masks the real exception.
        if lease is not None:
            with contextlib.suppress(Exception):
                await lease.release()
        if lease_session is not None and not lease_session.closed:
            with contextlib.suppress(Exception):
                await lease_session.close()
        await close_pool()


async def _shutdown(
    *,
    producer_tasks: list[asyncio.Task],
    handlers: list[Handler],
    other_tasks: list[asyncio.Task],
    lease: WsLease | None = None,
    lease_session: aiohttp.ClientSession | None = None,
) -> None:
    """Graceful shutdown sequence — ORDER MATTERS.

    1. Cancel the producers (connector + router) first so no new payloads
       can reach a handler queue. Draining the consumers while the router
       is still alive races it: the router could ``enqueue`` a payload
       AFTER a handler's drain loop has already emptied its queue, and
       that row would be lost.
    1b. Release the WS connection lease (if active) — but ONLY after the
       producers are cancelled, i.e. our UW sockets are closed. Releasing
       earlier would let the next deploy generation acquire and connect
       while our sockets are still open, re-introducing the very overlap
       the lease prevents. Release is CAS-fenced + best-effort (never
       raises out of shutdown), then its dedicated aiohttp session closes.
    2. Drain the consumer handlers against a now-static queue. Railway
       sends SIGTERM on every deploy; without the drain any rows still in
       the per-channel queue or in-memory batch are silently lost
       (~hundreds of tape rows per deploy). Concurrent across handlers,
       bounded by each handler's own deadline.
    3. Flush any in-flight fire-and-forget push notifications (the final
       drained batch's ``schedule_notify`` tasks) before the loop tears
       down, then close the shared HTTP session.
    4. Cancel the remaining background tasks (handler drain loops, health
       server, signal waiter, lease renewal). We don't await indefinitely
       — Railway SIGKILLs us after its grace window regardless.
    """
    # 1. Stop inflow.
    for t in producer_tasks:
        t.cancel()
    await asyncio.gather(*producer_tasks, return_exceptions=True)

    # 1b. Release the lease now that our sockets are closed, then close the
    # lease's dedicated session. CAS-fenced so it can only delete OUR lease;
    # best-effort so it never raises out of the shutdown path.
    if lease is not None:
        await lease.release()
    if lease_session is not None and not lease_session.closed:
        await lease_session.close()

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
