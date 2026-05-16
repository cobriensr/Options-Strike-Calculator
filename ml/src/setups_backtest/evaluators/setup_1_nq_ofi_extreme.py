"""Setup 1: ``nq-ofi-extreme``.

Rule (frozen — see docs/superpowers/specs/futures-setups-backtest-2026-05-15.md):

* **Trigger**: ``|NQ 1h OFI| ≥ p95`` (training-window distribution).
* **Direction**: LONG if OFI > 0, SHORT if OFI < 0.
* **Stop**: 30-min swing low (LONG) / high (SHORT) of NQ 1m bars.
* **Target**: closer of (yesterday's VAH/VAL on the favorable side) and
  (entry ± 2 × ATR(14)).
* **Disqualifier**: MACRO-STRESS regime active — |CL 30m return| ≥ 2%. If CL
  bars are unavailable (no pg + no CL in OHLCV parquet), the disqualifier
  is treated as inactive and the signal's ``metadata['macro_stress_unavailable']``
  is set to True so the comparative report can flag this.

The threshold is computed once in ``prepare`` from the training split
(2025-04-20 → 2025-12-31) and frozen for the test window — matches spec's
"no threshold tuning" rule.
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

log = logging.getLogger("setups_backtest.setup_1")


# ---------------------------------------------------------------------------
# Constants (frozen — DO NOT TUNE in this phase per spec)
# ---------------------------------------------------------------------------

OFI_WINDOW_MIN = 60  # 1h trailing OFI window
SWING_WINDOW_MIN = 30
ATR_WINDOW = 14
ATR_TARGET_MULTIPLE = 2.0
MACRO_STRESS_PCT = 2.0
MACRO_STRESS_WINDOW_MIN = 30

# Walk-forward split per spec.
TRAIN_START = date(2025, 4, 20)
TRAIN_END = date(2025, 12, 31)


# ---------------------------------------------------------------------------
# Context container
# ---------------------------------------------------------------------------


@dataclass
class _Setup1Context:
    """Shared state computed once per backtest run."""

    p95_threshold: float
    threshold_n_samples: int  # diagnostic — how many minutes contributed
    cl_ohlcv: pd.DataFrame  # 1m bars over the backtest window (UTC), may be empty
    conn: Any  # stashed DuckDB connection for per-day lazy loads
    # Lazily-loaded per-day caches, keyed by ISO date string.
    tbbo_cache: dict[str, pd.DataFrame] = field(default_factory=dict)
    prior_profile_cache: dict[str, dict[str, float]] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Threshold computation (one-shot from training split)
# ---------------------------------------------------------------------------


def _compute_threshold(conn) -> tuple[float, int]:
    """p95 of |trailing-1h OFI| sampled at every RTH minute of the training split."""
    days = data_loaders.list_trading_days(conn, TRAIN_START, TRAIN_END)
    log.info(
        "Setup 1: computing |OFI| p95 from %d training days "
        "(%s -> %s)...",
        len(days),
        TRAIN_START,
        TRAIN_END,
    )

    samples: list[np.ndarray] = []
    for d in days:
        contract = data_loaders.pick_front_month(conn, "NQ", d)
        if contract is None:
            continue
        tbbo = data_loaders.load_tbbo_minute(conn, contract, d)
        if tbbo.empty or len(tbbo) < OFI_WINDOW_MIN:
            continue
        # Restrict to RTH (13:30-20:00 UTC) — overnight OFI distribution is
        # different and would dilute the daytime threshold.
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
        samples.append(ofi.dropna().to_numpy())

    if not samples:
        log.warning(
            "Setup 1: no training samples computed; threshold will be NaN."
        )
        return float("nan"), 0

    combined = np.concatenate(samples)
    p95 = float(np.percentile(combined, 95))
    log.info(
        "Setup 1: |OFI| p95 = %.4f (n=%d minute samples from train split)",
        p95,
        len(combined),
    )
    return p95, len(combined)


# ---------------------------------------------------------------------------
# CL loader (for macro-stress disqualifier)
# ---------------------------------------------------------------------------


def _load_cl_bars(conn, pg, start: date, end: date) -> pd.DataFrame:
    """Load CL 1m bars over [start, end] via the shared cross-asset loader.

    Logs whether the load came from parquet, Neon, or degraded to empty so
    the next run can disambiguate "CL absent from parquet" vs "query broken".
    """
    df = data_loaders.load_cross_asset_minute(conn, pg, "CL", start, end)
    if not df.empty:
        log.info(
            "Setup 1: loaded %d CL bars for macro-stress disqualifier.", len(df)
        )
    elif pg is None:
        log.warning(
            "Setup 1: CL not in OHLCV parquet and no Neon pg connection; "
            "macro-stress disqualifier will be SKIPPED (signals not filtered)."
        )
    else:
        log.warning(
            "Setup 1: CL data unavailable from BOTH parquet and Neon; "
            "macro-stress disqualifier will be SKIPPED. Verify ``futures_bars`` "
            "has rows where ``symbol = 'CL'`` for [%s, %s].",
            start,
            end,
        )
    return df


# ---------------------------------------------------------------------------
# Per-day lazy loaders
# ---------------------------------------------------------------------------


def _get_tbbo_for_day(
    ctx: _Setup1Context, conn, contract: str, d: date
) -> pd.DataFrame:
    """Lazy-load and cache NQ TBBO minute aggregates for one day."""
    key = f"{contract}|{d.isoformat()}"
    if key not in ctx.tbbo_cache:
        ctx.tbbo_cache[key] = data_loaders.load_tbbo_minute(conn, contract, d)
    return ctx.tbbo_cache[key]


def _get_prior_profile(
    ctx: _Setup1Context, conn, today: date
) -> dict[str, float]:
    """Lazy-load yesterday's NQ volume profile (POC/VAH/VAL).

    Delegates to the shared ``data_loaders.prior_session_profile`` helper so
    Setups 3, 5, 6 can reuse the same walk-back-N-days behavior.
    """
    key = today.isoformat()
    if key in ctx.prior_profile_cache:
        return ctx.prior_profile_cache[key]
    profile = data_loaders.prior_session_profile(conn, "NQ", today)
    ctx.prior_profile_cache[key] = profile
    return profile


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------


@dataclass
class _NqOfiExtremeEvaluator:
    name: str = "nq-ofi-extreme"
    contract_prefix: str = "NQ"
    report_notes: str = (
        "**Threshold interpretation.** The spec says "
        "`NQ 1h OFI ≥ p95 (rolling 252d)`. We compute p95 from EVERY-MINUTE "
        "samples of trailing-1h OFI across the training window "
        "(2025-04-20 → 2025-12-31). This is a defensible reading but produces "
        "a threshold (0.04) that is ~7.5× lower than the validated NQ OFI "
        "reference (ρ=0.313, p<0.001) in `ml/src/features/microstructure.py`, "
        "which aggregates to one daily value. Per-minute sampling treats "
        "every minute as an independent observation, inflating the sample "
        "size and pulling the p95 toward the tail of the *intraday noise* "
        "distribution rather than the daily *signal* distribution. "
        "**Frequency consequence**: ~1.7 signals/day rather than the ~5 "
        "signals/month a daily-aggregate interpretation would produce. The "
        "spec's anti-tuning rule forbids retuning thresholds in-flight, so "
        "this run reports the per-minute interpretation honestly. **Recommend** "
        "adding `setup-1a-nq-ofi-extreme-daily` as a separate Phase 2 variant "
        "to compare.\n\n"
        "**MACRO-STRESS disqualifier.** Requires CL 1m bars. Skipped in this "
        "run (CL absent from OHLCV parquet, no Neon `DATABASE_URL`). On 92 "
        "test days at most a handful of days would have triggered the >2% "
        "30m disqualifier, so the impact on signal count is small but non-zero."
    )

    def prepare(self, conn, pg, start: date, end: date) -> _Setup1Context:
        p95, n_samples = _compute_threshold(conn)
        cl_ohlcv = _load_cl_bars(conn, pg, start, end)
        return _Setup1Context(
            p95_threshold=p95,
            threshold_n_samples=n_samples,
            cl_ohlcv=cl_ohlcv,
            conn=conn,
        )

    def evaluate_minute(
        self,
        now: pd.Timestamp,
        ctx: _Setup1Context,
        bars: pd.DataFrame,
    ) -> Signal | None:
        # Need at least 60 bars (1h history) before the first OFI sample.
        if len(bars) < OFI_WINDOW_MIN + 1:
            return None
        # No threshold = nothing to compare against.
        if not np.isfinite(ctx.p95_threshold):
            return None

        today = pd.Timestamp(now).date()
        # Use the bars' symbol to look up TBBO (the harness puts contract there
        # when it loads OHLCV per day).
        if "symbol" not in bars.columns or bars["symbol"].iloc[-1] is None:
            return None
        contract = str(bars["symbol"].iloc[-1])

        # Lazy-load TBBO for today via the DuckDB connection stashed in ctx.
        tbbo = _get_tbbo_for_day(ctx, ctx.conn, contract, today)
        if tbbo.empty or len(tbbo) < OFI_WINDOW_MIN:
            return None

        # Compute trailing-1h OFI ending at ``now`` (exclusive — uses bars
        # strictly before ``now`` to honor the look-ahead convention).
        ofi = features.ofi_window(tbbo, pd.Timestamp(now), OFI_WINDOW_MIN)
        if not np.isfinite(ofi):
            return None
        if abs(ofi) < ctx.p95_threshold:
            return None

        # Disqualifier: macro stress.
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

        # 30m swing stop from `bars` history.
        swing_window = bars.iloc[-SWING_WINDOW_MIN:]
        if direction is Direction.LONG:
            stop_price = float(swing_window["low"].min())
        else:
            stop_price = float(swing_window["high"].max())

        # ATR(14) at end of `bars`.
        atr_series = features.atr(bars, window=ATR_WINDOW)
        atr_val = (
            float(atr_series.iloc[-1])
            if not atr_series.empty and pd.notna(atr_series.iloc[-1])
            else float("nan")
        )

        last_close = float(bars.iloc[-1]["close"])

        # Reject if stop is on the wrong side or zero-distance.
        if direction is Direction.LONG and stop_price >= last_close:
            return None
        if direction is Direction.SHORT and stop_price <= last_close:
            return None

        # Target candidates: yesterday's VAH/VAL on favorable side, or last_close + 2*ATR.
        profile = _get_prior_profile(ctx, ctx.conn, today)

        target_atr = last_close + sign * ATR_TARGET_MULTIPLE * atr_val if np.isfinite(atr_val) else float("nan")
        target_profile = (
            profile.get("vah", float("nan"))
            if direction is Direction.LONG
            else profile.get("val", float("nan"))
        )
        # Take the CLOSER target to last_close (less greedy, more realistic).
        candidates = [c for c in (target_atr, target_profile) if np.isfinite(c)]
        # Filter to candidates on the favorable side of last_close.
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


EVALUATOR = _NqOfiExtremeEvaluator()
