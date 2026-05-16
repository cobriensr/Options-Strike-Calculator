"""Setup 2: ``nq-leads-es-catchup``.

Rule (frozen — spec):

* **Trigger**: ``NQ 1h OFI ≥ +0.4`` AND ``ES 1h OFI ≤ +0.1`` AND ``ES/NQ 30m
  correlation ≥ 0.7``.
* **Direction**: LONG ES (ES is the laggard chasing NQ's buying pressure).
* **Stop**: morning low — lowest low of the ES bars since RTH open.
* **Target**: "NQ-implied ES move" — extrapolate ES from NQ's % gain since RTH
  open: ``target = es_rth_open * (1 + nq_pct_change_since_open)``.
* **Disqualifier**: ES/NQ correlation break — if the rolling 30m correlation
  drops below 0.5 at decision time, skip.

Cross-asset evaluator: needs both ES and NQ TBBO data. The harness only loads
the evaluator's primary contract's OHLCV; this evaluator's primary is ES, and
it loads NQ TBBO/OHLCV separately via the stashed ctx.conn.
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

log = logging.getLogger("setups_backtest.setup_2")


# Frozen thresholds per spec — DO NOT TUNE.
NQ_OFI_THRESHOLD = 0.4
ES_OFI_MAX_THRESHOLD = 0.1
CORR_MIN_THRESHOLD = 0.7
CORR_BREAK_THRESHOLD = 0.5
OFI_WINDOW_MIN = 60
CORR_WINDOW_MIN = 30


@dataclass
class _Setup2Context:
    conn: Any
    # Per-day caches keyed by ISO date.
    nq_tbbo_cache: dict[str, pd.DataFrame] = field(default_factory=dict)
    es_tbbo_cache: dict[str, pd.DataFrame] = field(default_factory=dict)
    nq_ohlcv_cache: dict[str, pd.DataFrame] = field(default_factory=dict)


def _cached_tbbo(
    cache: dict[str, pd.DataFrame],
    conn,
    prefix: str,
    d: date,
) -> pd.DataFrame:
    """Lazy-load and cache TBBO for one (prefix, day)."""
    key = f"{prefix}|{d.isoformat()}"
    if key not in cache:
        contract = data_loaders.pick_front_month(conn, prefix, d)
        if contract is None:
            cache[key] = pd.DataFrame()
        else:
            cache[key] = data_loaders.load_tbbo_minute(conn, contract, d)
    return cache[key]


def _cached_ohlcv_nq(
    cache: dict[str, pd.DataFrame],
    conn,
    d: date,
) -> pd.DataFrame:
    key = d.isoformat()
    if key not in cache:
        contract = data_loaders.pick_front_month(conn, "NQ", d)
        if contract is None:
            cache[key] = pd.DataFrame()
        else:
            cache[key] = data_loaders.load_ohlcv_day(conn, [contract], d)
    return cache[key]


@dataclass
class _NqLeadsEsEvaluator:
    name: str = "nq-leads-es-catchup"
    contract_prefix: str = "ES"
    report_notes: str = (
        "**Cross-asset evaluator.** Needs both ES (primary) and NQ TBBO + "
        "OHLCV data, lazy-loaded per day. NQ data comes from the same DuckDB "
        "session stashed in ctx.\n\n"
        "**Trigger thresholds (frozen):** NQ 1h OFI ≥ +0.4 (real "
        "'aggressive buy' level per the validated reference), ES 1h OFI ≤ "
        "+0.1 (ES has not yet caught up to NQ's flow), ES/NQ 30m correlation "
        "≥ 0.7 (they're still moving together so the catch-up thesis holds).\n\n"
        "**Target = NQ-implied ES level.** We extrapolate where ES *would* "
        "be if it tracked NQ's % gain since RTH open. If NQ is up 1% and "
        "ES is up 0.4%, target = ES open × 1.01 — i.e., the level ES would "
        "trade at to fully match NQ's percentage move.\n\n"
        "**Disqualifier — correlation break.** If 30m ES/NQ correlation drops "
        "below 0.5 between trigger fire and entry, the catch-up thesis "
        "breaks and the signal is rejected. Checked once at decision time."
    )

    def prepare(self, conn, pg, start: date, end: date) -> _Setup2Context:
        del pg, start, end
        return _Setup2Context(conn=conn)

    def evaluate_minute(
        self,
        now: pd.Timestamp,
        ctx: _Setup2Context,
        bars: pd.DataFrame,
    ) -> Signal | None:
        if len(bars) < OFI_WINDOW_MIN + 1:
            return None
        if "symbol" not in bars.columns:
            return None

        es_contract = str(bars["symbol"].iloc[-1])
        today = pd.Timestamp(now).date()

        # ES TBBO (load via prefix to keep cache key stable; reuse cache).
        es_tbbo = _cached_tbbo(ctx.es_tbbo_cache, ctx.conn, "ES", today)
        nq_tbbo = _cached_tbbo(ctx.nq_tbbo_cache, ctx.conn, "NQ", today)
        if es_tbbo.empty or nq_tbbo.empty:
            return None

        # Triggers: 1h OFI on both.
        nq_ofi = features.ofi_window(nq_tbbo, pd.Timestamp(now), OFI_WINDOW_MIN)
        es_ofi = features.ofi_window(es_tbbo, pd.Timestamp(now), OFI_WINDOW_MIN)
        if not (np.isfinite(nq_ofi) and np.isfinite(es_ofi)):
            return None
        if nq_ofi < NQ_OFI_THRESHOLD:
            return None
        if es_ofi > ES_OFI_MAX_THRESHOLD:
            return None

        # Correlation of log returns over the last 30 min.
        nq_ohlcv = _cached_ohlcv_nq(ctx.nq_ohlcv_cache, ctx.conn, today)
        if nq_ohlcv.empty:
            return None
        # Align both series to the rolling 30m window ending at `now`.
        window_start = pd.Timestamp(now) - pd.Timedelta(minutes=CORR_WINDOW_MIN)
        es_window = bars[(bars["ts"] >= window_start) & (bars["ts"] < now)].copy()
        nq_window = nq_ohlcv[
            (nq_ohlcv["ts"] >= window_start) & (nq_ohlcv["ts"] < now)
        ].copy()
        if len(es_window) < CORR_WINDOW_MIN // 2 or len(nq_window) < CORR_WINDOW_MIN // 2:
            return None
        es_ret = features.returns_minute(es_window)
        nq_ret = features.returns_minute(nq_window)
        aligned = pd.concat(
            [es_ret.rename("es"), nq_ret.rename("nq")], axis=1
        ).dropna()
        if len(aligned) < CORR_WINDOW_MIN // 2:
            return None
        corr = float(aligned["es"].corr(aligned["nq"]))
        if not np.isfinite(corr) or corr < CORR_MIN_THRESHOLD:
            return None

        # Disqualifier: correlation already broken.
        if corr < CORR_BREAK_THRESHOLD:
            return None

        # Stop: morning low (RTH-open-to-now ES low).
        # `bars` is rth_bars.loc[:idx] so iloc[0] is the RTH open bar.
        stop_price = float(bars["low"].min())
        last_close = float(bars.iloc[-1]["close"])
        if stop_price >= last_close:
            return None

        # Target: NQ-implied ES level. Use RTH-open of both ES and NQ.
        es_open = float(bars.iloc[0]["open"])
        nq_open_rows = nq_ohlcv.sort_values("ts")
        # Find NQ's first RTH bar (same minute as ES's first RTH bar).
        nq_rth_first = nq_open_rows[nq_open_rows["ts"] >= bars["ts"].iloc[0]]
        if nq_rth_first.empty:
            return None
        nq_rth_open = float(nq_rth_first.iloc[0]["open"])
        # NQ price at decision time (closest minute before `now`).
        nq_at_now_rows = nq_open_rows[nq_open_rows["ts"] < now]
        if nq_at_now_rows.empty:
            return None
        nq_at_now = float(nq_at_now_rows.iloc[-1]["close"])
        if nq_rth_open <= 0:
            return None
        nq_pct = (nq_at_now - nq_rth_open) / nq_rth_open
        target_price = es_open * (1.0 + nq_pct)
        if target_price <= last_close:
            # NQ-implied ES move is below current ES — no upside catch-up
            # available, signal makes no sense.
            return None

        return Signal(
            setup_name=self.name,
            decision_ts=pd.Timestamp(now),
            direction=Direction.LONG,
            contract=es_contract,
            stop_price=stop_price,
            target_price=target_price,
            metadata={
                "nq_ofi_1h": nq_ofi,
                "es_ofi_1h": es_ofi,
                "es_nq_corr_30m": corr,
                "nq_pct_since_open": nq_pct,
                "es_rth_open": es_open,
                "nq_at_now": nq_at_now,
            },
        )


EVALUATOR = _NqLeadsEsEvaluator()
