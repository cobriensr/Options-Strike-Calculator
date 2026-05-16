"""Unit tests for Setup 6: cvd-divergence-fade."""

from __future__ import annotations

import pandas as pd

from setups_backtest.evaluators.setup_6_cvd_divergence import (
    EVALUATOR,
    _Setup6Context,
)
from setups_backtest.harness import Direction


def _utc(ts: str) -> pd.Timestamp:
    return pd.Timestamp(ts, tz="UTC")


def _bars_with_higher_high(n: int = 60) -> pd.DataFrame:
    """Build a session where the LAST bar makes a new high above all prior."""
    start = pd.Timestamp("2026-04-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
    rows = []
    for i in range(n - 1):
        p = 6000.0 + i * 0.2
        rows.append(
            (
                (start + pd.Timedelta(minutes=i)).isoformat(),
                p,
                p + 1.5,
                p - 1.0,
                p + 0.5,
                100,
            )
        )
    # Last bar makes a clear new high.
    last_p = 6000.0 + (n - 1) * 0.2
    rows.append(
        (
            (start + pd.Timedelta(minutes=n - 1)).isoformat(),
            last_p,
            last_p + 8.0,  # new high well above prior
            last_p - 0.5,
            last_p + 7.0,
            100,
        )
    )
    return pd.DataFrame(
        rows, columns=["ts", "open", "high", "low", "close", "volume"]
    ).assign(ts=lambda d: pd.to_datetime(d["ts"], utc=True), symbol="ESM6")


def _tbbo_with_cvd_pattern(bars: pd.DataFrame, *, divergent: bool) -> pd.DataFrame:
    """Build a TBBO frame where CVD peaks EARLY (around min 30) but the
    last minute has LOWER CVD than the early peak — classic divergence.

    If ``divergent=False``, CVD trends with price (no divergence).
    """
    minutes = bars["ts"].to_list()
    rows = []
    for i, m in enumerate(minutes):
        if divergent:
            # Strong buy flow early (CVD ramps up), then heavy sell flow late
            # (CVD falls back) while price still climbs.
            if i < 30:
                buy, sell = 1000, 100
            else:
                buy, sell = 100, 1200
        else:
            buy, sell = 200 + i * 5, 200
        rows.append({"minute": m, "buy_vol": buy, "sell_vol": sell})
    return pd.DataFrame(rows)


def test_short_signal_on_classic_bearish_divergence(monkeypatch):
    bars = _bars_with_higher_high(n=60)
    tbbo = _tbbo_with_cvd_pattern(bars, divergent=True)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    ctx = _Setup6Context(conn=None)

    from setups_backtest.evaluators import setup_6_cvd_divergence as mod

    monkeypatch.setattr(mod, "_get_es_tbbo", lambda c, t: tbbo)

    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is not None
    assert sig.direction is Direction.SHORT
    last_close = float(bars.iloc[-1]["close"])
    assert sig.stop_price > last_close
    assert sig.target_price < last_close


def test_no_signal_when_no_divergence(monkeypatch):
    bars = _bars_with_higher_high(n=60)
    tbbo = _tbbo_with_cvd_pattern(bars, divergent=False)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    ctx = _Setup6Context(conn=None)

    from setups_backtest.evaluators import setup_6_cvd_divergence as mod

    monkeypatch.setattr(mod, "_get_es_tbbo", lambda c, t: tbbo)

    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None


def test_no_signal_when_tbbo_empty(monkeypatch):
    bars = _bars_with_higher_high(n=60)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    ctx = _Setup6Context(conn=None)

    from setups_backtest.evaluators import setup_6_cvd_divergence as mod

    monkeypatch.setattr(mod, "_get_es_tbbo", lambda c, t: pd.DataFrame())

    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None


def test_no_signal_when_history_too_short(monkeypatch):
    bars = _bars_with_higher_high(n=20)  # under MIN_HISTORY_FOR_DIVERGENCE
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    ctx = _Setup6Context(conn=None)
    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None
