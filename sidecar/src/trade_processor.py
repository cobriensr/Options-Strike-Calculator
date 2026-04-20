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
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal

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


class TradeProcessor:
    """Accumulates ES options trades and batches DB writes."""

    def __init__(self, flush_interval_s: float = FLUSH_INTERVAL_S) -> None:
        self._buffer: list[TradeRecord] = []
        self._lock = threading.Lock()
        self._flush_interval_s = flush_interval_s
        self._stop_event = threading.Event()
        self._flush_thread: threading.Thread | None = None

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

        # Buffer for batch insert
        with self._lock:
            self._buffer.append(record)
            if len(self._buffer) >= BATCH_SIZE:
                self._flush_buffer()

    def _flush_buffer(self) -> None:
        """Flush buffered trades to the database."""
        if not self._buffer:
            return

        rows = [
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
            for r in self._buffer
        ]
        self._buffer.clear()

        try:
            batch_insert_options_trades(rows)
        except Exception as exc:
            log.error("Failed to batch insert trades: %s", exc)

    def flush(self) -> None:
        """Force flush any remaining buffered trades."""
        with self._lock:
            self._flush_buffer()

    def start_background_flush(self) -> None:
        """Start a daemon thread that flushes the buffer at a fixed cadence.

        Idempotent — subsequent calls while a thread is alive are no-ops.
        The daemon thread exits when the main thread exits; call stop()
        for deterministic shutdown.
        """
        if self._flush_thread is not None and self._flush_thread.is_alive():
            return
        self._stop_event.clear()
        self._flush_thread = threading.Thread(
            target=self._flush_loop,
            name="trade-processor-flush",
            daemon=True,
        )
        self._flush_thread.start()
        log.info(
            "TradeProcessor background flush started (interval=%.1fs)",
            self._flush_interval_s,
        )

    def _flush_loop(self) -> None:
        """Thread body: flush periodically until stop_event is set."""
        while True:
            # Event.wait returns True if the event was set, False on
            # timeout. We flush only on timeout (steady-state tick) and
            # exit cleanly on set (shutdown path — the explicit stop()
            # call will perform the final flush itself).
            if self._stop_event.wait(timeout=self._flush_interval_s):
                return
            try:
                self.flush()
            except Exception as exc:
                log.error("Background flush tick failed: %s", exc)

    def stop(self) -> None:
        """Signal the background thread to exit and force a final flush.

        Safe to call even if start_background_flush() was never invoked.
        Always performs a final self.flush() so callers get SIDE-006-style
        shutdown semantics without having to call flush() separately.
        """
        self._stop_event.set()
        thread = self._flush_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
        self.flush()
