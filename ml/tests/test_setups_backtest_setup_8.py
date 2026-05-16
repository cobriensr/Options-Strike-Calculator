"""Unit tests for Setup 8: mega-cap-earnings-fade."""

from __future__ import annotations

from datetime import date

import pandas as pd

from setups_backtest.evaluators.setup_8_mega_cap_earnings import (
    EVALUATOR,
    _Setup8Context,
)
from setups_backtest.harness import Direction


def _ib_bars(open_price: float, n: int = 10) -> pd.DataFrame:
    """First-10min NQ bars: gap holds — price stays elevated above open with
    a higher high at bar 2, then drifts modestly. For the fade-to-VWAP trade
    to make sense, current must still be ABOVE VWAP at minute 10."""
    start = pd.Timestamp("2026-04-15", tz="UTC") + pd.Timedelta(hours=13, minutes=30)
    rows = []
    for i in range(n):
        if i == 0:
            o, h, lo, c = open_price, open_price + 2, open_price - 1, open_price + 2
        elif i == 1:
            o, h, lo, c = open_price + 2, open_price + 5, open_price + 1, open_price + 4
        else:
            # Higher base — sits above the open-area VWAP
            base = open_price + 3
            o = base
            h = base + 1
            lo = base - 0.5
            c = base + 0.5
        rows.append(
            (
                (start + pd.Timedelta(minutes=i)).isoformat(),
                o, h, lo, c, 100,
            )
        )
    return pd.DataFrame(
        rows, columns=["ts", "open", "high", "low", "close", "volume"]
    ).assign(ts=lambda d: pd.to_datetime(d["ts"], utc=True), symbol="NQM6")


def test_no_signal_when_data_unavailable():
    bars = _ib_bars(open_price=20100.0)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    ctx = _Setup8Context(
        conn=None,
        pg=None,
        earnings_dates=set(),
        data_available=False,
    )
    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None


def test_short_signal_on_gap_up_earnings_day(monkeypatch):
    bars = _ib_bars(open_price=20150.0)  # +0.75% gap from 20000
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    ctx = _Setup8Context(
        conn=None,
        pg=None,
        earnings_dates={date(2026, 4, 15)},
        data_available=True,
    )

    from setups_backtest.evaluators import setup_8_mega_cap_earnings as mod

    monkeypatch.setattr(mod, "_get_prior_nq_close", lambda *a, **k: 20000.0)

    sig = EVALUATOR.evaluate_minute(decision_ts, ctx, bars)
    assert sig is not None
    assert sig.direction is Direction.SHORT
    last_close = float(bars.iloc[-1]["close"])
    assert sig.stop_price > last_close
    assert sig.target_price < last_close


def test_no_signal_when_not_earnings_day(monkeypatch):
    bars = _ib_bars(open_price=20100.0)
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    ctx = _Setup8Context(
        conn=None,
        pg=None,
        earnings_dates={date(2026, 4, 16)},  # different day
        data_available=True,
    )

    from setups_backtest.evaluators import setup_8_mega_cap_earnings as mod

    monkeypatch.setattr(mod, "_get_prior_nq_close", lambda *a, **k: 20000.0)

    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None


def test_no_signal_when_gap_too_small(monkeypatch):
    bars = _ib_bars(open_price=20020.0)  # only 0.1% gap
    decision_ts = bars["ts"].iloc[-1] + pd.Timedelta(minutes=1)
    ctx = _Setup8Context(
        conn=None,
        pg=None,
        earnings_dates={date(2026, 4, 15)},
        data_available=True,
    )

    from setups_backtest.evaluators import setup_8_mega_cap_earnings as mod

    monkeypatch.setattr(mod, "_get_prior_nq_close", lambda *a, **k: 20000.0)

    assert EVALUATOR.evaluate_minute(decision_ts, ctx, bars) is None
