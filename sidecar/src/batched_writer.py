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

**Write-failure contract — bounded re-queue (NOT discard).** A DB write
that raises (e.g. a transient Neon SSL drop) does NOT lose its rows. The
base class catches the exception in ``add()`` / ``flush()``, captures it
to Sentry centrally, and re-prepends the failed rows to the FRONT of the
buffer so the next flush retries them. To bound memory under a
*persistent* outage, the buffer is capped at ``max_buffer_size``; on
overflow the OLDEST rows are trimmed and the drop count is reported
(``capture_message`` + ``log.warning``) — never silently. Subclass
``_write`` implementations therefore RAISE on failure and leave capture +
re-queue to the base class.
"""

from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from typing import Any, Generic, TypeVar

from logger_setup import log

T = TypeVar("T")


def _capture_exception(exc: BaseException, *, context: dict[str, Any]) -> None:
    """Forward a write failure to Sentry, guarded + lazy.

    Mirrors db.py's lazy-import pattern so unit tests that don't install
    ``sentry_sdk`` (or don't want Sentry wired) still import + run. A
    failure in the Sentry path must never mask the original write error
    or block the re-queue.
    """
    try:
        from sentry_setup import capture_exception

        capture_exception(exc, context=context, tags={"component": "batched_writer"})
    except Exception:  # noqa: BLE001
        log.error("batched_writer write failed: %s (context=%s)", exc, context)


def _capture_message(message: str, *, context: dict[str, Any]) -> None:
    """Forward a non-exception event (overflow drop) to Sentry, guarded."""
    try:
        from sentry_setup import capture_message

        capture_message(
            message,
            level="warning",
            context=context,
            tags={"component": "batched_writer"},
        )
    except Exception:  # noqa: BLE001
        log.warning("%s (context=%s)", message, context)


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
        max_buffer_size: Upper bound on buffered rows. On a persistent
            write failure the re-queue would grow without limit, so the
            OLDEST overflow is trimmed once the buffer exceeds this cap.
            Defaults to ``max(batch_size * 10, 1000)``.
    """

    def __init__(
        self,
        batch_size: int,
        *,
        thread_name: str = "batched-writer-flush",
        max_buffer_size: int | None = None,
    ) -> None:
        self._buffer: list[T] = []
        self._lock = threading.Lock()
        self._batch_size = batch_size
        self._max_buffer_size = (
            max_buffer_size
            if max_buffer_size is not None
            else max(batch_size * 10, 1000)
        )
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
            self._write_or_requeue(to_write)

    def flush(self) -> None:
        """Force-flush the buffer.

        Same lock-swap-release-write pattern as :meth:`add`: the DB
        write happens after the lock has been released. Safe to call
        when the buffer is empty (no-op). On write failure the rows are
        re-queued (see :meth:`_write_or_requeue`).
        """
        with self._lock:
            to_write = self._buffer
            self._buffer = []
        if to_write:
            self._write_or_requeue(to_write)

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
    # Internal: write with bounded re-queue on failure
    # ------------------------------------------------------------------

    def _write_or_requeue(self, to_write: list[T]) -> None:
        """Call :meth:`_write`; on failure, capture + bounded re-queue.

        Runs OUTSIDE ``self._lock`` (the caller already swapped the
        buffer). On a DB write failure:

        1. The exception is captured to Sentry centrally (so every
           subclass gets reporting without duplicating the call site).
        2. The failed rows are re-prepended to the FRONT of the buffer
           under the lock, so the next flush retries them in order
           ahead of any rows that arrived in the meantime.
        3. If the buffer now exceeds ``max_buffer_size`` (persistent
           outage), the OLDEST overflow is trimmed and the drop count
           is reported — never silently discarded.
        """
        # Bounded re-queue on failure — this catch is intentional, not a
        # swallow: the rows are captured + re-buffered, not discarded.
        try:
            self._write(to_write)
        except Exception as exc:  # noqa: BLE001
            _capture_exception(exc, context={"rows": len(to_write)})
            dropped = 0
            with self._lock:
                self._buffer = to_write + self._buffer
                overflow = len(self._buffer) - self._max_buffer_size
                if overflow > 0:
                    # Trim the OLDEST rows (front) — newest data is the
                    # most relevant to downstream consumers.
                    self._buffer = self._buffer[overflow:]
                    dropped = overflow
            if dropped:
                _capture_message(
                    "batched_writer buffer overflow — dropped oldest rows",
                    context={
                        "dropped": dropped,
                        "max_buffer_size": self._max_buffer_size,
                        "writer": self.__class__.__name__,
                    },
                )

    # ------------------------------------------------------------------
    # Subclass hook
    # ------------------------------------------------------------------

    @abstractmethod
    def _write(self, rows: list[T]) -> None:
        """Persist ``rows`` to the database.

        Called OUTSIDE ``self._lock`` with a non-empty list. Subclasses
        must RAISE on a DB write failure rather than swallowing it: the
        base class catches the exception in :meth:`_write_or_requeue`,
        captures it to Sentry centrally, and re-queues the failed rows
        (bounded by ``max_buffer_size``) for the next flush. Do NOT
        catch-and-log inside ``_write`` — that would defeat the retry.
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
