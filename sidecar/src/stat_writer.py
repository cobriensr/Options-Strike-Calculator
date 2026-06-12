"""Buffered writer for ES option EOD statistics (AUD-M27).

Databento Statistics records (open interest, settlement, IV, delta)
arrive on the single SDK callback thread and used to call
``db.upsert_options_daily`` synchronously inside
``OptionsRecordRouter.handle_stat``. That upsert goes through
``_execute_with_retry`` (a pool borrow + one reconnect retry, up to
~10s during a Neon stall), so a stat burst during a Neon blip
head-of-line-blocked the SAME thread that drives TBBO + options-trade
ingestion.

This writer routes stats through the shared :class:`BatchedWriter`: the
SDK thread only enqueues, and a background thread drains to Neon. Stats
are bursty-but-low-frequency (one per strike per Statistics tick), so
the caller MUST start the time-based background flush and call
:meth:`BatchedWriter.stop` on shutdown for a final drain.

**Idempotency.** ``futures_options_daily`` has ``ON CONFLICT
(underlying, trade_date, expiry, strike, option_type) DO UPDATE`` with
``COALESCE(EXCLUDED.col, existing.col)`` merge semantics (db.py
``upsert_options_daily``), so the bounded re-queue on a transient write
failure cannot corrupt a row — re-applying the same upsert is a no-op.
``_write`` upserts row-by-row to preserve those per-strike merge
semantics (each row carries a different subset of stat kwargs).

**AUD-M26 failure tracking preserved.** Previously ``handle_stat``
caught upsert exceptions, counted them, and drove a throttled Sentry
summary. That counting is preserved via an optional
``on_write_failure`` callback the router wires to its counter — but the
exception is now ALSO re-raised so BatchedWriter re-queues the rows
(idempotent), an improvement over the old count-and-drop behavior.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any, Callable

from batched_writer import BatchedWriter

# Stats are bursty (a Statistics tick touches many strikes at once) but
# low-frequency overall. Background flush is the primary drain; the
# batch size only bounds a final shutdown flush.
BATCH_SIZE = 100
FLUSH_INTERVAL_S = 5.0


@dataclass
class StatRow:
    """A single parsed option-stat upsert payload.

    ``kwargs`` carries exactly the stat-specific keyword arguments the
    original ``upsert_options_daily(...)`` call passed (e.g.
    ``{"open_interest": 1234}`` plus an optional ``is_final`` for
    settlement), so the writer reproduces the original call verbatim.
    """

    underlying: str
    trade_date: date
    expiry: date
    strike: Decimal
    option_type: str
    kwargs: dict[str, Any]


class StatWriter(BatchedWriter[StatRow]):
    """Accumulates option stats and drains them to Neon off-thread.

    Inherits buffer + lock + auto-flush + background-flush + bounded
    re-queue from :class:`BatchedWriter`. ``_write`` upserts each row via
    the idempotent ``upsert_options_daily``; an optional
    ``on_write_failure`` callback preserves the AUD-M26 failure counter.
    """

    def __init__(
        self,
        *,
        on_write_failure: Callable[[BaseException], None] | None = None,
        flush_interval_s: float = FLUSH_INTERVAL_S,
    ) -> None:
        super().__init__(batch_size=BATCH_SIZE, thread_name="stat-writer-flush")
        self._on_write_failure = on_write_failure
        self._configured_flush_interval_s = flush_interval_s

    def _write(self, rows: list[StatRow]) -> None:
        """Upsert each buffered stat via the idempotent ``upsert_options_daily``.

        Raises on a DB write failure so the base class captures it to
        Sentry and re-queues the rows (idempotent table → safe). Before
        re-raising, ``on_write_failure`` is invoked once so the router's
        AUD-M26 counter + throttled summary still fire. Do NOT swallow —
        that would defeat the retry.
        """
        from db import upsert_options_daily

        try:
            for r in rows:
                upsert_options_daily(
                    r.underlying,
                    r.trade_date,
                    r.expiry,
                    r.strike,
                    r.option_type,
                    **r.kwargs,
                )
        except Exception as exc:
            if self._on_write_failure is not None:
                # Never let the failure-tracking callback mask the
                # original write error or block the base-class re-queue.
                try:
                    self._on_write_failure(exc)
                except Exception:  # noqa: BLE001
                    pass
            raise

    def start_background_flush(  # type: ignore[override]
        self, interval_s: float | None = None
    ) -> None:
        """Start the periodic flush thread using the configured interval."""
        super().start_background_flush(
            interval_s if interval_s is not None else self._configured_flush_interval_s
        )
