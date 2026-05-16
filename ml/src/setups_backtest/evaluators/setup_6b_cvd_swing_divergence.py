"""Setup 6b: ``cvd-swing-divergence-fade`` — proper-pivot variant of Setup 6.

Setup 6 fired on every minute where current high == running session max AND
CVD < prior peak. In a trending session that's nearly every bar, so it produced
856 noise signals at -$35K cum P&L.

Setup 6b fixes the divergence detection with PROPER FRACTAL SWING-PIVOT
identification:

* **Trigger**: at the close of minute T, the most-recent confirmed swing high
  (fractal-3: high beats the 3 bars before and after) made a HIGHER price
  than the prior confirmed swing high, AND the CVD value at the new swing
  high is LOWER than CVD at the prior swing high. Inverse for swing-lows.
* **Confirmation lag**: a swing high at index i can only be confirmed at
  index i+3 (need 3 bars after to verify). So at decision time T, we look
  back at swings confirmed at-or-before T-3.
* **Minimum retracement gate**: between the prior swing high and the
  current one, price must have pulled back ≥ 5pts (ES). Otherwise it's just
  a stair-step trend, not divergence.
* **Direction**: SHORT on bearish swing-high divergence, LONG on bullish
  swing-low divergence.
* **Stop**: just past the current confirmed swing extreme.
* **Target**: session VWAP (the magnet for a true reversion).
* **Disqualifier**: news catalyst within 5m — same default as Setup 6
  (no feed wired; flagged in metadata).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

from .. import data_loaders, features
from ..harness import Direction, Signal

log = logging.getLogger("setups_backtest.setup_6b")


# Frozen parameters.
PIVOT_LOOKBACK = 3  # fractal pivot requires N bars before AND after
MIN_RETRACEMENT_PTS = 5.0  # ES points of pullback between prior and current swing
STOP_BUFFER_PTS = 1.0
MIN_HISTORY = 2 * PIVOT_LOOKBACK + 30  # need at least 2 pivots' worth of data


@dataclass
class _Setup6bContext:
    conn: Any
    es_tbbo_cache: dict[str, pd.DataFrame] = field(default_factory=dict)


def _get_es_tbbo(ctx: _Setup6bContext, today: date) -> pd.DataFrame:
    key = today.isoformat()
    if key not in ctx.es_tbbo_cache:
        if ctx.conn is None:
            ctx.es_tbbo_cache[key] = pd.DataFrame()
        else:
            contract = data_loaders.pick_front_month(ctx.conn, "ES", today)
            ctx.es_tbbo_cache[key] = (
                data_loaders.load_tbbo_minute(ctx.conn, contract, today)
                if contract
                else pd.DataFrame()
            )
    return ctx.es_tbbo_cache[key]


@dataclass
class _CvdSwingDivergenceFadeEvaluator:
    name: str = "cvd-swing-divergence-fade"
    contract_prefix: str = "ES"
    report_notes: str = (
        "**Setup 6 successor.** Setup 6 fired 856 times in 92 days because "
        "its 'new session high AND CVD < prior peak' check trivially passed "
        "in trending sessions. 6b replaces that with fractal-3 swing-pivot "
        "detection: a swing high needs the 3 bars before AND 3 bars after "
        "to all have lower highs. Plus a minimum retracement gate (≥5pts ES) "
        "between consecutive swings.\n\n"
        "**Confirmation lag**: a swing pivot at minute T can only be "
        "confirmed at T+3 (after the 3 confirming bars print). So the "
        "evaluator's most-recent confirmed swing is always at-or-before "
        "now-3. This is point-in-time safe by construction.\n\n"
        "**Target = session VWAP** (the natural mean-reversion magnet). "
        "Stop = 1pt past the current swing extreme.\n\n"
        "**News-catalyst disqualifier**: still skipped (no econ feed). "
        "Could share the econ_calendar.csv from Setup 3 — TODO."
    )

    def prepare(self, conn, pg, start: date, end: date) -> _Setup6bContext:
        del pg, start, end
        return _Setup6bContext(conn=conn)

    def evaluate_minute(
        self,
        now: pd.Timestamp,
        ctx: _Setup6bContext,
        bars: pd.DataFrame,
    ) -> Signal | None:
        if len(bars) < MIN_HISTORY or "symbol" not in bars.columns:
            return None

        today = pd.Timestamp(now).date()
        es_tbbo = _get_es_tbbo(ctx, today)
        if es_tbbo.empty:
            return None

        # Find all confirmed fractal pivots in `bars`.
        swing_highs, swing_lows = features.fractal_pivots(bars, lookback=PIVOT_LOOKBACK)

        # We need ≥2 confirmed swings of the same type to compare CVD.
        signal = _check_bearish_divergence(bars, es_tbbo, swing_highs)
        if signal is None:
            signal = _check_bullish_divergence(bars, es_tbbo, swing_lows)
        if signal is None:
            return None

        direction, current_pivot_idx, prior_pivot_idx, cvd_curr, cvd_prior = signal

        last_close = float(bars.iloc[-1]["close"])
        current_swing_price = (
            float(bars.iloc[current_pivot_idx]["high"])
            if direction is Direction.SHORT
            else float(bars.iloc[current_pivot_idx]["low"])
        )

        # Stop: 1pt past the current swing extreme.
        if direction is Direction.SHORT:
            stop_price = current_swing_price + STOP_BUFFER_PTS
        else:
            stop_price = current_swing_price - STOP_BUFFER_PTS

        # Target: session VWAP.
        session_start = bars["ts"].iloc[0]
        target_price = features.session_vwap(bars, session_start, pd.Timestamp(now))
        if not np.isfinite(target_price):
            return None

        # Side sanity.
        if direction is Direction.SHORT and (
            stop_price <= last_close or target_price >= last_close
        ):
            return None
        if direction is Direction.LONG and (
            stop_price >= last_close or target_price <= last_close
        ):
            return None

        contract = str(bars["symbol"].iloc[-1])
        return Signal(
            setup_name=self.name,
            decision_ts=pd.Timestamp(now),
            direction=direction,
            contract=contract,
            stop_price=stop_price,
            target_price=target_price,
            metadata={
                "current_pivot_ts": str(bars["ts"].iloc[current_pivot_idx]),
                "prior_pivot_ts": str(bars["ts"].iloc[prior_pivot_idx]),
                "current_pivot_price": current_swing_price,
                "cvd_at_current_pivot": cvd_curr,
                "cvd_at_prior_pivot": cvd_prior,
                "cvd_divergence": cvd_curr - cvd_prior,
                "news_catalyst_unchecked": True,
            },
        )


def _cvd_at_bar(es_tbbo: pd.DataFrame, session_start: pd.Timestamp, end_ts: pd.Timestamp) -> float:
    """Cumulative CVD from session_start through end_ts (exclusive)."""
    return features.cvd_session(es_tbbo, session_start, end_ts)


def _check_bearish_divergence(
    bars: pd.DataFrame,
    es_tbbo: pd.DataFrame,
    swing_highs: list[int],
) -> tuple[Direction, int, int, float, float] | None:
    """Look for: HIGHER price swing high AND LOWER CVD at that swing.

    Returns (direction, current_idx, prior_idx, cvd_curr, cvd_prior) or None.
    """
    if len(swing_highs) < 2:
        return None
    current_idx = swing_highs[-1]
    prior_idx = swing_highs[-2]

    current_high = float(bars.iloc[current_idx]["high"])
    prior_high = float(bars.iloc[prior_idx]["high"])
    # Need a higher high (otherwise no bearish divergence).
    if current_high <= prior_high:
        return None
    # Minimum retracement: between the two swings, price must have dipped at
    # least MIN_RETRACEMENT_PTS below the prior high.
    between = bars.iloc[prior_idx + 1 : current_idx]
    if between.empty:
        return None
    min_low_between = float(between["low"].min())
    if (prior_high - min_low_between) < MIN_RETRACEMENT_PTS:
        return None

    # CVD at each pivot — use the end of that minute.
    session_start = bars["ts"].iloc[0]
    cvd_prior = _cvd_at_bar(
        es_tbbo, session_start, bars["ts"].iloc[prior_idx] + pd.Timedelta(minutes=1)
    )
    cvd_curr = _cvd_at_bar(
        es_tbbo, session_start, bars["ts"].iloc[current_idx] + pd.Timedelta(minutes=1)
    )
    if not (np.isfinite(cvd_prior) and np.isfinite(cvd_curr)):
        return None
    # Bearish divergence: higher price high, lower CVD.
    if cvd_curr >= cvd_prior:
        return None
    return Direction.SHORT, current_idx, prior_idx, cvd_curr, cvd_prior


def _check_bullish_divergence(
    bars: pd.DataFrame,
    es_tbbo: pd.DataFrame,
    swing_lows: list[int],
) -> tuple[Direction, int, int, float, float] | None:
    """Look for: LOWER price swing low AND HIGHER CVD at that swing."""
    if len(swing_lows) < 2:
        return None
    current_idx = swing_lows[-1]
    prior_idx = swing_lows[-2]

    current_low = float(bars.iloc[current_idx]["low"])
    prior_low = float(bars.iloc[prior_idx]["low"])
    if current_low >= prior_low:
        return None
    between = bars.iloc[prior_idx + 1 : current_idx]
    if between.empty:
        return None
    max_high_between = float(between["high"].max())
    if (max_high_between - prior_low) < MIN_RETRACEMENT_PTS:
        return None

    session_start = bars["ts"].iloc[0]
    cvd_prior = _cvd_at_bar(
        es_tbbo, session_start, bars["ts"].iloc[prior_idx] + pd.Timedelta(minutes=1)
    )
    cvd_curr = _cvd_at_bar(
        es_tbbo, session_start, bars["ts"].iloc[current_idx] + pd.Timedelta(minutes=1)
    )
    if not (np.isfinite(cvd_prior) and np.isfinite(cvd_curr)):
        return None
    if cvd_curr <= cvd_prior:
        return None
    return Direction.LONG, current_idx, prior_idx, cvd_curr, cvd_prior


EVALUATOR = _CvdSwingDivergenceFadeEvaluator()
