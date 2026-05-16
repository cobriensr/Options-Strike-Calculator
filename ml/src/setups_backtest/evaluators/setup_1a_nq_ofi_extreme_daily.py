"""Setup 1a: ``nq-ofi-extreme-daily`` — daily-aggregate variant of Setup 1.

Same rule, same direction, same stop/target geometry, **only the threshold
interpretation changes**:

* Setup 1 uses p95 of EVERY-MINUTE trailing-1h |OFI| samples across the
  training window (training-window p95 ≈ 0.04 — fires ~1.7 signals/day).
* Setup 1a uses p95 of ONE |OFI| value per training day (the day's max
  trailing-1h |OFI|). This matches the daily-aggregate interpretation of
  the validated NQ-OFI work (ρ=0.31, p<0.001) in
  ``ml/src/features/microstructure.py``. Expected training-window p95 ≈
  0.3 — fires ~5 signals/month.

Same direction-from-sign / 30m-swing stop / VAH-or-2ATR target / MACRO-STRESS
disqualifier as Setup 1. Different signal density, expected higher per-trade
edge.
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

log = logging.getLogger("setups_backtest.setup_1a")


# Frozen thresholds (DO NOT TUNE).
OFI_WINDOW_MIN = 60
SWING_WINDOW_MIN = 30
ATR_WINDOW = 14
ATR_TARGET_MULTIPLE = 2.0
MACRO_STRESS_PCT = 2.0

# Walk-forward split per spec.
TRAIN_START = date(2025, 4, 20)
TRAIN_END = date(2025, 12, 31)


@dataclass
class _Setup1aContext:
    p95_threshold: float
    threshold_n_samples: int  # = number of training days that contributed
    cl_ohlcv: pd.DataFrame
    conn: Any
    tbbo_cache: dict[str, pd.DataFrame] = field(default_factory=dict)
    prior_profile_cache: dict[str, dict[str, float]] = field(default_factory=dict)


def _compute_daily_threshold(conn) -> tuple[float, int]:
    """p95 of one |OFI| value per training day.

    For each day in the training window:
      1. Load NQ TBBO minute aggregates for the day's RTH window.
      2. Compute rolling trailing-1h |OFI| over every RTH minute.
      3. Take the MAX of those readings for the day → one daily value.

    Then p95 of those daily-max values is the threshold.

    Returns (threshold, n_training_days_used).
    """
    days = data_loaders.list_trading_days(conn, TRAIN_START, TRAIN_END)
    log.info(
        "Setup 1a: computing daily-aggregate |OFI| p95 from %d training days...",
        len(days),
    )

    daily_maxes: list[float] = []
    for d in days:
        contract = data_loaders.pick_front_month(conn, "NQ", d)
        if contract is None:
            continue
        tbbo = data_loaders.load_tbbo_minute(conn, contract, d)
        if tbbo.empty or len(tbbo) < OFI_WINDOW_MIN:
            continue
        rth_mask = (
            (tbbo["minute"].dt.hour > 13)
            | ((tbbo["minute"].dt.hour == 13) & (tbbo["minute"].dt.minute >= 30))
        ) & (tbbo["minute"].dt.hour < 20)
        sub = tbbo.loc[rth_mask].sort_values("minute").reset_index(drop=True)
        if len(sub) < OFI_WINDOW_MIN:
            continue
        buy_60 = sub["buy_vol"].rolling(OFI_WINDOW_MIN, min_periods=OFI_WINDOW_MIN).sum()
        sell_60 = sub["sell_vol"].rolling(
            OFI_WINDOW_MIN, min_periods=OFI_WINDOW_MIN
        ).sum()
        denom = buy_60 + sell_60
        ofi = ((buy_60 - sell_60) / denom.where(denom > 0)).abs()
        clean = ofi.dropna()
        if clean.empty:
            continue
        daily_maxes.append(float(clean.max()))

    if not daily_maxes:
        log.warning("Setup 1a: no daily samples; threshold = NaN.")
        return float("nan"), 0

    p95 = float(np.percentile(np.array(daily_maxes), 95))
    log.info(
        "Setup 1a: daily-max |OFI| p95 = %.4f (n=%d training days)",
        p95,
        len(daily_maxes),
    )
    return p95, len(daily_maxes)


def _load_cl_bars(conn, pg, start: date, end: date) -> pd.DataFrame:
    """Same fallback chain as Setup 1: parquet → Neon → empty."""
    df = data_loaders.load_cross_asset_minute(conn, pg, "CL", start, end)
    if df.empty and pg is None:
        log.warning(
            "Setup 1a: CL bars unavailable; MACRO-STRESS disqualifier skipped."
        )
    return df


def _get_tbbo_for_day(
    ctx: _Setup1aContext, conn, contract: str, d: date
) -> pd.DataFrame:
    key = f"{contract}|{d.isoformat()}"
    if key not in ctx.tbbo_cache:
        ctx.tbbo_cache[key] = data_loaders.load_tbbo_minute(conn, contract, d)
    return ctx.tbbo_cache[key]


def _get_prior_profile(
    ctx: _Setup1aContext, conn, today: date
) -> dict[str, float]:
    key = today.isoformat()
    if key in ctx.prior_profile_cache:
        return ctx.prior_profile_cache[key]
    profile = data_loaders.prior_session_profile(conn, "NQ", today)
    ctx.prior_profile_cache[key] = profile
    return profile


@dataclass
class _NqOfiExtremeDailyEvaluator:
    name: str = "nq-ofi-extreme-daily"
    contract_prefix: str = "NQ"
    report_notes: str = (
        "**Daily-aggregate threshold variant of Setup 1.** Same rule, only "
        "the threshold derivation differs. Setup 1 uses p95 over every-minute "
        "|OFI| samples (loose, ~0.04). This variant uses p95 over one "
        "value per day — the day's MAX trailing-1h |OFI|.\n\n"
        "**Run-time observation: regime shift between train and test.** "
        "Training (2025-04-20 → 2025-12-31, 182 days) daily-max |OFI| "
        "distribution: median 0.045, p90 0.067, p95 0.0784, max 0.133. "
        "Test (2026-01-01 → 2026-04-17, 75 days) daily-max |OFI| "
        "distribution: median 0.049, p90 0.066, **MAX 0.0760** — the test "
        "window's single biggest daily |OFI| reading didn't even reach the "
        "training-window p95 threshold of 0.0784. So 0 signals fired.\n\n"
        "**What this means**: the threshold derived from training is too "
        "high for the test regime by ~0.003. Two interpretations:\n"
        "1. Regime shift — Q1 2026 was structurally quieter in OFI than "
        "2025. A daily-aggregate rule frozen from 2025 won't fire in this "
        "regime. The frozen-rule discipline is keeping us out of a "
        "potentially-overfit setup; this is a feature, not a bug.\n"
        "2. The threshold from training is at the very edge of normal — "
        "with only 75 test days, it's plausible we just missed by sampling "
        "luck. A longer test window would tell us.\n\n"
        "**Recommendation**: re-run on a wider test window (e.g., split "
        "the 400-day archive 60/40 instead of 75/25). Or accept that the "
        "daily-aggregate version is a 'rare extreme' setup that genuinely "
        "may not fire in a given quarter, and that's OK."
    )

    def prepare(self, conn, pg, start: date, end: date) -> _Setup1aContext:
        p95, n_days = _compute_daily_threshold(conn)
        cl_ohlcv = _load_cl_bars(conn, pg, start, end)
        return _Setup1aContext(
            p95_threshold=p95,
            threshold_n_samples=n_days,
            cl_ohlcv=cl_ohlcv,
            conn=conn,
        )

    def evaluate_minute(
        self,
        now: pd.Timestamp,
        ctx: _Setup1aContext,
        bars: pd.DataFrame,
    ) -> Signal | None:
        if len(bars) < OFI_WINDOW_MIN + 1:
            return None
        if not np.isfinite(ctx.p95_threshold):
            return None
        if "symbol" not in bars.columns or bars["symbol"].iloc[-1] is None:
            return None
        contract = str(bars["symbol"].iloc[-1])
        today = pd.Timestamp(now).date()

        tbbo = _get_tbbo_for_day(ctx, ctx.conn, contract, today)
        if tbbo.empty or len(tbbo) < OFI_WINDOW_MIN:
            return None

        ofi = features.ofi_window(tbbo, pd.Timestamp(now), OFI_WINDOW_MIN)
        if not np.isfinite(ofi):
            return None
        if abs(ofi) < ctx.p95_threshold:
            return None

        is_macro_stress = (
            features.macro_stress_30m(
                ctx.cl_ohlcv, pd.Timestamp(now), pct_threshold=MACRO_STRESS_PCT
            )
            if not ctx.cl_ohlcv.empty
            else False
        )
        if is_macro_stress:
            return None

        direction = Direction.LONG if ofi > 0 else Direction.SHORT
        sign = direction.sign

        swing_window = bars.iloc[-SWING_WINDOW_MIN:]
        if direction is Direction.LONG:
            stop_price = float(swing_window["low"].min())
        else:
            stop_price = float(swing_window["high"].max())

        atr_series = features.atr(bars, window=ATR_WINDOW)
        atr_val = (
            float(atr_series.iloc[-1])
            if not atr_series.empty and pd.notna(atr_series.iloc[-1])
            else float("nan")
        )

        last_close = float(bars.iloc[-1]["close"])

        if direction is Direction.LONG and stop_price >= last_close:
            return None
        if direction is Direction.SHORT and stop_price <= last_close:
            return None

        profile = _get_prior_profile(ctx, ctx.conn, today)
        target_atr = (
            last_close + sign * ATR_TARGET_MULTIPLE * atr_val
            if np.isfinite(atr_val)
            else float("nan")
        )
        target_profile = (
            profile.get("vah", float("nan"))
            if direction is Direction.LONG
            else profile.get("val", float("nan"))
        )
        candidates = [c for c in (target_atr, target_profile) if np.isfinite(c)]
        candidates = [
            c
            for c in candidates
            if (direction is Direction.LONG and c > last_close)
            or (direction is Direction.SHORT and c < last_close)
        ]
        if not candidates:
            return None
        target_price = min(candidates, key=lambda c: abs(c - last_close))

        return Signal(
            setup_name=self.name,
            decision_ts=pd.Timestamp(now),
            direction=direction,
            contract=contract,
            stop_price=stop_price,
            target_price=target_price,
            metadata={
                "ofi_1h": ofi,
                "threshold": ctx.p95_threshold,
                "atr_14": atr_val,
                "yest_vah": profile.get("vah", float("nan")),
                "yest_val": profile.get("val", float("nan")),
                "macro_stress_unavailable": ctx.cl_ohlcv.empty,
            },
        )


EVALUATOR = _NqOfiExtremeDailyEvaluator()
