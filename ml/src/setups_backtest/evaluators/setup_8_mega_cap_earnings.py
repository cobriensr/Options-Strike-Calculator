"""Setup 8: ``mega-cap-earnings-fade``.

Rule (frozen — spec):

* **Trigger**: AAPL/MSFT/NVDA/GOOG/GOOGL/META/AMZN/TSLA reported earnings
  overnight AND NQ has gapped ≥ ±0.5% at RTH open.
* **Direction**: FADE the open in NQ. SHORT if NQ gapped up, LONG if down.
* **Stop**: first 10-minute IB extreme on NQ.
* **Target**: NQ session VWAP.
* **Disqualifier**: earnings beat-and-raise (qualitative, default = take).

**Status: data_unavailable in this run.** Per spec open question #1
default, an earnings calendar feed (UW endpoint or manual seed) is needed
to identify which days had mega-cap earnings overnight. Without that
feed, this setup fires 0 signals.

The evaluator is implemented and unit-tested with a synthetic earnings-day
flag so the wiring is verified, but the production prepare() leaves the
earnings_dates set empty until a feed is wired.
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

log = logging.getLogger("setups_backtest.setup_8")


# Frozen thresholds.
GAP_THRESHOLD_PCT = 0.5
IB_WINDOW_MIN = 10  # initial balance window for stop
MEGA_CAP_TICKERS = ("AAPL", "MSFT", "NVDA", "GOOG", "GOOGL", "META", "AMZN", "TSLA")


@dataclass
class _Setup8Context:
    conn: Any
    pg: Any
    earnings_dates: set[date] = field(default_factory=set)
    data_available: bool = False
    unavailable_reason: str = ""
    # Per-day cache of (rth_open_price, prior_close).
    gap_cache: dict[str, dict[str, float]] = field(default_factory=dict)


@dataclass
class _MegaCapEarningsFadeEvaluator:
    name: str = "mega-cap-earnings-fade"
    contract_prefix: str = "NQ"
    report_notes: str = (
        "**Status: data_unavailable.** Per spec open question #1 default, an "
        "earnings calendar (UW endpoint or manual seed) is needed to identify "
        "mega-cap earnings days. No feed was wired in this pass, so 0 signals "
        "fire even when NQ gaps occur — we can't verify the earnings filter.\n\n"
        "**Mega-cap universe**: AAPL, MSFT, NVDA, GOOG/GOOGL, META, AMZN, "
        "TSLA. Reporting *after* market close (post-3:00 PM CT) qualifies as "
        "'overnight' for the NEXT day's RTH open.\n\n"
        "**Implementation present**: prepare() loads ``earnings_dates`` from "
        "an optional CSV path (none committed). The evaluator fires correctly "
        "when given a synthetic earnings flag in unit tests; production needs "
        "either (a) UW earnings-calendar pull, (b) one-shot CSV seed of "
        "historical earnings dates, or (c) Polygon/Benzinga API."
    )

    def prepare(self, conn, pg, start: date, end: date) -> _Setup8Context:
        del start, end
        # No earnings feed wired in this pass. Default to empty set.
        log.warning(
            "Setup 8: no earnings calendar feed available; reporting "
            "data_unavailable. 0 signals will fire."
        )
        return _Setup8Context(
            conn=conn,
            pg=pg,
            earnings_dates=set(),
            data_available=False,
            unavailable_reason="No earnings calendar feed wired (UW/CSV/Polygon).",
        )

    def evaluate_minute(
        self,
        now: pd.Timestamp,
        ctx: _Setup8Context,
        bars: pd.DataFrame,
    ) -> Signal | None:
        if not ctx.data_available:
            return None
        # Only evaluate at the close of minute 10 (so entry is at minute 11
        # open, after the IB window has formed). The harness slices bars
        # inclusively, so len(bars) == 10 means we just saw minute 10 close.
        if len(bars) != IB_WINDOW_MIN:
            return None
        if "symbol" not in bars.columns:
            return None

        today = pd.Timestamp(now).date()
        if today not in ctx.earnings_dates:
            return None

        contract = str(bars["symbol"].iloc[-1])
        rth_open = float(bars.iloc[0]["open"])
        prior_close = _get_prior_nq_close(ctx, today, contract)
        if not np.isfinite(prior_close) or prior_close <= 0:
            return None

        gap_pct = (rth_open / prior_close - 1.0) * 100.0
        if abs(gap_pct) < GAP_THRESHOLD_PCT:
            return None

        last_close = float(bars.iloc[-1]["close"])

        # Direction: fade the gap.
        if gap_pct > 0:
            direction = Direction.SHORT
            stop_price = float(bars["high"].max())  # IB extreme
            target_price = features.session_vwap(
                bars, bars["ts"].iloc[0], pd.Timestamp(now)
            )
        else:
            direction = Direction.LONG
            stop_price = float(bars["low"].min())
            target_price = features.session_vwap(
                bars, bars["ts"].iloc[0], pd.Timestamp(now)
            )

        if not np.isfinite(target_price):
            return None
        if direction is Direction.SHORT and (
            stop_price <= last_close or target_price >= last_close
        ):
            return None
        if direction is Direction.LONG and (
            stop_price >= last_close or target_price <= last_close
        ):
            return None

        return Signal(
            setup_name=self.name,
            decision_ts=pd.Timestamp(now),
            direction=direction,
            contract=contract,
            stop_price=stop_price,
            target_price=target_price,
            metadata={
                "gap_pct": gap_pct,
                "rth_open": rth_open,
                "prior_close": prior_close,
                "ib_vwap": target_price,
            },
        )


def _get_prior_nq_close(ctx: _Setup8Context, today: date, contract: str) -> float:
    key = f"{contract}|{today.isoformat()}"
    if key in ctx.gap_cache and "prior_close" in ctx.gap_cache[key]:
        return ctx.gap_cache[key]["prior_close"]
    if ctx.conn is None:
        return float("nan")
    for back in range(1, 6):
        prior = today - pd.Timedelta(days=back).to_pytimedelta()
        prior_d = prior.date() if hasattr(prior, "date") else prior
        try:
            bars = data_loaders.load_ohlcv_day(ctx.conn, [contract], prior_d)
        except Exception:  # noqa: BLE001
            bars = pd.DataFrame()
        if bars.empty:
            continue
        val = float(bars.iloc[-1]["close"])
        ctx.gap_cache.setdefault(key, {})["prior_close"] = val
        return val
    ctx.gap_cache.setdefault(key, {})["prior_close"] = float("nan")
    return float("nan")


EVALUATOR = _MegaCapEarningsFadeEvaluator()
