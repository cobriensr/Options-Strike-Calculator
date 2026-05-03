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
from abc import ABC, abstractmethod

from config import settings
from logger_setup import log
from sentry_setup import capture_exception
from state import state


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
                await self.queue.put(payload)
            else:
                # Defensive — pydantic validates this, but in case.
                state.channel(self.name).drop_count += 1
        finally:
            state.channel(self.name).queue_depth = self.queue.qsize()

    # ------------------------------------------------------------------
    # Consumer side — runs forever as a background task.
    # ------------------------------------------------------------------
    async def run(self) -> None:
        """Drain the queue, batch by size or time, flush."""
        batch: list[tuple] = []
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._batch_interval

        while True:
            timeout = max(0.0, deadline - loop.time())
            try:
                payload = await asyncio.wait_for(self.queue.get(), timeout=timeout)
            except TimeoutError:
                # Time-based flush: drain whatever we have even if small.
                if batch:
                    await self._safe_flush(batch)
                    batch = []
                deadline = loop.time() + self._batch_interval
                continue

            try:
                row = self._transform(payload)
                if row is not None:
                    batch.append(row)
                if len(batch) >= self._batch_size:
                    await self._safe_flush(batch)
                    batch = []
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
