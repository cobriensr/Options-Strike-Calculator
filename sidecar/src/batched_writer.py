"""Generic buffer + lock + batch-flush primitive for DB writers.

Both ``trade_processor`` and ``quote_processor`` previously implemented
the same shape by hand: a ``threading.Lock``-guarded ``list[T]`` buffer,
a size-triggered auto-flush, an explicit ``flush()`` method, and an
optional time-based background flush thread for low-volume sessions.
This module lifts that pattern into a reusable base.

**Key invariant — lock-then-release-before-IO.** The DB write
(``_write(rows)``) is performed OUTSIDE ``self._lock``. The buffer is
swapped for a fresh empty list under the lock, the lock is released,
and only then is ``_write`` called with the captured rows. Holding the
lock across a Neon round trip would serialize every Databento callback
behind a single network IO — untenable at TBBO volumes (dozens of
trades per second on active ES sessions).

The cost is a small bookkeeping shuffle: ``add()`` and ``flush()`` first
move the rows out under the lock, then call ``_write`` after release.
The benefit is bounded critical-section time independent of DB latency.

The time-based background flush is opt-in via
``start_background_flush(interval_s)`` — only ``trade_processor`` uses
it. ``quote_processor`` flushes purely on size + shutdown because TBBO
volume reliably reaches BATCH_SIZE in seconds.
"""

from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from typing import Generic, TypeVar

from logger_setup import log

T = TypeVar("T")


class BatchedWriter(ABC, Generic[T]):
    """Abstract base for buffered, batch-flushed DB writers.

    Subclasses override :meth:`_write` to send the captured rows to the
    database. The base class owns the buffer, the lock, the size-based
    auto-flush, and the optional time-based background flush thread.

    Args:
        batch_size: Auto-flush threshold. When the buffer reaches this
            size, ``add()`` will swap and write outside the lock.
        thread_name: Name applied to the background flush thread, if
            one is started. Aids debugging in thread dumps. Defaults
            to ``"batched-writer-flush"``.
    """

    def __init__(
        self,
        batch_size: int,
        *,
        thread_name: str = "batched-writer-flush",
    ) -> None:
        self._buffer: list[T] = []
        self._lock = threading.Lock()
        self._batch_size = batch_size
        self._thread_name = thread_name
        self._stop_event = threading.Event()
        self._flush_thread: threading.Thread | None = None
        self._flush_interval_s: float | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def add(self, item: T) -> None:
        """Append ``item`` to the buffer; auto-flush at ``batch_size``.

        Acquires the lock just long enough to append (and, if the
        threshold is reached, swap out the buffer for a fresh empty
        list). The DB write runs OUTSIDE the lock so high-frequency
        callers never serialize on a network round trip.
        """
        to_write: list[T] = []
        with self._lock:
            self._buffer.append(item)
            if len(self._buffer) >= self._batch_size:
                to_write = self._buffer
                self._buffer = []
        if to_write:
            self._write(to_write)

    def flush(self) -> None:
        """Force-flush the buffer.

        Same lock-swap-release-write pattern as :meth:`add`: the DB
        write happens after the lock has been released. Safe to call
        when the buffer is empty (no-op).
        """
        with self._lock:
            to_write = self._buffer
            self._buffer = []
        if to_write:
            self._write(to_write)

    def start_background_flush(self, interval_s: float) -> None:
        """Start a daemon thread that calls ``flush()`` every ``interval_s``.

        Idempotent — subsequent calls while a thread is alive are
        no-ops. The thread is a daemon so it exits when the main
        thread exits; call :meth:`stop` for deterministic shutdown.

        Only callers that need time-based flushing (e.g. low-volume
        weekend sessions where the buffer rarely hits ``batch_size``)
        should invoke this. High-volume callers can rely solely on
        size-based auto-flush + :meth:`flush` on shutdown.
        """
        if self._flush_thread is not None and self._flush_thread.is_alive():
            return
        self._flush_interval_s = interval_s
        self._stop_event.clear()
        self._flush_thread = threading.Thread(
            target=self._flush_loop,
            name=self._thread_name,
            daemon=True,
        )
        self._flush_thread.start()
        log.info(
            "%s background flush started (interval=%.1fs)",
            self.__class__.__name__,
            interval_s,
        )

    def stop(self) -> None:
        """Signal the background thread to exit and force a final flush.

        Safe to call even if :meth:`start_background_flush` was never
        invoked. Always performs a final ``self.flush()`` so callers
        get clean shutdown semantics without having to call ``flush()``
        separately.
        """
        self._stop_event.set()
        thread = self._flush_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
        self.flush()

    # ------------------------------------------------------------------
    # Subclass hook
    # ------------------------------------------------------------------

    @abstractmethod
    def _write(self, rows: list[T]) -> None:
        """Persist ``rows`` to the database.

        Called OUTSIDE ``self._lock`` with a non-empty list. Subclasses
        are responsible for their own error handling — exceptions raised
        here will propagate up to the caller of :meth:`add` /
        :meth:`flush`. The base class does not retry, does not
        re-buffer rows on failure, and does not capture exceptions to
        Sentry; subclasses that want any of those behaviors must
        implement them in ``_write``.
        """

    # ------------------------------------------------------------------
    # Internal: background flush loop
    # ------------------------------------------------------------------

    def _flush_loop(self) -> None:
        """Thread body: flush periodically until ``_stop_event`` is set."""
        assert self._flush_interval_s is not None  # set by start_background_flush
        while True:
            # Event.wait returns True when the event is set, False on
            # timeout. Flush only on timeout (steady-state tick); exit
            # cleanly on set (shutdown — stop() will perform the final
            # flush itself).
            if self._stop_event.wait(timeout=self._flush_interval_s):
                return
            try:
                self.flush()
            except Exception as exc:
                log.error("Background flush tick failed: %s", exc)
