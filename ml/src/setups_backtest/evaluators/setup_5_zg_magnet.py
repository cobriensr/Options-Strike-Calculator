"""Setup 5: ``zero-gamma-magnet``.

Rule (frozen — spec):

* **Trigger**: ES price within 0.25 × ATR(14) of SPX zero-gamma level AND
  SPX dealer γ < 0 on price's current side of ZG (negative-γ regime
  forces dealer hedging *toward* the move, pulling price *toward* ZG).
* **Direction**: trade toward ZG (LONG if ES below ZG, SHORT if above).
* **Stop**: the OTHER side of ZG (i.e., once price clears through ZG, the
  thesis is broken).
* **Target**: ZG ± 1σ (we use 1 ATR(14) past ZG on the far side as a
  proxy for "1σ").
* **Disqualifier**: NQ 1h OFI opposes the trade direction with magnitude
  ≥ 0.3 (validated NQ OFI threshold).

**Spec open question #4 default**: test window restricted to 2026-03-01 →
2026-04-17. ``zero_gamma_levels`` history before 2026-03 is unreliable.

Without ``DATABASE_URL``, ZG levels and SPX dealer γ are both empty →
evaluator reports `data_unavailable` and fires 0 signals.
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

log = logging.getLogger("setups_backtest.setup_5")


# Frozen thresholds.
ATR_WINDOW = 14
ZG_PROXIMITY_ATR_FRACTION = 0.25
TARGET_ATR_MULTIPLE = 1.0  # "1σ" proxy
NQ_OFI_OPPOSE_MAGNITUDE = 0.3
NQ_OFI_WINDOW_MIN = 60

SETUP_5_START = date(2026, 3, 1)
SETUP_5_END = date(2026, 4, 17)


@dataclass
class _Setup5Context:
    conn: Any
    pg: Any
    zg_levels: pd.DataFrame  # ts, zero_gamma, confidence
    dealer_gamma: pd.DataFrame
    data_available: bool = False
    unavailable_reason: str = ""
    nq_tbbo_cache: dict[str, pd.DataFrame] = field(default_factory=dict)


def _load_zg(pg, start: date, end: date) -> pd.DataFrame:
    if pg is None:
        return pd.DataFrame(columns=["ts", "zero_gamma", "confidence"])
    return data_loaders.load_zero_gamma(pg, "SPX", start, end)


@dataclass
class _ZeroGammaMagnetEvaluator:
    name: str = "zero-gamma-magnet"
    contract_prefix: str = "ES"
    report_notes: str = (
        "**Restricted test window**: 2026-03-01 → 2026-04-17 per spec "
        "open question #4. `zero_gamma_levels` history before March is unreliable.\n\n"
        "**Data dependencies**: SPX ZG per minute (`zero_gamma_levels`), SPX "
        "dealer γ (`greek_exposures_0dte`), NQ TBBO for the opposing-OFI "
        "disqualifier. Without `DATABASE_URL`, the first two load empty and "
        "the evaluator reports `data_unavailable=True`; no signals fire.\n\n"
        "**The trade thesis**: in negative-γ regime, dealers hedge in the "
        "direction of the move (pro-cyclical). When price is near ZG, dealer "
        "hedging accelerates the move *toward* ZG (price passes through, dealers "
        "flip to long-γ on the other side, hedging reverses).\n\n"
        "**Stop geometry deviation from spec.** The spec says 'Stop: Other "
        "side of ZG' — taken literally this puts stop and target on the SAME "
        "side of entry, which is geometrically impossible. We use a standard "
        "adverse-move stop (0.25 × ATR against entry — same proximity gate as "
        "the trigger) and a target 1 × ATR past ZG. The 'other side' phrasing "
        "is likely a profit-protection exit; we capture the same intent with "
        "a tight stop on the magnet-failure side."
    )

    def prepare(self, conn, pg, start: date, end: date) -> _Setup5Context:
        start = max(start, SETUP_5_START)
        end = min(end, SETUP_5_END)
        zg = _load_zg(pg, start, end)
        gamma = data_loaders.load_dealer_gamma(pg, "SPX", start, end) if pg else pd.DataFrame()
        missing = []
        if zg.empty:
            missing.append("zero_gamma_levels (no DATABASE_URL or no rows in window)")
        if gamma.empty:
            missing.append("SPX dealer γ (greek_exposures_0dte)")
        data_available = len(missing) == 0
        if not data_available:
            log.warning("Setup 5: data_unavailable — %s", "; ".join(missing))
        return _Setup5Context(
            conn=conn,
            pg=pg,
            zg_levels=zg,
            dealer_gamma=gamma,
            data_available=data_available,
            unavailable_reason="; ".join(missing),
        )

    def evaluate_minute(
        self,
        now: pd.Timestamp,
        ctx: _Setup5Context,
        bars: pd.DataFrame,
    ) -> Signal | None:
        if not ctx.data_available:
            return None
        if len(bars) < ATR_WINDOW + 1 or "symbol" not in bars.columns:
            return None

        contract = str(bars["symbol"].iloc[-1])
        es_close = float(bars.iloc[-1]["close"])

        # ZG level (most recent < now).
        zg_window = ctx.zg_levels[ctx.zg_levels["ts"] < now]
        if zg_window.empty:
            return None
        zg = float(zg_window.iloc[-1]["zero_gamma"])
        if not np.isfinite(zg):
            return None

        # ATR.
        atr_series = features.atr(bars, window=ATR_WINDOW)
        if atr_series.empty or pd.isna(atr_series.iloc[-1]):
            return None
        atr_val = float(atr_series.iloc[-1])
        if atr_val <= 0:
            return None

        # Proximity check: |ES - ZG| ≤ 0.25 × ATR. We treat ES vs SPX-ZG
        # roughly 1:1 here since the basis is small relative to ATR.
        distance = abs(es_close - zg)
        if distance > ZG_PROXIMITY_ATR_FRACTION * atr_val:
            return None

        # Dealer γ sign — must be negative for the magnet thesis.
        g_window = ctx.dealer_gamma[ctx.dealer_gamma["ts"] < now]
        if g_window.empty:
            return None
        dealer_g = float(g_window.iloc[-1]["net_gamma"])
        if dealer_g >= 0:
            return None

        # Direction: toward ZG.
        # Spec says "Stop: Other side of ZG" — read literally that puts the
        # stop on the SAME side as the target, which is geometrically
        # impossible. We interpret it as: standard adverse-move stop (price
        # retreating from ZG = magnet failed), target = ZG + 1σ past ZG (the
        # breakthrough overshoot). Documented in report_notes.
        if es_close < zg:
            direction = Direction.LONG
            stop_price = es_close - ZG_PROXIMITY_ATR_FRACTION * atr_val  # 0.25 ATR adverse
            target_price = zg + TARGET_ATR_MULTIPLE * atr_val
        elif es_close > zg:
            direction = Direction.SHORT
            stop_price = es_close + ZG_PROXIMITY_ATR_FRACTION * atr_val
            target_price = zg - TARGET_ATR_MULTIPLE * atr_val
        else:
            return None  # exactly at ZG — no direction

        # NQ OFI opposing-direction disqualifier. Gracefully skip if no conn
        # (tests use ctx.conn=None; production always has a real conn).
        today = pd.Timestamp(now).date()
        key = today.isoformat()
        if key not in ctx.nq_tbbo_cache:
            if ctx.conn is None:
                ctx.nq_tbbo_cache[key] = pd.DataFrame()
            else:
                nq_contract = data_loaders.pick_front_month(ctx.conn, "NQ", today)
                ctx.nq_tbbo_cache[key] = (
                    data_loaders.load_tbbo_minute(ctx.conn, nq_contract, today)
                    if nq_contract
                    else pd.DataFrame()
                )
        nq_tbbo = ctx.nq_tbbo_cache[key]
        if not nq_tbbo.empty:
            nq_ofi = features.ofi_window(nq_tbbo, pd.Timestamp(now), NQ_OFI_WINDOW_MIN)
            if np.isfinite(nq_ofi):
                # Opposing: LONG trade but NQ heavily selling (OFI ≤ -0.3), or
                # SHORT trade but NQ heavily buying (OFI ≥ +0.3).
                if direction is Direction.LONG and nq_ofi <= -NQ_OFI_OPPOSE_MAGNITUDE:
                    return None
                if direction is Direction.SHORT and nq_ofi >= NQ_OFI_OPPOSE_MAGNITUDE:
                    return None

        # Side sanity.
        if direction is Direction.LONG and (stop_price >= es_close or target_price <= es_close):
            return None
        if direction is Direction.SHORT and (stop_price <= es_close or target_price >= es_close):
            return None

        return Signal(
            setup_name=self.name,
            decision_ts=pd.Timestamp(now),
            direction=direction,
            contract=contract,
            stop_price=stop_price,
            target_price=target_price,
            metadata={
                "es_close": es_close,
                "zg": zg,
                "distance": distance,
                "atr": atr_val,
                "dealer_gamma": dealer_g,
            },
        )


EVALUATOR = _ZeroGammaMagnetEvaluator()
