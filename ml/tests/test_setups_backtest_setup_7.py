"""Unit tests for Setup 7: flight-to-safety-continuation."""

from __future__ import annotations

import pandas as pd

from setups_backtest.evaluators.setup_7_flight_to_safety import (
    EVALUATOR,
    _Setup7Context,
)
from setups_backtest.harness import Direction


def _utc(ts: str) -> pd.Timestamp:
    return pd.Timestamp(ts, tz="UTC")


def _es_bars_down(n: int = 60, peak: float = 6100.0) -> pd.DataFrame:
    """Build an ES session with a peak early then a sharp decline. The last
    30 minutes show a ~-0.5% move to satisfy the -0.3% trigger threshold."""
    start = pd.Timestamp("2026-04-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
    rows = []
    for i in range(n):
        if i < 10:
            p = peak + i * 0.1
        elif i < 30:
            p = peak + 1.0 - (i - 10) * 0.3  # gentle decline
        else:
            # Sharper decline in the last 30 min — ~0.5% drop
            p = peak + 1.0 - 20 * 0.3 - (i - 30) * 1.5
        rows.append(
            (
                (start + pd.Timedelta(minutes=i)).isoformat(),
                p,
                p + 1.0,
                p - 1.0,
                p,
                100,
            )
        )
    return pd.DataFrame(
        rows, columns=["ts", "open", "high", "low", "close", "volume"]
    ).assign(ts=lambda d: pd.to_datetime(d["ts"], utc=True), symbol="ESM6")


def _cross_asset_bars(start_price: float, end_price: float, ts_anchor: pd.Timestamp, n: int = 30) -> pd.DataFrame:
    """Build a 1m bar frame linearly ramping start → end across n minutes
    ending just before ``ts_anchor``."""
    rows = []
    for i in range(n):
        ts = ts_anchor - pd.Timedelta(minutes=n - i)
        p = start_price + (end_price - start_price) * (i / max(n - 1, 1))
        rows.append({"ts": ts, "close": p})
    return pd.DataFrame(rows)


def test_no_signal_when_data_unavailable():
    bars = _es_bars_down()
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    ctx = _Setup7Context(
        conn=None,
        pg=None,
        zn_bars=pd.DataFrame(),
        gc_bars=pd.DataFrame(),
        data_available=False,
        unavailable_reason="test",
    )
    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None


def test_signal_fires_on_classic_flight_pattern(monkeypatch):
    """ZN +0.6%, GC +0.6%, ES -0.4% within 30m, recent peak < 2h ago."""
    bars = _es_bars_down(n=60, peak=6100.0)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    zn = _cross_asset_bars(110.0, 110.66, decision_ts, n=30)  # +0.6%
    gc = _cross_asset_bars(2000.0, 2012.0, decision_ts, n=30)  # +0.6%

    from setups_backtest.evaluators import setup_7_flight_to_safety as mod

    # Set prior_close low enough that the target (prior - 1×ATR) lands BELOW
    # the current ES close. In production, prior close is typically near
    # session open and ATR is large, so this happens naturally; the synthetic
    # data here needs an explicit nudge.
    last_close = float(bars.iloc[-1]["close"])
    monkeypatch.setattr(mod, "_get_prior_close", lambda *a, **k: last_close - 5.0)

    ctx = _Setup7Context(
        conn=None,
        pg=None,
        zn_bars=zn,
        gc_bars=gc,
        data_available=True,
    )
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is not None
    assert sig.direction is Direction.SHORT
    assert sig.stop_price > last_close
    assert sig.target_price < last_close


def test_no_signal_when_zn_quiet(monkeypatch):
    bars = _es_bars_down()
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    zn = _cross_asset_bars(110.0, 110.05, decision_ts, n=30)  # +0.05% only
    gc = _cross_asset_bars(2000.0, 2012.0, decision_ts, n=30)

    from setups_backtest.evaluators import setup_7_flight_to_safety as mod

    monkeypatch.setattr(mod, "_get_prior_close", lambda *a, **k: 6105.0)

    ctx = _Setup7Context(
        conn=None,
        pg=None,
        zn_bars=zn,
        gc_bars=gc,
        data_available=True,
    )
    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None


def test_no_signal_when_es_not_declining_enough(monkeypatch):
    # ES barely down — flat session.
    start = pd.Timestamp("2026-04-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
    rows = [
        (
            (start + pd.Timedelta(minutes=i)).isoformat(),
            6100.0, 6100.5, 6099.5, 6100.0, 100,
        )
        for i in range(60)
    ]
    bars = pd.DataFrame(
        rows, columns=["ts", "open", "high", "low", "close", "volume"]
    ).assign(ts=lambda d: pd.to_datetime(d["ts"], utc=True), symbol="ESM6")
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    zn = _cross_asset_bars(110.0, 110.66, decision_ts, n=30)
    gc = _cross_asset_bars(2000.0, 2012.0, decision_ts, n=30)

    from setups_backtest.evaluators import setup_7_flight_to_safety as mod

    monkeypatch.setattr(mod, "_get_prior_close", lambda *a, **k: 6105.0)

    ctx = _Setup7Context(
        conn=None,
        pg=None,
        zn_bars=zn,
        gc_bars=gc,
        data_available=True,
    )
    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None
