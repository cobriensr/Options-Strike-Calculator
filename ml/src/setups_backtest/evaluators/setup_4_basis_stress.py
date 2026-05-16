"""Setup 4: ``basis-stress-fade``.

Rule (frozen — spec):

* **Trigger**: ``ES-SPX basis ≥ +5pts`` AND SPX dealer γ ≥ 0.
* **Direction**: SHORT ES (basis compression toward fair value).
* **Stop**: entry + 5pts.
* **Target**: basis returns to ±2pts (i.e., ES retraces to ``spx + 2``).
* **Disqualifier**: VIX spike >2pts in 5m, OR CL 30m move ≥ 2%.

**Spec open question #4 default**: test window for Setups 4/5 is
2026-03-01 → 2026-04-17 because `zero_gamma_levels` and SPX dealer γ
history is only available from 2026-03 onward.

Without ``DATABASE_URL`` set, this evaluator reports ``data_unavailable``
in metadata and fires no signals (SPX dealer γ and the SPX index itself
both live in Neon, not in the TBBO parquet archive).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

from .. import data_loaders
from ..harness import Direction, Signal

log = logging.getLogger("setups_backtest.setup_4")

# Frozen thresholds.
BASIS_TRIGGER_PTS = 5.0
BASIS_TARGET_PTS = 2.0
STOP_PTS = 5.0
VIX_SPIKE_THRESHOLD = 2.0
VIX_SPIKE_WINDOW_MIN = 5
CL_STRESS_PCT = 2.0
CL_STRESS_WINDOW_MIN = 30

# Spec default: short window for this setup.
SETUP_4_START = date(2026, 3, 1)
SETUP_4_END = date(2026, 4, 17)


@dataclass
class _Setup4Context:
    conn: Any
    pg: Any
    spx_bars: pd.DataFrame  # 1m SPX bars over window, may be empty
    dealer_gamma: pd.DataFrame  # SPX 0DTE dealer gamma per minute, may be empty
    cl_bars: pd.DataFrame
    vix_bars: pd.DataFrame
    data_available: bool = False
    unavailable_reason: str = ""
    # Per-(today) caches.
    today_spx_cache: dict[str, pd.DataFrame] = field(default_factory=dict)


def _load_spx_bars(conn, pg, start: date, end: date) -> pd.DataFrame:
    """Try OHLCV parquet first (SPX as index), then Neon (if such a table exists).

    Returns columns: ts (UTC), close. Empty if unavailable.
    """
    # Probe OHLCV for SPX index.
    try:
        df = conn.execute(
            """
            SELECT ts_event AS ts, close
            FROM read_parquet(?)
            WHERE symbol = 'SPX'
              AND ts_event >= ?::TIMESTAMP
              AND ts_event < (?::TIMESTAMP + INTERVAL '1 day')
            ORDER BY ts
            """,
            [data_loaders.ohlcv_glob(), start.isoformat(), end.isoformat()],
        ).df()
    except Exception as e:  # noqa: BLE001 - probe; failures are OK
        log.debug("Setup 4: SPX parquet probe error: %s", e)
        df = pd.DataFrame()
    if not df.empty:
        df["ts"] = pd.to_datetime(df["ts"], utc=True)
        return df[["ts", "close"]]
    return pd.DataFrame(columns=["ts", "close"])


def _load_dealer_gamma(pg, start: date, end: date) -> pd.DataFrame:
    """Load SPX 0DTE dealer gamma per minute from Neon."""
    if pg is None:
        return pd.DataFrame(columns=["ts", "net_gamma"])
    df = data_loaders.load_dealer_gamma(pg, "SPX", start, end)
    return df


@dataclass
class _BasisStressFadeEvaluator:
    name: str = "basis-stress-fade"
    contract_prefix: str = "ES"
    report_notes: str = (
        "**Restricted test window**: 2026-03-01 → 2026-04-17 (~33 trading days). "
        "`greek_exposures_0dte` history before 2026-03 isn't reliably populated, "
        "per spec open question #4.\n\n"
        "**Data dependencies**: SPX index 1m close (for ES-SPX basis), "
        "`greek_exposures_0dte` from Neon (for SPX dealer γ sign), VIX 1m, "
        "CL 1m (for disqualifier). When `DATABASE_URL` is not set, all four "
        "load empty and the evaluator reports `data_unavailable=True` in "
        "metadata. No signals fire.\n\n"
        "**Conservative stop/target geometry**: fixed +5pts stop (1R = $250 on "
        "ES), target = basis ±2 (variable distance — typically 3pts of ES "
        "compression). Reward-to-risk ~0.6:1, so this setup needs ~62% WR "
        "to break even on raw R; expectancy depends on dealer-γ filter "
        "actually flushing the bad fades."
    )

    def prepare(self, conn, pg, start: date, end: date) -> _Setup4Context:
        # Always clamp to the spec-defaulted short window for this setup.
        start = max(start, SETUP_4_START)
        end = min(end, SETUP_4_END)
        spx = _load_spx_bars(conn, pg, start, end)
        gamma = _load_dealer_gamma(pg, start, end)
        cl = data_loaders.load_cross_asset_minute(conn, pg, "CL", start, end)
        vix = data_loaders.load_cross_asset_minute(conn, pg, "VX", start, end)

        missing = []
        if spx.empty:
            missing.append("SPX (no rows in OHLCV parquet for 'SPX' index)")
        if gamma.empty:
            missing.append("SPX dealer γ (greek_exposures_0dte unavailable)")
        if not missing:
            data_available = True
            reason = ""
        else:
            data_available = False
            reason = "; ".join(missing)
            log.warning("Setup 4: data_unavailable — %s", reason)

        return _Setup4Context(
            conn=conn,
            pg=pg,
            spx_bars=spx,
            dealer_gamma=gamma,
            cl_bars=cl,
            vix_bars=vix,
            data_available=data_available,
            unavailable_reason=reason,
        )

    def evaluate_minute(
        self,
        now: pd.Timestamp,
        ctx: _Setup4Context,
        bars: pd.DataFrame,
    ) -> Signal | None:
        if not ctx.data_available:
            return None
        if len(bars) < 2 or "symbol" not in bars.columns:
            return None

        # Find SPX price at the bar immediately before `now`.
        spx_window = ctx.spx_bars[ctx.spx_bars["ts"] < now]
        if spx_window.empty:
            return None
        spx_close = float(spx_window.iloc[-1]["close"])
        es_close = float(bars.iloc[-1]["close"])
        basis = es_close - spx_close
        if basis < BASIS_TRIGGER_PTS:
            return None

        # SPX dealer γ ≥ 0 check.
        gamma_window = ctx.dealer_gamma[ctx.dealer_gamma["ts"] < now]
        if gamma_window.empty:
            return None
        dealer_g = float(gamma_window.iloc[-1]["net_gamma"])
        if dealer_g < 0:
            return None

        # Disqualifier: VIX spike >2pts in last 5m.
        vix_window = ctx.vix_bars[
            (ctx.vix_bars["ts"] >= now - pd.Timedelta(minutes=VIX_SPIKE_WINDOW_MIN))
            & (ctx.vix_bars["ts"] < now)
        ]
        if len(vix_window) >= 2:
            vix_move = float(vix_window["close"].max() - vix_window["close"].min())
            if vix_move >= VIX_SPIKE_THRESHOLD:
                return None

        # Disqualifier: CL 30m move ≥ 2%.
        cl_window = ctx.cl_bars[
            (ctx.cl_bars["ts"] >= now - pd.Timedelta(minutes=CL_STRESS_WINDOW_MIN))
            & (ctx.cl_bars["ts"] < now)
        ]
        if len(cl_window) >= 2:
            first = float(cl_window.iloc[0]["close"])
            last = float(cl_window.iloc[-1]["close"])
            if first > 0 and abs((last - first) / first) * 100.0 >= CL_STRESS_PCT:
                return None

        contract = str(bars["symbol"].iloc[-1])
        stop_price = es_close + STOP_PTS
        target_price = spx_close + BASIS_TARGET_PTS  # basis-returns-to-+2 fair value

        if target_price >= es_close or stop_price <= es_close:
            return None

        return Signal(
            setup_name=self.name,
            decision_ts=pd.Timestamp(now),
            direction=Direction.SHORT,
            contract=contract,
            stop_price=stop_price,
            target_price=target_price,
            metadata={
                "es_close": es_close,
                "spx_close": spx_close,
                "basis": basis,
                "dealer_gamma": dealer_g,
            },
        )

    def _empty_ctx_for_unavailable(self, reason: str) -> _Setup4Context:
        return _Setup4Context(
            conn=None,
            pg=None,
            spx_bars=pd.DataFrame(),
            dealer_gamma=pd.DataFrame(),
            cl_bars=pd.DataFrame(),
            vix_bars=pd.DataFrame(),
            data_available=False,
            unavailable_reason=reason,
        )


# Suppress NaN comparison in numpy when checking basis.
_ = np  # silence import

EVALUATOR = _BasisStressFadeEvaluator()
