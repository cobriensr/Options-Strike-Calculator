"""Trade object + per-trade P&L, MAE, MFE, duration.

A Trade is the atomic unit of backtest output. The event loop appends one
Trade per entry/exit pair. Metrics aggregate over a list of Trades.

Design decisions:

- **Immutable after close.** A Trade is either `open` (entry recorded,
  exit not yet known) or `closed` (all fields populated). Open trades
  live only inside the event loop; emitted trade lists contain closed
  trades exclusively.

- **Price stored in underlying units (e.g. NQ points), P&L in USD.**
  Conversion uses `tick_value_dollars` from StrategyParams so the same
  code works for NQ ($5/pt), MNQ ($2/pt — but we run NQ data and scale
  at reporting time), ES, MES, etc.

- **MAE/MFE during the trade are computed from bar highs/lows between
  entry_ts and exit_ts.** The event loop passes the relevant slice to
  `close_trade()` which finalizes both extremes in one pass.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import pandas as pd

TradeStatus = Literal["open", "closed"]
TradeDirection = Literal["long", "short"]


@dataclass
class Trade:
    """A single backtest trade, from entry decision to exit fill."""

    # --- Required at entry ---
    entry_ts: pd.Timestamp
    entry_price: float
    direction: TradeDirection
    stop_price: float
    setup_tag: str  # e.g. "choch_plus_reversal", "bos_breakout"
    contracts: int

    # --- Populated at exit ---
    exit_ts: pd.Timestamp | None = None
    exit_price: float | None = None
    exit_reason: str | None = None  # e.g. "stop_hit", "target_hit", "opposite_choch"

    # --- Computed at exit ---
    mae_price: float | None = None  # worst price against the trade
    mfe_price: float | None = None  # best price in the trade's favor
    pnl_points: float | None = None
    pnl_dollars: float | None = None
    duration_minutes: int | None = None

    # --- Cost model inputs captured from StrategyParams ---
    tick_value_dollars: float = 0.50
    commission_per_rt: float = 1.90

    # --- Metadata ---
    status: TradeStatus = "open"

    # Snapshot of per-bar context features at the signal bar (the bar on
    # which the entry trigger fired, which is one bar before the actual
    # fill). Mirrors the columns the live trader reads at entry decision
    # time — session bucket, ATR/ADX, VWAP-relative position, OB strength,
    # event-day flags. Used for post-hoc cohort analysis (E1.4e) without
    # re-running the sweep.
    entry_features: dict[str, float | str | bool | None] = field(default_factory=dict)

    def close(
        self,
        *,
        exit_ts: pd.Timestamp,
        exit_price: float,
        exit_reason: str,
        bars_during_trade: pd.DataFrame,
    ) -> None:
        """Finalize the trade: compute P&L, MAE, MFE, duration.

        Parameters
        ----------
        exit_ts, exit_price, exit_reason:
            Fill-side fields from the exit decision.
        bars_during_trade:
            Bars strictly between entry_ts (exclusive) and exit_ts (inclusive).
            Must have columns `ts_event, high, low`. Used to compute MAE/MFE.
        """
        if self.status == "closed":
            raise ValueError(f"Trade already closed at {self.exit_ts}")

        self.exit_ts = exit_ts
        self.exit_price = exit_price
        self.exit_reason = exit_reason

        # MAE/MFE from intra-trade highs/lows
        # For a long trade: MAE is min(low), MFE is max(high)
        # For a short trade: MAE is max(high), MFE is min(low)
        if len(bars_during_trade) > 0:
            lo = float(bars_during_trade["low"].min())
            hi = float(bars_during_trade["high"].max())
        else:
            # Zero-bar trade (fill-at-same-bar) — use entry/exit as bounds
            lo = min(self.entry_price, exit_price)
            hi = max(self.entry_price, exit_price)

        if self.direction == "long":
            self.mae_price = lo
            self.mfe_price = hi
        else:  # short
            self.mae_price = hi
            self.mfe_price = lo

        # P&L in points (positive for winner regardless of direction)
        if self.direction == "long":
            self.pnl_points = exit_price - self.entry_price
        else:
            self.pnl_points = self.entry_price - exit_price

        # P&L in dollars: (points * tick_value * 4 ticks_per_point) * contracts − commissions
        # NQ futures: 1 point = 4 ticks @ $1.25 = $5. MNQ: 1 point = 4 ticks @ $0.125 = $0.50.
        # For MNQ: tick_value_dollars = 0.50 at tick_size=0.25 → 1 pt = 4 ticks = $2.
        # We store tick_value per 0.25 (quarter-point) following Databento convention.
        ticks_per_point = 4
        gross = self.pnl_points * self.tick_value_dollars * ticks_per_point * self.contracts
        self.pnl_dollars = gross - self.commission_per_rt * self.contracts

        # Duration
        delta = exit_ts - self.entry_ts
        self.duration_minutes = int(delta.total_seconds() / 60)

        self.status = "closed"

    def to_dict(self) -> dict:
        """Flatten to a dict for DataFrame conversion.

        Entry-feature snapshot is flattened into top-level columns prefixed
        with `ef_` so downstream `groupby` slices are direct.
        """
        out = {
            "entry_ts": self.entry_ts,
            "entry_price": self.entry_price,
            "direction": self.direction,
            "stop_price": self.stop_price,
            "setup_tag": self.setup_tag,
            "contracts": self.contracts,
            "exit_ts": self.exit_ts,
            "exit_price": self.exit_price,
            "exit_reason": self.exit_reason,
            "mae_price": self.mae_price,
            "mfe_price": self.mfe_price,
            "pnl_points": self.pnl_points,
            "pnl_dollars": self.pnl_dollars,
            "duration_minutes": self.duration_minutes,
            "status": self.status,
        }
        for k, v in self.entry_features.items():
            out[f"ef_{k}"] = v
        return out


def trades_to_dataframe(trades: list[Trade]) -> pd.DataFrame:
    """Convert a list of closed Trades to a flat DataFrame."""
    if not trades:
        return pd.DataFrame()
    rows = [t.to_dict() for t in trades]
    df = pd.DataFrame(rows)
    # Coerce timestamps back to UTC-aware (dataclass round-trip loses tz)
    for col in ("entry_ts", "exit_ts"):
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], utc=True)
    return df
