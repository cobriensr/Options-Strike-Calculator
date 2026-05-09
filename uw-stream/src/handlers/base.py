"""Abstract base for per-channel handlers.

Each handler owns:
- A bounded `asyncio.Queue` whose depth is exposed via `state.channels`.
- A backpressure policy applied when the queue fills.
- A drain loop that batches and flushes on size OR time threshold.

Subclasses implement two hooks:

    _transform(self, payload: dict) -> tuple | None
        Convert the raw WS payload into a row tuple matching `self.columns`.
        Return None to skip this row (e.g. unparseable).

    async _flush(self, rows: list[tuple]) -> None
        Persist the batch. Subclasses typically call
        ``db.bulk_insert_ignore_conflict`` here.
"""

from __future__ import annotations

import asyncio
import contextlib
from abc import ABC, abstractmethod

from config import settings
from logger_setup import log
from sentry_setup import capture_exception, capture_message
from state import state

# Maximum time we'll wait when ``ws_backpressure_policy="block"`` and the
# per-channel queue is already full. Must be << the WS ping_timeout (20s)
# so the receive task never blocks long enough to look like a hung TCP.
# 50ms is short enough that a slow handler can't stall the whole pipeline,
# long enough that a transient burst doesn't trigger spurious drops.
BLOCK_PUT_TIMEOUT_S = 0.05

# Sentinel pushed into a handler's queue by ``drain()`` to wake the
# consumer when it's parked in ``wait_for(queue.get())``. The consumer
# checks for object identity (not equality) so any incoming dict from
# the wire can never accidentally match.
_STOP_SENTINEL: object = object()


class Handler(ABC):
    """Per-channel queue + drain loop."""

    name: str

    def __init__(self, name: str) -> None:
        self.name = name
        self.queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=settings.ws_queue_size)
        # Resolve once at construction so hot path is allocation-free.
        self._batch_size = settings.ws_batch_size
        self._batch_interval = settings.ws_batch_interval_ms / 1000.0
        self._policy = settings.ws_backpressure_policy
        # Promoted from a local in ``run()`` so ``drain()`` can grab any
        # in-flight rows that haven't crossed the size/time threshold yet.
        # Mutated only on the consumer task — no lock needed.
        self._batch: list[tuple] = []
        # Flipped to True by ``drain()`` so ``run()`` exits its next
        # iteration cleanly instead of being torn down mid-await with a
        # CancelledError that would discard the in-memory batch.
        self._stopping: bool = False
        # Set when ``run()`` actually exits, so ``drain()`` can wait a
        # short window for the consumer to release the queue before
        # pulling the remaining items itself.
        self._stopped: asyncio.Event = asyncio.Event()

    # ------------------------------------------------------------------
    # Producer side — called by the router on every payload.
    # ------------------------------------------------------------------
    async def enqueue(self, payload: dict) -> None:
        """Push a payload onto the queue.

        Non-blocking. Drops or blocks per the configured backpressure
        policy when the queue is full. Drop counter is exposed via
        /metrics so we can distinguish "we fell behind" from "the
        server stopped sending".
        """
        try:
            self.queue.put_nowait(payload)
        except asyncio.QueueFull:
            if self._policy == "drop_oldest":
                # Make room by evicting the oldest, then enqueue. The
                # eviction itself is a dropped payload — increment the
                # counter on the success path, not just the (essentially
                # impossible in single-threaded asyncio) double-fail path.
                try:
                    self.queue.get_nowait()
                    self.queue.task_done()
                    state.channel(self.name).drop_count += 1
                except asyncio.QueueEmpty:
                    pass
                try:
                    self.queue.put_nowait(payload)
                except asyncio.QueueFull:
                    state.channel(self.name).drop_count += 1
            elif self._policy == "drop_newest":
                state.channel(self.name).drop_count += 1
            elif self._policy == "block":
                # Bounded await so the WS receive task can never freeze
                # waiting on a slow handler. On timeout, drop the payload
                # and increment the same counter the drop_* policies use
                # so /metrics stays consistent across policies.
                try:
                    await asyncio.wait_for(
                        self.queue.put(payload),
                        timeout=BLOCK_PUT_TIMEOUT_S,
                    )
                except TimeoutError:
                    state.channel(self.name).drop_count += 1
                    log.warning(
                        "block-policy put timed out, dropping payload",
                        extra={
                            "channel": self.name,
                            "timeout_s": BLOCK_PUT_TIMEOUT_S,
                        },
                    )
            else:
                # Defensive — pydantic validates this, but in case.
                state.channel(self.name).drop_count += 1
        finally:
            state.channel(self.name).queue_depth = self.queue.qsize()

    # ------------------------------------------------------------------
    # Consumer side — runs forever as a background task.
    # ------------------------------------------------------------------
    async def run(self) -> None:
        """Drain the queue, batch by size or time, flush.

        Exits cleanly when ``self._stopping`` is set so ``drain()`` can
        take over the in-memory batch without racing the consumer.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._batch_interval
        self._stopped.clear()

        try:
            while not self._stopping:
                timeout = max(0.0, deadline - loop.time())
                try:
                    payload = await asyncio.wait_for(
                        self.queue.get(), timeout=timeout
                    )
                except TimeoutError:
                    # Time-based flush: drain whatever we have even if small.
                    if self._batch:
                        await self._safe_flush(self._batch)
                        self._batch = []
                    deadline = loop.time() + self._batch_interval
                    continue

                # ``drain()`` wakes us by pushing the sentinel. Honor it
                # immediately — leave any remaining queue items for
                # ``drain()`` to collect via get_nowait().
                if payload is _STOP_SENTINEL:
                    self.queue.task_done()
                    state.channel(self.name).queue_depth = self.queue.qsize()
                    break

                try:
                    row = self._transform(payload)
                    if row is not None:
                        self._batch.append(row)
                    if len(self._batch) >= self._batch_size:
                        await self._safe_flush(self._batch)
                        self._batch = []
                        deadline = loop.time() + self._batch_interval
                except Exception as exc:
                    capture_exception(
                        exc,
                        tags={"component": "handler", "channel": self.name},
                        context={"sample": str(payload)[:500]},
                    )
                finally:
                    self.queue.task_done()
                    state.channel(self.name).queue_depth = self.queue.qsize()
        finally:
            self._stopped.set()

    # ------------------------------------------------------------------
    # Shutdown — called from main on SIGTERM / SIGINT.
    # ------------------------------------------------------------------
    async def drain(self, deadline_s: float = 5.0) -> int:
        """Flush remaining queue + in-memory batch before shutdown.

        Steps:
          1. Signal ``run()`` to stop pulling from the queue.
          2. Wait briefly for it to release the queue (best-effort).
          3. Drain whatever is still in ``self.queue``.
          4. Append the drained items to the in-memory batch (after
             ``_transform``-ing them — same pipeline as the steady-state
             ``run()`` loop).
          5. Call ``_safe_flush`` once with everything we collected.

        Capped at ``deadline_s`` total so we always make Railway's
        graceful-shutdown window even if the DB is slow.

        Returns the number of rows attempted to flush (``_safe_flush``
        swallows DB errors, so a non-zero return does NOT prove the rows
        landed in Postgres — see ``_safe_flush`` for the per-row
        write-count instrumentation).
        """
        try:
            return await asyncio.wait_for(
                self._drain_inner(), timeout=deadline_s
            )
        except TimeoutError:
            log.warning(
                "drain deadline exceeded; some rows may be lost",
                extra={
                    "channel": self.name,
                    "deadline_s": deadline_s,
                    "in_memory_batch": len(self._batch),
                    "queue_remaining": self.queue.qsize(),
                },
            )
            return 0

    async def _drain_inner(self) -> int:
        """The body of drain(); separated so we can wrap it in wait_for."""
        # 1. Signal the consumer to exit. ``run()`` checks the flag
        #    between iterations and also short-circuits on the sentinel.
        self._stopping = True
        # 1a. Wake the consumer if it's parked in ``wait_for(queue.get())``
        #     — otherwise it would sleep up to ``_batch_interval`` (default
        #     2s) before noticing _stopping. ``put_nowait`` may raise
        #     QueueFull under sustained load; in that case the consumer
        #     will see ``_stopping`` after its next item lands or its
        #     batch-interval timeout expires, whichever comes first.
        with contextlib.suppress(asyncio.QueueFull):
            self.queue.put_nowait(_STOP_SENTINEL)  # type: ignore[arg-type]
        # 2. Best-effort wait for the consumer to release the queue.
        #    If ``run()`` was never started (e.g. the handler was built
        #    but no task spawned), ``_stopped`` will never fire — short
        #    timeout keeps the drain making forward progress regardless.
        try:
            await asyncio.wait_for(self._stopped.wait(), timeout=1.0)
        except TimeoutError:
            # Race-safety guard: if ``run()`` is still alive (most likely
            # parked inside ``await self._safe_flush(...)`` because the DB
            # is slow on shutdown), proceeding to step 3 would mutate
            # ``self._batch`` while ``run()`` still holds a reference to
            # it — both code paths could then call ``_safe_flush`` with
            # overlapping rows, producing duplicate inserts on any table
            # that lacks ON CONFLICT DO NOTHING. Bail out and accept that
            # those rows are stuck inside ``run()``'s in-flight flush;
            # they'll either land normally or be dropped — but never
            # double-written.
            if not self._stopped.is_set():
                log.warning(
                    "drain: consumer still running after grace window — "
                    "aborting to avoid double-flush race",
                    extra={
                        "channel": self.name,
                        "in_memory_batch": len(self._batch),
                        "queue_remaining": self.queue.qsize(),
                    },
                )
                capture_message(
                    "uw-stream drain aborted: consumer still running",
                    level="warning",
                    tags={"component": "handler", "channel": self.name},
                    context={
                        "in_memory_batch": len(self._batch),
                        "queue_remaining": self.queue.qsize(),
                    },
                )
                return 0

        # 3. Drain remaining payloads from the queue and run them
        #    through the same _transform path as steady-state. Skip the
        #    sentinel (if present) — it's only there to wake ``run()``.
        while True:
            try:
                payload = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if payload is _STOP_SENTINEL:
                self.queue.task_done()
                continue
            try:
                row = self._transform(payload)
                if row is not None:
                    self._batch.append(row)
            except Exception as exc:
                capture_exception(
                    exc,
                    tags={
                        "component": "handler",
                        "channel": self.name,
                        "stage": "drain_transform",
                    },
                    context={"sample": str(payload)[:500]},
                )
            finally:
                self.queue.task_done()

        state.channel(self.name).queue_depth = self.queue.qsize()

        # 4 + 5. One final flush with the combined batch.
        flushed = len(self._batch)
        if flushed:
            await self._safe_flush(self._batch)
            self._batch = []
        return flushed

    async def _safe_flush(self, rows: list[tuple]) -> None:
        """Flush wrapped so a DB error never kills the drain loop."""
        try:
            await self._flush(rows)
            state.channel(self.name).write_count += len(rows)
        except Exception as exc:
            capture_exception(
                exc,
                tags={"component": "handler", "channel": self.name, "stage": "flush"},
                context={"batch_size": len(rows)},
            )
            log.error(
                "flush failed",
                extra={"channel": self.name, "batch_size": len(rows), "err": str(exc)},
            )

    # ------------------------------------------------------------------
    # Subclass hooks.
    # ------------------------------------------------------------------
    @abstractmethod
    def _transform(self, payload: dict) -> tuple | None:
        """Map a WS payload to a row tuple. Return None to skip."""

    @abstractmethod
    async def _flush(self, rows: list[tuple]) -> None:
        """Persist a batch of row tuples."""
