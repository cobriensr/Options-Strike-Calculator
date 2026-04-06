"""Process ES options Trades stream.

Extracts aggressor side, aggregates rolling volume by strike,
and detects unusual volume activity for alerting.
"""

from __future__ import annotations

import threading
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal

from db import batch_insert_options_trades
from logger_setup import log

# Batch size for DB inserts -- accumulate trades and flush periodically
BATCH_SIZE = 100
FLUSH_INTERVAL_S = 5.0


@dataclass
class StrikeVolume:
    """Rolling volume tracker for a single strike."""

    buy_volume: int = 0  # side='B' (buy aggressor, lifting offers)
    sell_volume: int = 0  # side='A' (sell aggressor, hitting bids)
    none_volume: int = 0  # side='N' (crossed/block)

    @property
    def total_volume(self) -> int:
        return self.buy_volume + self.sell_volume + self.none_volume

    @property
    def buy_aggressor_pct(self) -> float:
        total = self.total_volume
        if total == 0:
            return 0.0
        return self.buy_volume / total

    @property
    def sell_aggressor_pct(self) -> float:
        total = self.total_volume
        if total == 0:
            return 0.0
        return self.sell_volume / total


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
    """Accumulates ES options trades, batches DB writes, tracks volume."""

    def __init__(self) -> None:
        self._buffer: list[TradeRecord] = []
        self._lock = threading.Lock()

        # Rolling volume by (strike, option_type) for the current window
        # Reset periodically or at session boundaries
        self._volume: dict[tuple[float, str], StrikeVolume] = defaultdict(StrikeVolume)
        self._volume_window_start: datetime = datetime.now(timezone.utc)

        # 20-day average volume by strike (loaded from DB on init)
        self._avg_volume: dict[tuple[float, str], float] = {}

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

        # Update rolling volume tracker
        key = (strike, option_type)
        vol = self._volume[key]
        if side_char == "B":
            vol.buy_volume += size
        elif side_char == "A":
            vol.sell_volume += size
        else:
            vol.none_volume += size

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

    def get_volume_snapshot(self) -> dict[tuple[float, str], StrikeVolume]:
        """Get current rolling volume by (strike, option_type)."""
        return dict(self._volume)

    def get_strike_volume(self, strike: float, option_type: str) -> StrikeVolume:
        """Get volume for a specific strike."""
        return self._volume.get((strike, option_type), StrikeVolume())

    def reset_volume_window(self) -> None:
        """Reset the rolling volume window (e.g., at session start)."""
        self._volume.clear()
        self._volume_window_start = datetime.now(timezone.utc)
        log.info("Volume window reset")

    def get_unusual_volume_strikes(self, threshold_multiple: float = 5.0) -> list[dict]:
        """Find strikes with volume exceeding threshold * average.

        Returns list of dicts with strike info and aggressor breakdown.
        """
        unusual = []
        for (strike, opt_type), vol in self._volume.items():
            avg = self._avg_volume.get((strike, opt_type), 0.0)
            if avg > 0 and vol.total_volume > avg * threshold_multiple:
                unusual.append(
                    {
                        "strike": strike,
                        "option_type": opt_type,
                        "volume": vol.total_volume,
                        "avg_volume": avg,
                        "multiple": vol.total_volume / avg,
                        "buy_aggressor_pct": vol.buy_aggressor_pct,
                        "sell_aggressor_pct": vol.sell_aggressor_pct,
                    }
                )
        return unusual
