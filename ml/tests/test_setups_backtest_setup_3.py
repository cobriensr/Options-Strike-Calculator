"""Unit tests for Setup 3: overnight-extreme-sweep."""

from __future__ import annotations

import pandas as pd

from setups_backtest.evaluators.setup_3_overnight_sweep import (
    EVALUATOR,
    _Setup3Context,
)
from setups_backtest.harness import Direction


def _utc(ts: str) -> pd.Timestamp:
    return pd.Timestamp(ts, tz="UTC")


def _bars_15(rth_rows: list[tuple[float, float, float, float]]) -> pd.DataFrame:
    """Build a 15-row first-15min RTH frame from (open, high, low, close) tuples."""
    base = pd.Timestamp("2026-04-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
    rows = []
    for i, (o, h, lo, c) in enumerate(rth_rows):
        rows.append(
            (
                (base + pd.Timedelta(minutes=i)).isoformat(),
                o,
                h,
                lo,
                c,
                100,
            )
        )
    return pd.DataFrame(
        rows, columns=["ts", "open", "high", "low", "close", "volume"]
    ).assign(
        ts=lambda d: pd.to_datetime(d["ts"], utc=True),
        symbol="ESM6",
    )


def _eth_bars(low: float, high: float) -> pd.DataFrame:
    """Build a 60-row ETH session frame with given range bounds."""
    base = pd.Timestamp("2026-04-14 21:00", tz="UTC")
    rows = []
    for i in range(60):
        # alternate touching low and high to ensure the extremes hold
        if i == 5:
            rows.append((
                (base + pd.Timedelta(minutes=i)).isoformat(),
                low + 5, low + 5, low, low + 2, 100,
            ))
        elif i == 30:
            rows.append((
                (base + pd.Timedelta(minutes=i)).isoformat(),
                high - 5, high, high - 5, high - 2, 100,
            ))
        else:
            mid = (low + high) / 2
            rows.append((
                (base + pd.Timedelta(minutes=i)).isoformat(),
                mid, mid + 1, mid - 1, mid + 0.25, 100,
            ))
    return pd.DataFrame(
        rows, columns=["ts", "open", "high", "low", "close", "volume"]
    ).assign(ts=lambda d: pd.to_datetime(d["ts"], utc=True))


def test_fires_on_upside_sweep_then_revert(monkeypatch):
    """ETH range [5990, 6010]. First 15min sweeps to 6015 then reverts to 6005."""
    eth = _eth_bars(low=5990, high=6010)
    rth_rows = [(6000, 6005, 5998, 6002)] * 5 + [(6010, 6015, 6008, 6013)] + [(6010, 6013, 6000, 6005)] * 9
    bars = _bars_15(rth_rows)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_3_overnight_sweep as mod

    monkeypatch.setattr(mod.data_loaders, "load_ohlcv_range", lambda *a, **k: eth)

    ctx = _Setup3Context(conn=None)
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is not None
    assert sig.direction is Direction.SHORT
    assert sig.stop_price > sig.target_price  # SHORT: stop above, target below
    assert sig.target_price == pytest_approx_or_value(5990)
    assert sig.metadata["eth_high"] == 6010
    assert sig.metadata["rth_15m_high"] == 6015


def test_fires_on_downside_sweep_then_revert(monkeypatch):
    eth = _eth_bars(low=5990, high=6010)
    rth_rows = [(6000, 6002, 5998, 6000)] * 5 + [(5990, 5995, 5985, 5988)] + [(5990, 5995, 5988, 5995)] * 9
    bars = _bars_15(rth_rows)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_3_overnight_sweep as mod

    monkeypatch.setattr(mod.data_loaders, "load_ohlcv_range", lambda *a, **k: eth)

    ctx = _Setup3Context(conn=None)
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is not None
    assert sig.direction is Direction.LONG


def test_no_signal_when_no_sweep(monkeypatch):
    """First 15min stayed inside the ETH range — no sweep, no signal."""
    eth = _eth_bars(low=5990, high=6010)
    rth_rows = [(6000, 6005, 5995, 6000)] * 15
    bars = _bars_15(rth_rows)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_3_overnight_sweep as mod

    monkeypatch.setattr(mod.data_loaders, "load_ohlcv_range", lambda *a, **k: eth)

    ctx = _Setup3Context(conn=None)
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is None


def test_no_signal_when_swept_but_not_reverted(monkeypatch):
    """Sweep happened, but last close is still above the ETH range."""
    eth = _eth_bars(low=5990, high=6010)
    rth_rows = [(6000, 6005, 5998, 6002)] * 5 + [(6010, 6015, 6008, 6013)] * 10
    bars = _bars_15(rth_rows)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_3_overnight_sweep as mod

    monkeypatch.setattr(mod.data_loaders, "load_ohlcv_range", lambda *a, **k: eth)

    ctx = _Setup3Context(conn=None)
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is None


def test_econ_calendar_disqualifies(monkeypatch):
    """When today is in ctx.econ_dates, the signal must be skipped even if all
    other trigger conditions hold."""
    from datetime import date as date_cls

    eth = _eth_bars(low=5990, high=6010)
    rth_rows = [(6000, 6005, 5998, 6002)] * 5 + [(6010, 6015, 6008, 6013)] + [(6010, 6013, 6000, 6005)] * 9
    bars = _bars_15(rth_rows)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_3_overnight_sweep as mod

    monkeypatch.setattr(mod.data_loaders, "load_ohlcv_range", lambda *a, **k: eth)

    # Today (2026-04-15) is in econ_dates — should skip even though pattern holds.
    ctx = _Setup3Context(conn=None, econ_dates={date_cls(2026, 4, 15)})
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is None


def test_no_signal_when_bars_not_15(monkeypatch):
    """The evaluator must only fire on the exact minute 15 close."""
    eth = _eth_bars(low=5990, high=6010)
    rth_rows = [(6000, 6002, 5998, 6000)] * 10
    bars = _bars_15(rth_rows)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)

    from setups_backtest.evaluators import setup_3_overnight_sweep as mod

    monkeypatch.setattr(mod.data_loaders, "load_ohlcv_range", lambda *a, **k: eth)

    ctx = _Setup3Context(conn=None)
    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is None


def pytest_approx_or_value(v):
    """Helper so the test reads naturally — wrap with pytest.approx if installed."""
    import pytest

    return pytest.approx(v)
