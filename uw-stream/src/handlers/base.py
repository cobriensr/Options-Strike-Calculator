"""Abstract base for per-channel handlers.

Each handler owns:
- A bounded `asyncio.Queue` whose depth is exposed via `state.handlers`
  (keyed by handler name, NOT `state.channels` — a shared handler's name is
  its channel family, e.g. ``net_flow``, which is not a subscribable channel).
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
from db import single_attempt
from logger_setup import log
from sentry_setup import capture_exception, capture_message
from state import state

# Per-handler shutdown deadline. Railway SIGKILLs the old deploy
# ``drainingSeconds`` (40, in railway.toml) after SIGTERM. Before the drains,
# _shutdown releases the WS lease (up to main._LEASE_HTTP_TIMEOUT_S = 5 s);
# after them it flushes push notifications (up to 2 s). The handlers drain
# concurrently, so 5 + 30 + 2 = 37 s fits the window, and 30 s covers one
# full asyncpg ``command_timeout`` for the final flush.
# tests/test_handlers.py::test_drain_deadline_fits_railway_draining_seconds
# pins this arithmetic against railway.toml.
DRAIN_DEADLINE_S = 30.0

# Most rows one steady-state flush takes when the queue is backed up (see
# ``Handler._take_backlog``). Ten default batches: a tenth of the round trips
# when catching up after a slow flush. db.MAX_INSERT_PARAMS chunking keeps it
# legal: one transaction of 2-7 INSERTs at 5,000 rows (7 for flow-alerts'
# 41 columns, 3 for option_trades' 16).
BACKLOG_BATCH_MAX = 5_000

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
        # Register a zeroed counters row now so /metrics → handlers lists every
        # handler built at boot, not only those that have seen traffic. Bounded:
        # keyed by the closed set of handler names.
        state.handler(name)
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
        # Set when ``run()`` actually exits, so ``drain()`` can wait for the
        # consumer to release the queue and the batch before pulling the
        # remaining items itself.
        self._stopped: asyncio.Event = asyncio.Event()
        # Drain bookkeeping, read by ``drain()`` when its deadline hits so the
        # Sentry event names the stage and counts queued rows exactly:
        # ``_sentinel_queued`` is True while the wake-up sentinel sits in the
        # queue (it is not a row), and whoever dequeues it clears the flag.
        self._drain_stage: str = "idle"
        self._sentinel_queued: bool = False

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
                    state.handler(self.name).drop_count += 1
                except asyncio.QueueEmpty:
                    pass
                try:
                    self.queue.put_nowait(payload)
                except asyncio.QueueFull:
                    state.handler(self.name).drop_count += 1
            elif self._policy == "drop_newest":
                state.handler(self.name).drop_count += 1
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
                    state.handler(self.name).drop_count += 1
                    log.warning(
                        "block-policy put timed out, dropping payload",
                        extra={
                            "channel": self.name,
                            "timeout_s": BLOCK_PUT_TIMEOUT_S,
                        },
                    )
            else:
                # Defensive — pydantic validates this, but in case.
                state.handler(self.name).drop_count += 1
        finally:
            state.handler(self.name).queue_depth = self.queue.qsize()

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
                    payload = await asyncio.wait_for(self.queue.get(), timeout=timeout)
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
                    self._sentinel_queued = False
                    self.queue.task_done()
                    state.handler(self.name).queue_depth = self.queue.qsize()
                    break

                # Neither call raises: _add_row reports a bad payload and
                # _safe_flush reports a failed write, so the loop survives both.
                try:
                    self._add_row(payload)
                    if len(self._batch) >= self._batch_size:
                        self._take_backlog()
                        await self._safe_flush(self._batch)
                        self._batch = []
                        deadline = loop.time() + self._batch_interval
                finally:
                    self.queue.task_done()
                    state.handler(self.name).queue_depth = self.queue.qsize()
        finally:
            self._stopped.set()

    def _add_row(self, payload: dict, *, stage: str | None = None) -> None:
        """Transform one payload onto the batch; report a bad one, never raise."""
        try:
            row = self._transform(payload)
            if row is not None:
                self._batch.append(row)
        except Exception as exc:
            tags = {"component": "handler", "channel": self.name}
            if stage is not None:
                tags["stage"] = stage
            capture_exception(exc, tags=tags, context={"sample": str(payload)[:500]})

    def _take_backlog(self) -> None:
        """Top a full batch up from the queue, to at most BACKLOG_BATCH_MAX rows.

        A full batch with more payloads waiting means a backlog, usually built
        up during a slow flush. Writing it ``batch_size`` rows per round trip
        can fall further behind until the drop-oldest queue starts evicting,
        so take what is already queued (non-blocking) into this one flush.
        The bulk_insert_* helpers chunk it under the Postgres parameter limit.
        Pulls at most the remaining room, so skipped payloads can't extend it.
        """
        for _ in range(BACKLOG_BATCH_MAX - len(self._batch)):
            try:
                payload = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            try:
                if payload is _STOP_SENTINEL:
                    # drain() queued this; honor it as run() does: flush
                    # what we have, exit, and leave the rest for drain().
                    self._sentinel_queued = False
                    self._stopping = True
                    break
                self._add_row(payload)
            finally:
                self.queue.task_done()

    # ------------------------------------------------------------------
    # Shutdown — called from main on SIGTERM / SIGINT.
    # ------------------------------------------------------------------
    async def drain(self, deadline_s: float = DRAIN_DEADLINE_S) -> int:
        """Flush remaining queue + in-memory batch before shutdown.

        Steps:
          1. Signal ``run()`` to stop pulling from the queue.
          2. Wait for it to exit, including any flush it is in the middle
             of, so the two never write the same rows.
          3. Drain whatever is still in ``self.queue``.
          4. Append the drained items to the in-memory batch (after
             ``_transform``-ing them — same pipeline as the steady-state
             ``run()`` loop).
          5. Call ``_safe_flush`` once with everything we collected, as a
             single DB attempt with no transient retry.

        Capped at ``deadline_s`` total so the drain finishes inside
        Railway's SIGTERM-to-SIGKILL window (see ``DRAIN_DEADLINE_S``). If
        the deadline hits, the rows still in memory or in the queue are
        lost; that is logged and sent to Sentry with the counts.

        Returns the number of rows attempted to flush (``_safe_flush``
        swallows DB errors, so a non-zero return does NOT prove the rows
        landed in Postgres — see ``_safe_flush`` for the per-row
        write-count instrumentation).
        """
        try:
            return await asyncio.wait_for(self._drain_inner(), timeout=deadline_s)
        except TimeoutError:
            # Either run() is still inside a slow or stalled flush
            # ("consumer_busy"), or drain's own final flush is
            # ("final_flush"). Both leave self._batch holding the rows of
            # that flush. The wake-up sentinel is not a row.
            in_memory = len(self._batch)
            queued = self.queue.qsize() - (1 if self._sentinel_queued else 0)
            context = {
                "deadline_s": deadline_s,
                "in_memory_batch": in_memory,
                "queue_remaining": queued,
                "lost_rows": in_memory + queued,
            }
            log.warning(
                "drain deadline exceeded; unflushed rows lost",
                extra={"channel": self.name, "stage": self._drain_stage, **context},
            )
            capture_message(
                "uw-stream drain deadline hit; unflushed rows lost",
                level="warning",
                tags={"component": "handler", "channel": self.name, "stage": self._drain_stage},
                context=context,
            )
            return 0

    async def _drain_inner(self) -> int:
        """The body of drain(); separated so we can wrap it in wait_for."""
        # 1. Signal the consumer to exit. ``run()`` checks the flag
        #    between iterations and also short-circuits on the sentinel.
        self._stopping = True
        self._drain_stage = "consumer_busy"
        # 1a. Wake the consumer if it's parked in ``wait_for(queue.get())``
        #     — otherwise it would sleep up to ``_batch_interval`` (default
        #     2s) before noticing _stopping. ``put_nowait`` may raise
        #     QueueFull under sustained load; in that case the consumer
        #     will see ``_stopping`` after its next item lands or its
        #     batch-interval timeout expires, whichever comes first.
        with contextlib.suppress(asyncio.QueueFull):
            self.queue.put_nowait(_STOP_SENTINEL)  # type: ignore[arg-type]
            self._sentinel_queued = True
        # 2. Wait for the consumer to exit. It may be inside a flush on a
        #    slow or stalled Neon. Touching ``self._batch`` before it exits
        #    would race that flush: both paths could write the same rows,
        #    a duplicate on any table without ON CONFLICT DO NOTHING. So wait,
        #    bounded only by drain()'s deadline, which reports the rows if
        #    the consumer never finishes (or was never started).
        await self._stopped.wait()
        self._drain_stage = "final_flush"

        # 3. Drain remaining payloads from the queue and run them
        #    through the same _transform path as steady-state. Skip the
        #    sentinel (if present) — it's only there to wake ``run()``.
        while True:
            try:
                payload = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if payload is _STOP_SENTINEL:
                self._sentinel_queued = False
                self.queue.task_done()
                continue
            try:
                self._add_row(payload, stage="drain_transform")
            finally:
                self.queue.task_done()

        state.handler(self.name).queue_depth = self.queue.qsize()

        # 4 + 5. One final flush with the combined batch, as one DB attempt.
        #    A transient retry would add backoff plus another 30 s
        #    command_timeout, which only runs past the deadline.
        flushed = len(self._batch)
        if flushed:
            with single_attempt():
                await self._safe_flush(self._batch)
            self._batch = []
        return flushed

    async def _safe_flush(self, rows: list[tuple]) -> None:
        """Flush wrapped so a DB error never kills the drain loop.

        Honest write-count reporting (Phase 3 / M2): ``write_attempted``
        bumps by ``len(rows)`` regardless of outcome, so observers can
        compute a dedup or failure rate. ``write_count`` reflects what
        ``_flush`` returned — the rows the database actually accepted —
        when the subclass returns an int; otherwise it falls back to
        ``len(rows)`` so legacy subclasses without a return value are
        unaffected.
        """
        try:
            # Inside the try so a hypothetical state.handler() failure
            # is caught by the same except — preserves the "flush wrapped
            # so a DB error never kills the drain loop" contract even if
            # the metrics surface ever grows beyond pure dict access.
            state.handler(self.name).write_attempted += len(rows)
            inserted = await self._flush(rows)
            written = inserted if isinstance(inserted, int) else len(rows)
            state.handler(self.name).write_count += written
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
    async def _flush(self, rows: list[tuple]) -> int | None:
        """Persist a batch of row tuples.

        Subclasses SHOULD return the count of rows actually written (the
        upstream ``bulk_insert_*`` helpers return this from asyncpg's
        ``"INSERT 0 N"`` status string). Returning ``None`` is allowed
        for backwards compatibility with legacy in-test handlers —
        ``_safe_flush`` enforces the int-vs-fallback split via
        ``isinstance(inserted, int)`` so the production count stays
        honest regardless of subclass contract.
        """
