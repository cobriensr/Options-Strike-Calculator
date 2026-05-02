"""Process ES options Trades stream.

Parses incoming trade records and batches them for bulk insertion into
the `futures_options_trades` table. The data feeds downstream Vercel
crons (build-features, fetch-es-options-eod) and ML features — so the
ingestion pipeline is preserved here, even though it currently has no
live consumers of its own.

Historical note: this module previously also tracked in-memory rolling
strike volume, maintained a (never-populated) `_avg_volume` baseline,
and exposed `get_unusual_volume_strikes()` for a Twilio SMS alert in
`alert_engine`. That whole path was removed on 2026-04-08 alongside the
alert engine (see SIDE-001 in the audit). If you want unusual-volume
detection back, it belongs in a Vercel cron reading the DB table, not
in a long-running sidecar process.

The buffer + lock + batch-flush + DB-write machinery is inherited from
``batched_writer.BatchedWriter[TradeRecord]``. Only ``_write`` (DB
serialization) and ``process_trade`` (parse + ingest entry point) are
specific to this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal

from batched_writer import BatchedWriter
from db import batch_insert_options_trades
from logger_setup import log

# Trades are flushed (a) when the buffer reaches BATCH_SIZE, (b) by the
# background flush thread at ~FLUSH_INTERVAL_S cadence, and (c) on
# shutdown via TradeProcessor.stop(). The periodic flush was added after
# observing that weekend ATM trade volume could sit below BATCH_SIZE for
# hours, and any Railway restart before a batch-fill would lose the
# buffered trades entirely.
BATCH_SIZE = 100
FLUSH_INTERVAL_S = 10.0


@dataclass
class TradeRecord:
    """A single parsed trade ready for DB insertion."""

    underlying: str
    expiry: date
    strike: Decimal
    option_type: str  # 'C' or 'P'
    ts: datetime
    price: Decimal
    size: int
    side: str  # 'A', 'B', or 'N'
    trade_date: date


class TradeProcessor(BatchedWriter[TradeRecord]):
    """Accumulates ES options trades and batches DB writes.

    Inherits buffer + lock + batch-flush + background-flush thread from
    :class:`BatchedWriter`. The DB serialization (``_write``) flattens
    each :class:`TradeRecord` into the tuple shape expected by
    ``db.batch_insert_options_trades``.
    """

    def __init__(self, flush_interval_s: float = FLUSH_INTERVAL_S) -> None:
        super().__init__(batch_size=BATCH_SIZE, thread_name="trade-processor-flush")
        self._configured_flush_interval_s = flush_interval_s

    def process_trade(
        self,
        underlying: str,
        expiry: date,
        strike: float,
        option_type: str,
        ts_ns: int,
        price_raw: int,
        size: int,
        side_char: str,
    ) -> None:
        """Process a single trade from the Databento stream.

        Args:
            underlying: 'ES'
            expiry: Option expiration date
            strike: Strike price (already converted from 1e-9)
            option_type: 'C' or 'P'
            ts_ns: Timestamp in nanoseconds (ts_event from Databento)
            price_raw: Price in 1e-9 units (int64)
            size: Number of contracts
            side_char: 'A' (sell aggressor), 'B' (buy aggressor), 'N' (none)
        """
        # Convert Databento price (1e-9 units) to decimal
        price_decimal = Decimal(price_raw) / Decimal(1_000_000_000)

        # Convert nanosecond timestamp to datetime
        ts_dt = datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc)
        trade_dt = ts_dt.date()

        strike_decimal = Decimal(str(strike))

        record = TradeRecord(
            underlying=underlying,
            expiry=expiry,
            strike=strike_decimal,
            option_type=option_type,
            ts=ts_dt,
            price=price_decimal,
            size=size,
            side=side_char,
            trade_date=trade_dt,
        )

        # Buffer for batch insert. BatchedWriter.add() handles the
        # lock-swap-release-write pattern internally.
        self.add(record)

    # ------------------------------------------------------------------
    # BatchedWriter hooks
    # ------------------------------------------------------------------

    def _write(self, rows: list[TradeRecord]) -> None:
        """Materialize TradeRecord dataclasses into tuples and batch-insert.

        Errors are caught and logged here so a transient Neon hiccup
        doesn't tear down the Databento callback thread. The base class
        does NOT retry — buffered rows that hit a write failure are
        discarded.
        """
        tuples = [
            (
                r.underlying,
                r.expiry,
                r.strike,
                r.option_type,
                r.ts,
                r.price,
                r.size,
                r.side,
                r.trade_date,
            )
            for r in rows
        ]

        try:
            batch_insert_options_trades(tuples)
        except Exception as exc:
            log.error("Failed to batch insert trades: %s", exc)

    # ------------------------------------------------------------------
    # Convenience wrapper preserving the no-arg start_background_flush()
    # call signature used by main.py + tests.
    # ------------------------------------------------------------------

    def start_background_flush(  # type: ignore[override]
        self, interval_s: float | None = None
    ) -> None:
        """Start the periodic flush thread using the configured interval.

        Wraps :meth:`BatchedWriter.start_background_flush` to default
        ``interval_s`` to the value passed to ``__init__`` (so callers
        can use the no-arg call shape ``proc.start_background_flush()``
        that pre-dated the base class).
        """
        super().start_background_flush(
            interval_s if interval_s is not None else self._configured_flush_interval_s
        )
