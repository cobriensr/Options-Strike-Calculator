"""Tests for setups_backtest.metrics — pure metric computation on trade logs."""

from __future__ import annotations

import pandas as pd
import pytest

from setups_backtest import metrics
from setups_backtest.metrics import _max_consecutive


def _utc(ts: str) -> pd.Timestamp:
    return pd.Timestamp(ts, tz="UTC")


def _make_trades(pnls: list[float], starts: list[str] | None = None) -> pd.DataFrame:
    if starts is None:
        starts = [
            (
                pd.Timestamp("2026-01-05", tz="UTC")
                + pd.Timedelta(days=i, hours=14)
            ).isoformat()
            for i in range(len(pnls))
        ]
    n = len(pnls)
    return pd.DataFrame(
        {
            "setup_name": ["test"] * n,
            "direction": ["LONG"] * n,
            "contract": ["ESM6"] * n,
            "entry_ts": [_utc(s) for s in starts],
            "exit_ts": [_utc(s) + pd.Timedelta(minutes=30) for s in starts],
            "entry_price": [5000.0] * n,
            "exit_price": [5005.0 if p > 0 else 4995.0 for p in pnls],
            "stop_price": [4995.0] * n,
            "target_price": [5010.0] * n,
            "exit_reason": ["TARGET" if p > 0 else "STOP" for p in pnls],
            "gross_pnl_dollars": pnls,
            "net_pnl_dollars": pnls,
            "r_multiple": [p / 250.0 for p in pnls],
        }
    )


def test_compute_metrics_empty():
    m = metrics.compute_metrics(pd.DataFrame())
    assert m["n_signals"] == 0
    assert m["win_rate"] is None
    assert m["cumulative_net_pnl_dollars"] == 0.0


def test_compute_metrics_basic_win_rate():
    trades = _make_trades([200.0, -100.0, 200.0, -100.0])
    m = metrics.compute_metrics(trades)
    assert m["n_signals"] == 4
    assert m["n_wins"] == 2
    assert m["n_losses"] == 2
    assert m["win_rate"] == 0.5
    assert m["expectancy_dollars"] == pytest.approx(50.0)
    # 400 win / 200 loss = 2.0 profit factor.
    assert m["profit_factor"] == pytest.approx(2.0)
    assert m["cumulative_net_pnl_dollars"] == pytest.approx(200.0)


def test_max_consecutive_losers():
    # Run: W L L L W L L W
    losses = [False, True, True, True, False, True, True, False]
    assert _max_consecutive(losses) == 3


def test_max_drawdown_dollars_and_pct():
    # Equity: +100, +50 (=150), -200 (=-50, drawdown 200 from peak 150).
    trades = _make_trades([100.0, 50.0, -200.0])
    m = metrics.compute_metrics(trades)
    assert m["max_drawdown_dollars"] == pytest.approx(-200.0)
    # Peak at -200's idxmin is 150, so drawdown % = -200/150*100 = -133.3%.
    assert m["max_drawdown_pct"] == pytest.approx(-200.0 / 150.0 * 100.0, rel=1e-3)


def test_time_of_day_bucket():
    # All trades at 14:00 UTC = 30 minutes after RTH open → 14:00-14:30 bucket.
    trades = _make_trades(
        [100.0, -50.0, 100.0],
        starts=["2026-01-05 14:00", "2026-01-05 14:10", "2026-01-05 14:20"],
    )
    m = metrics.compute_metrics(trades)
    tod = m["time_of_day"]
    assert tod["14:00-14:30"]["n"] == 3
    assert tod["14:00-14:30"]["win_rate"] == pytest.approx(2 / 3)


def test_format_report_zero_signals():
    md = metrics.format_report("test-setup", metrics.compute_metrics(pd.DataFrame()),
                                ("2026-01-01", "2026-04-17"))
    assert "No signals fired" in md
    assert "test-setup" in md


def test_format_report_with_signals():
    trades = _make_trades([200.0, -100.0, 200.0, -100.0])
    m = metrics.compute_metrics(trades)
    md = metrics.format_report("test-setup", m, ("2026-01-01", "2026-04-17"))
    assert "Win rate" in md
    assert "Expectancy" in md
    assert "test-setup" in md


def test_sharpe_returns_nan_for_single_day():
    trades = _make_trades([100.0])
    m = metrics.compute_metrics(trades)
    assert m["sharpe_signal_days"] is None  # NaN-to-None conversion
