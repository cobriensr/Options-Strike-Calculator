"""Buffered writer for futures OHLCV-1m bars (AUD-M27).

OHLCV-1m bars arrive on the single Databento SDK callback thread. The
old path called ``db.upsert_futures_bar`` synchronously inside the
``_handle_ohlcv`` callback, so every
bar held that thread for a full Neon round trip (and, under
``_execute_with_retry``, a pool borrow + one reconnect retry — up to
~10s during a Neon stall). That head-of-line-blocked the SAME callback
thread that also drives TBBO and ES-options ingestion: a Neon blip on
the bar path stalled everything.

This writer routes bars through the shared :class:`BatchedWriter` so the
SDK thread only enqueues (a lock-guarded list append) and a background
thread drains the buffer to Neon. Bars are low-frequency (~7 symbols,
one bar/minute each), so size-based auto-flush would rarely fire — the
caller MUST start the time-based background flush (see ``main.py`` /
``DatabentoClient.start``) and call :meth:`BatchedWriter.stop` on
shutdown for a final drain.

**Idempotency.** ``futures_bars`` has ``ON CONFLICT (symbol, ts) DO
UPDATE`` (db.py ``upsert_futures_bar``) with high=GREATEST,
low=LEAST, volume=GREATEST merge semantics, so the BatchedWriter
bounded re-queue on a transient write failure cannot corrupt a bar:
re-applying the same upsert is a no-op on the merge columns. ``_write``
upserts row-by-row to preserve those exact per-bar merge semantics.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from batched_writer import BatchedWriter

# Bars trickle in (~7 symbols × 1/min). A small batch size keeps a final
# shutdown flush cheap; the background flush interval — not batch fill —
# is what actually drains the buffer in steady state.
BATCH_SIZE = 50
FLUSH_INTERVAL_S = 5.0


@dataclass
class BarRow:
    """A single parsed OHLCV-1m bar ready for ``upsert_futures_bar``."""

    symbol: str
    ts: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int


class BarWriter(BatchedWriter[BarRow]):
    """Accumulates OHLCV-1m bars and drains them to Neon off-thread.

    Inherits the buffer + lock + size-auto-flush + background-flush +
    bounded-re-queue machinery from :class:`BatchedWriter`. Only
    :meth:`_write` (the per-row idempotent upsert) is specific here.
    """

    def __init__(self, flush_interval_s: float = FLUSH_INTERVAL_S) -> None:
        super().__init__(batch_size=BATCH_SIZE, thread_name="bar-writer-flush")
        self._configured_flush_interval_s = flush_interval_s

    def _write(self, rows: list[BarRow]) -> None:
        """Upsert each buffered bar via the idempotent ``upsert_futures_bar``.

        Raises on a DB write failure: the base class
        (:meth:`BatchedWriter._write_or_requeue`) captures the exception
        to Sentry and re-queues the rows for the next flush. The
        ``futures_bars`` upsert is idempotent (ON CONFLICT DO UPDATE with
        GREATEST/LEAST merges), so the re-queue cannot duplicate or
        corrupt a bar. Do NOT catch here — that would defeat the retry.
        """
        from db import upsert_futures_bar

        for r in rows:
            upsert_futures_bar(
                r.symbol, r.ts, r.open, r.high, r.low, r.close, r.volume
            )

    def start_background_flush(  # type: ignore[override]
        self, interval_s: float | None = None
    ) -> None:
        """Start the periodic flush thread using the configured interval.

        Wraps :meth:`BatchedWriter.start_background_flush` so callers can
        use the no-arg shape ``writer.start_background_flush()`` and get
        the interval passed to ``__init__``. Bars rarely hit ``BATCH_SIZE``,
        so this time-based flush is the primary drain path.
        """
        super().start_background_flush(
            interval_s if interval_s is not None else self._configured_flush_interval_s
        )
