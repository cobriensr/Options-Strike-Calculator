"""Setup 3: ``overnight-extreme-sweep``.

Rule (frozen — spec):

* **Trigger** (fires once per day, between minute 14 and 15 of RTH): The first
  15 minutes of RTH SWEPT either the ETH (overnight) session's high or low,
  AND price has reverted back INSIDE the ETH range by the end of minute 15.
* **Direction**: Fade — SHORT if upside sweep, LONG if downside sweep.
* **Stop**: 1pt past the swept extreme (ES tick = 0.25, NQ tick = 0.25, so
  "1pt" = 4 ticks).
* **Target**: Opposite side of ETH range.
* **Disqualifier**: econ-calendar event in the window. We don't have a
  calendar feed in this pass — flagged in metadata; not enforced.

Primary contract: ES. Cleanest test for the auction-failure pattern is on
the index futures.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

from .. import data_loaders, features
from ..harness import Direction, Signal

log = logging.getLogger("setups_backtest.setup_3")


# Frozen thresholds.
SWEEP_WINDOW_MIN = 15  # first 15min of RTH
STOP_BUFFER_POINTS = 1.0  # 1pt past the swept extreme


@dataclass
class _Setup3Context:
    conn: Any


@dataclass
class _OvernightSweepEvaluator:
    name: str = "overnight-extreme-sweep"
    contract_prefix: str = "ES"
    report_notes: str = (
        "**Fires at minute 15 of RTH only.** This setup is one-shot per day "
        "— we evaluate exactly when the first 15min RTH window closes. "
        "Before minute 15: not enough data. After minute 15: window closed, "
        "no re-fire.\n\n"
        "**Pattern**: classic auction-failure / liquidity-grab. ETH session "
        "(17:00 ET prior day → 09:30 ET) sets a range. First 15min of RTH "
        "sweeps one extreme (probably stop-running) then reverts inside the "
        "range. Reversion = failed auction → fade the sweep toward the "
        "opposite extreme.\n\n"
        "**Econ-calendar disqualifier skipped.** No calendar feed in this "
        "backtest. CPI/FOMC/payrolls days will fire just like any other; "
        "flagged in metadata so the comparative report can discuss noise."
    )

    def prepare(self, conn, pg, start: date, end: date) -> _Setup3Context:
        del pg, start, end
        return _Setup3Context(conn=conn)

    def evaluate_minute(
        self,
        now: pd.Timestamp,
        ctx: _Setup3Context,
        bars: pd.DataFrame,
    ) -> Signal | None:
        # Only evaluate at the close of minute 15 (i.e., when bars has exactly
        # 15 rows; next evaluation would be minute 16 = entry bar).
        if len(bars) != SWEEP_WINDOW_MIN:
            return None
        if "symbol" not in bars.columns:
            return None

        es_contract = str(bars["symbol"].iloc[-1])
        today = pd.Timestamp(now).date()

        # ETH session bounds (uses features.eth_session_bounds).
        eth_start, rth_open = features.eth_session_bounds(pd.Timestamp(today))
        # Load yesterday-evening through this morning's RTH-open via OHLCV.
        # We don't have a multi-day OHLCV loader for the same symbol because
        # ES contract may roll overnight, but in practice for an RTH-open
        # decision the active contract is stable across the ETH session.
        eth_bars = data_loaders.load_ohlcv_range(
            ctx.conn, [es_contract], (eth_start - pd.Timedelta(days=1)).date(), today
        )
        if eth_bars.empty:
            return None
        eth_bars = eth_bars[(eth_bars["ts"] >= eth_start) & (eth_bars["ts"] < rth_open)]
        if len(eth_bars) < 30:  # need at least 30 ETH minutes to define a range
            return None

        eth_high = float(eth_bars["high"].max())
        eth_low = float(eth_bars["low"].min())
        if not (np.isfinite(eth_high) and np.isfinite(eth_low)):
            return None

        # First-15min RTH bars are exactly `bars`.
        rth_high_so_far = float(bars["high"].max())
        rth_low_so_far = float(bars["low"].min())
        last_close = float(bars.iloc[-1]["close"])

        swept_high = rth_high_so_far > eth_high
        swept_low = rth_low_so_far < eth_low

        if not (swept_high or swept_low):
            return None
        if swept_high and swept_low:
            # Both extremes swept (rare wide range) — no clean direction; skip.
            return None

        # Reversion check: last close back inside the ETH range.
        if not (eth_low <= last_close <= eth_high):
            return None

        if swept_high:
            direction = Direction.SHORT
            stop_price = rth_high_so_far + STOP_BUFFER_POINTS
            target_price = eth_low
            swept_extreme = rth_high_so_far
            eth_extreme = eth_high
        else:  # swept_low
            direction = Direction.LONG
            stop_price = rth_low_so_far - STOP_BUFFER_POINTS
            target_price = eth_high
            swept_extreme = rth_low_so_far
            eth_extreme = eth_low

        # Sanity: stop and target on correct sides of last_close.
        if direction is Direction.LONG and (stop_price >= last_close or target_price <= last_close):
            return None
        if direction is Direction.SHORT and (stop_price <= last_close or target_price >= last_close):
            return None

        return Signal(
            setup_name=self.name,
            decision_ts=pd.Timestamp(now),
            direction=direction,
            contract=es_contract,
            stop_price=stop_price,
            target_price=target_price,
            metadata={
                "eth_high": eth_high,
                "eth_low": eth_low,
                "rth_15m_high": rth_high_so_far,
                "rth_15m_low": rth_low_so_far,
                "swept_extreme": swept_extreme,
                "eth_extreme_swept": eth_extreme,
                "econ_calendar_unchecked": True,
            },
        )


EVALUATOR = _OvernightSweepEvaluator()
