"""Setup 7: ``flight-to-safety-continuation``.

Rule (frozen — spec):

* **Trigger**: within a 30m window, ZN +0.5% AND GC +0.5% AND ES −0.3%,
  AND we're less than 2h into the move (measured from the start of the
  30m window).
* **Direction**: SHORT ES (continuation of risk-off flow).
* **Stop**: beyond the breakdown level (recent 30m ES high).
* **Target**: day S1/S2 — we use yesterday's close − ATR(14) as a proxy
  for S1 (1 ATR below close).
* **Disqualifier**: none — this IS a continuation setup, primary trend.

Without ``DATABASE_URL`` (and if ZN/GC aren't in the OHLCV parquet),
this setup reports ``data_unavailable`` and fires 0 signals.
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

log = logging.getLogger("setups_backtest.setup_7")


# Frozen thresholds.
ZN_TRIGGER_PCT = 0.5
GC_TRIGGER_PCT = 0.5
ES_TRIGGER_PCT = -0.3
TRIGGER_WINDOW_MIN = 30
MAX_MINUTES_INTO_MOVE = 120  # 2 hours
ATR_WINDOW = 14
SWING_LOOKBACK_MIN = 30


@dataclass
class _Setup7Context:
    conn: Any
    pg: Any
    zn_bars: pd.DataFrame
    gc_bars: pd.DataFrame
    data_available: bool = False
    unavailable_reason: str = ""
    # Per-day NQ/ES OHLCV cache for prior-day ATR / close.
    prior_close_cache: dict[str, float] = field(default_factory=dict)


@dataclass
class _FlightToSafetyEvaluator:
    name: str = "flight-to-safety-continuation"
    contract_prefix: str = "ES"
    report_notes: str = (
        "**Data dependencies**: ZN (10Y note) and GC (gold) 1m bars. Per "
        "spec open question #2, these come from Neon `futures_bars` "
        "(sidecar-populated) since the TBBO parquet archive doesn't include "
        "them. Without `DATABASE_URL`, both load empty and the evaluator "
        "reports `data_unavailable`.\n\n"
        "**Cross-asset window check**: We require simultaneous ZN ≥+0.5%, "
        "GC ≥+0.5%, ES ≤−0.3% within the SAME 30-minute window — a tight "
        "joint move signaling coordinated risk-off positioning. The 2-hour "
        "freshness gate prevents entering after the trend has already played "
        "out.\n\n"
        "**Target geometry**: S1 ≈ yesterday's close − 1×ATR(14). Crude "
        "approximation of intraday support; a fuller version would use "
        "pivot-point math (PP, S1, S2, R1, R2). Acceptable for first pass."
    )

    def prepare(self, conn, pg, start: date, end: date) -> _Setup7Context:
        zn = data_loaders.load_cross_asset_minute(conn, pg, "ZN", start, end)
        gc = data_loaders.load_cross_asset_minute(conn, pg, "GC", start, end)
        missing = []
        if zn.empty:
            missing.append("ZN bars (no parquet/Neon source)")
        if gc.empty:
            missing.append("GC bars (no parquet/Neon source)")
        data_available = len(missing) == 0
        if not data_available:
            log.warning("Setup 7: data_unavailable — %s", "; ".join(missing))
        return _Setup7Context(
            conn=conn,
            pg=pg,
            zn_bars=zn,
            gc_bars=gc,
            data_available=data_available,
            unavailable_reason="; ".join(missing),
        )

    def evaluate_minute(
        self,
        now: pd.Timestamp,
        ctx: _Setup7Context,
        bars: pd.DataFrame,
    ) -> Signal | None:
        if not ctx.data_available:
            return None
        if len(bars) < TRIGGER_WINDOW_MIN + ATR_WINDOW or "symbol" not in bars.columns:
            return None

        window_start = pd.Timestamp(now) - pd.Timedelta(minutes=TRIGGER_WINDOW_MIN)

        # Compute 30m returns on ZN, GC, ES.
        zn_window = ctx.zn_bars[
            (ctx.zn_bars["ts"] >= window_start) & (ctx.zn_bars["ts"] < now)
        ]
        gc_window = ctx.gc_bars[
            (ctx.gc_bars["ts"] >= window_start) & (ctx.gc_bars["ts"] < now)
        ]
        if len(zn_window) < 2 or len(gc_window) < 2:
            return None

        zn_ret = _pct_change(zn_window)
        gc_ret = _pct_change(gc_window)
        es_window = bars[(bars["ts"] >= window_start) & (bars["ts"] < now)]
        if len(es_window) < 2:
            return None
        es_ret = (
            float(es_window.iloc[-1]["close"]) / float(es_window.iloc[0]["open"]) - 1.0
        ) * 100.0

        if not (
            np.isfinite(zn_ret)
            and np.isfinite(gc_ret)
            and np.isfinite(es_ret)
        ):
            return None
        if zn_ret < ZN_TRIGGER_PCT:
            return None
        if gc_ret < GC_TRIGGER_PCT:
            return None
        if es_ret > ES_TRIGGER_PCT:
            return None

        # 2-hour freshness: the trigger move can't be too old. We require that
        # the 30m ES window we're checking is within MAX_MINUTES_INTO_MOVE of
        # the *start* of the larger move (when ES first crossed -0.1% from session
        # high). Simple proxy: ES session-high time within 2h of now.
        es_high_idx = bars["high"].idxmax()
        es_high_ts = bars.loc[es_high_idx, "ts"]
        minutes_since_high = (now - es_high_ts).total_seconds() / 60.0
        if minutes_since_high > MAX_MINUTES_INTO_MOVE:
            return None

        # Stop: recent ES swing high (last 30m).
        swing_window = bars.iloc[-SWING_LOOKBACK_MIN:]
        stop_price = float(swing_window["high"].max())

        # Target: yesterday's close − 1×ATR(14).
        today = pd.Timestamp(now).date()
        contract = str(bars["symbol"].iloc[-1])
        prior_close = _get_prior_close(ctx, today, contract)
        atr_series = features.atr(bars, window=ATR_WINDOW)
        if atr_series.empty or pd.isna(atr_series.iloc[-1]):
            return None
        atr_val = float(atr_series.iloc[-1])
        if not np.isfinite(prior_close) or atr_val <= 0:
            return None
        target_price = prior_close - atr_val

        last_close = float(bars.iloc[-1]["close"])
        if stop_price <= last_close or target_price >= last_close:
            return None

        return Signal(
            setup_name=self.name,
            decision_ts=pd.Timestamp(now),
            direction=Direction.SHORT,
            contract=contract,
            stop_price=stop_price,
            target_price=target_price,
            metadata={
                "zn_30m_ret_pct": zn_ret,
                "gc_30m_ret_pct": gc_ret,
                "es_30m_ret_pct": es_ret,
                "minutes_since_es_high": minutes_since_high,
                "prior_close": prior_close,
                "atr_14": atr_val,
            },
        )


def _pct_change(window: pd.DataFrame) -> float:
    first = float(window.iloc[0]["close"])
    last = float(window.iloc[-1]["close"])
    if first <= 0:
        return float("nan")
    return (last / first - 1.0) * 100.0


def _get_prior_close(ctx: _Setup7Context, today: date, contract: str) -> float:
    """Lazy-load yesterday's ES close for the same contract."""
    key = f"{contract}|{today.isoformat()}"
    if key in ctx.prior_close_cache:
        return ctx.prior_close_cache[key]
    if ctx.conn is None:
        ctx.prior_close_cache[key] = float("nan")
        return float("nan")
    for back in range(1, 6):
        prior = today - pd.Timedelta(days=back).to_pytimedelta()
        prior_d = prior.date() if hasattr(prior, "date") else prior
        try:
            bars = data_loaders.load_ohlcv_day(ctx.conn, [contract], prior_d)
        except Exception:  # noqa: BLE001 - probe; missing day is OK
            bars = pd.DataFrame()
        if bars.empty:
            continue
        ctx.prior_close_cache[key] = float(bars.iloc[-1]["close"])
        return ctx.prior_close_cache[key]
    ctx.prior_close_cache[key] = float("nan")
    return float("nan")


EVALUATOR = _FlightToSafetyEvaluator()
