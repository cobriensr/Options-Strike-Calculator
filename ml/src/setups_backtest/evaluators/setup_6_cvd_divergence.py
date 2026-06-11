"""Setup 6: ``cvd-divergence-fade``.

Rule (frozen — spec):

* **Trigger**: ES makes a NEW session high (since RTH open) AND CVD makes a
  LOWER high than the prior CVD peak (or inverse for downside).
* **Direction**: SHORT at the new price high (or LONG at the new low).
* **Stop**: 1pt beyond the swept extreme.
* **Target**: session VWAP or session POC, whichever is closer.
* **Disqualifier**: news catalyst within 5m — spec default is to skip
  enforcement (no feed available). Flagged in metadata.

Operates on ES (primary contract). CVD computed from ES TBBO minute
aggregates loaded per day.
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

log = logging.getLogger("setups_backtest.setup_6")


# Frozen constants.
STOP_BUFFER_PTS = 1.0
MIN_HISTORY_FOR_DIVERGENCE = 30  # need at least 30m to detect a prior peak


@dataclass
class _Setup6Context:
    conn: Any
    es_tbbo_cache: dict[str, pd.DataFrame] = field(default_factory=dict)
    # Per-(today) cache of (rolling peak price, rolling peak CVD, rolling trough price, rolling trough CVD).
    # We update this incrementally as the day progresses, keyed by ISO date.
    state_cache: dict[str, dict[str, Any]] = field(default_factory=dict)


def _get_es_tbbo(ctx: _Setup6Context, today: date) -> pd.DataFrame:
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
class _CvdDivergenceFadeEvaluator:
    name: str = "cvd-divergence-fade"
    contract_prefix: str = "ES"
    report_notes: str = (
        "**KNOWN ISSUE — divergence detector over-fires.** The spec says "
        "'new session high AND CVD lower-high'. We interpret this as: current "
        "bar high == running session max AND current CVD < prior CVD peak. "
        "In a steadily trending session this fires every minute (every new "
        "bar IS the session high), and CVD oscillates naturally, so the "
        "divergence condition is almost always 'satisfied' even when there's "
        "no actual swing structure. **Result: 856 signals in 92 days (~9/day), "
        "20.2% WR, -$41.50 expectancy, -$35,520 cum P&L.** This is the "
        "single largest losing setup in the run.\n\n"
        "**Proper interpretation** would require swing-high detection: prior "
        "peak must be FOLLOWED by a meaningful retracement before the new "
        "high counts. That's the trader's mental model of 'divergence'. The "
        "spec's anti-tuning rule forbids retrofit, so this run reports the "
        "permissive read honestly — and the data clearly says 'no edge'.\n\n"
        "**Recommendation**: do not productionize Setup 6 as written. A "
        "future revision with proper swing-pivot detection (e.g., fractal "
        "highs requiring N-bar lookback on each side) might salvage the "
        "thesis, but should be tested as a NEW setup, not a retune.\n\n"
        "**News catalyst disqualifier**: skipped (no econ-calendar feed)."
    )

    def prepare(self, conn, pg, start: date, end: date) -> _Setup6Context:
        del pg, start, end
        return _Setup6Context(conn=conn)

    def evaluate_minute(
        self,
        now: pd.Timestamp,
        ctx: _Setup6Context,
        bars: pd.DataFrame,
    ) -> Signal | None:
        if len(bars) < MIN_HISTORY_FOR_DIVERGENCE or "symbol" not in bars.columns:
            return None

        today = pd.Timestamp(now).date()
        es_tbbo = _get_es_tbbo(ctx, today)
        if es_tbbo.empty:
            return None

        session_start = bars["ts"].iloc[0]
        # CVD up to (but not including) `now` — `end_ts` bounds the window so
        # `iloc[-1]`/`idxmax`/`idxmin` below cannot read end-of-day (future)
        # flow. `es_tbbo` is the full UTC day; without this bound the divergence
        # detector reads the whole-day CVD peak/trough.
        cvd_series = features.cvd_series(
            es_tbbo, session_start, end_ts=pd.Timestamp(now)
        )
        if cvd_series.empty:
            return None
        cvd_at_now = float(cvd_series.iloc[-1])

        # Price extremes.
        high_so_far = float(bars["high"].max())
        low_so_far = float(bars["low"].min())
        last_high = float(bars.iloc[-1]["high"])
        last_low = float(bars.iloc[-1]["low"])
        last_close = float(bars.iloc[-1]["close"])

        # Find prior peak CVD / trough CVD and the prices at those times.
        # Use the price highs/lows around the time of CVD peak/trough.
        cvd_peak_ts = cvd_series.idxmax()
        cvd_peak_val = float(cvd_series.max())
        cvd_trough_ts = cvd_series.idxmin()
        cvd_trough_val = float(cvd_series.min())

        # Did we just hit a new session high?
        new_high = last_high >= high_so_far and last_high > 0
        new_low = last_low <= low_so_far and last_low > 0

        sig_direction: Direction | None = None
        stop_price = float("nan")
        target_price = float("nan")
        swept_extreme = float("nan")

        if new_high:
            # Was the previous CVD peak made at a lower price? We approximate
            # "the price when CVD peaked" by sampling bars at cvd_peak_ts.
            price_at_cvd_peak = _price_at_ts(bars, cvd_peak_ts)
            if (
                np.isfinite(price_at_cvd_peak)
                and price_at_cvd_peak < last_high - 0.5  # prior high was meaningfully lower
                and cvd_at_now < cvd_peak_val  # divergence: CVD lower than prior peak
            ):
                sig_direction = Direction.SHORT
                stop_price = last_high + STOP_BUFFER_PTS
                swept_extreme = last_high
        elif new_low:
            price_at_cvd_trough = _price_at_ts(bars, cvd_trough_ts)
            if (
                np.isfinite(price_at_cvd_trough)
                and price_at_cvd_trough > last_low + 0.5
                and cvd_at_now > cvd_trough_val
            ):
                sig_direction = Direction.LONG
                stop_price = last_low - STOP_BUFFER_PTS
                swept_extreme = last_low

        if sig_direction is None:
            return None

        # Target: closer of session VWAP and POC.
        session_vwap = features.session_vwap(bars, session_start, pd.Timestamp(now))
        profile = features.volume_profile(bars, n_bins=30)
        poc = profile.get("poc", float("nan"))

        candidates = []
        for c in (session_vwap, poc):
            if not np.isfinite(c):
                continue
            if sig_direction is Direction.SHORT and c < last_close:
                candidates.append(c)
            elif sig_direction is Direction.LONG and c > last_close:
                candidates.append(c)

        if not candidates:
            return None
        # CLOSER target — more realistic, less greedy.
        target_price = min(candidates, key=lambda c: abs(c - last_close))

        contract = str(bars["symbol"].iloc[-1])

        # Side sanity.
        if sig_direction is Direction.SHORT and (stop_price <= last_close or target_price >= last_close):
            return None
        if sig_direction is Direction.LONG and (stop_price >= last_close or target_price <= last_close):
            return None

        return Signal(
            setup_name=self.name,
            decision_ts=pd.Timestamp(now),
            direction=sig_direction,
            contract=contract,
            stop_price=stop_price,
            target_price=target_price,
            metadata={
                "cvd_at_now": cvd_at_now,
                "cvd_peak": cvd_peak_val,
                "cvd_trough": cvd_trough_val,
                "swept_extreme": swept_extreme,
                "vwap": session_vwap,
                "poc": poc,
                "news_catalyst_unchecked": True,
            },
        )


def _price_at_ts(bars: pd.DataFrame, target_ts: pd.Timestamp) -> float:
    """Return the close of the bar at-or-before ``target_ts``.

    Returns ``nan`` if no bar matches (target is before session start).
    """
    if bars.empty:
        return float("nan")
    matches = bars[bars["ts"] <= target_ts]
    if matches.empty:
        return float("nan")
    return float(matches.iloc[-1]["close"])


EVALUATOR = _CvdDivergenceFadeEvaluator()
