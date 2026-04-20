"""Tests for `pac_backtest.metrics.compute_metrics`."""

from __future__ import annotations

import pandas as pd
import pytest

from pac_backtest.metrics import compute_metrics, metrics_to_dict
from pac_backtest.trades import Trade


def _closed_trade(
    exit_ts: str,
    entry_price: float,
    exit_price: float,
    direction: str = "long",
    contracts: int = 1,
    setup: str = "choch_plus_reversal",
) -> Trade:
    trade = Trade(
        entry_ts=pd.Timestamp(exit_ts) - pd.Timedelta(minutes=5),
        entry_price=entry_price,
        direction=direction,
        stop_price=entry_price - 1.0 if direction == "long" else entry_price + 1.0,
        setup_tag=setup,
        contracts=contracts,
        tick_value_dollars=0.50,
        commission_per_rt=1.90,
    )
    trade.close(
        exit_ts=pd.Timestamp(exit_ts),
        exit_price=exit_price,
        exit_reason="target_hit",
        bars_during_trade=pd.DataFrame(
            {
                "ts_event": [pd.Timestamp(exit_ts) - pd.Timedelta(minutes=i) for i in range(5)],
                "high": [max(entry_price, exit_price) + 0.1] * 5,
                "low": [min(entry_price, exit_price) - 0.1] * 5,
            }
        ),
    )
    return trade


class TestComputeMetrics:
    def test_empty_trade_list_returns_zero_metrics(self):
        m = compute_metrics([])
        assert m.trade_count == 0
        assert m.win_rate == 0.0
        assert m.total_pnl_dollars == 0.0

    def test_single_winner(self):
        t = _closed_trade("2024-01-02 13:40:00+00:00", 100.0, 102.0)
        m = compute_metrics([t])
        assert m.trade_count == 1
        assert m.wins == 1
        assert m.losses == 0
        assert m.win_rate == 1.0
        # gross = 2pt * 0.50 * 4 = $4; net = $4 - $1.90 = $2.10
        assert m.total_pnl_dollars == pytest.approx(2.10)
        assert m.profit_factor == 999.0  # no losses

    def test_single_loser(self):
        t = _closed_trade("2024-01-02 13:40:00+00:00", 100.0, 99.0)
        m = compute_metrics([t])
        assert m.losses == 1
        assert m.win_rate == 0.0
        # gross = -1pt * 0.50 * 4 = -$2; net = -$2 - $1.90 = -$3.90
        assert m.total_pnl_dollars == pytest.approx(-3.90)
        assert m.profit_factor == 0.0  # no wins

    def test_mixed_wins_and_losses(self):
        """2 winners, 1 loser on the same day."""
        t1 = _closed_trade("2024-01-02 13:40:00+00:00", 100.0, 101.0)  # +$0.10 net
        t2 = _closed_trade("2024-01-02 14:00:00+00:00", 100.0, 102.0)  # +$2.10
        t3 = _closed_trade("2024-01-02 14:30:00+00:00", 100.0, 99.0)   # -$3.90
        m = compute_metrics([t1, t2, t3])
        assert m.trade_count == 3
        assert m.wins == 2
        assert m.losses == 1
        assert m.win_rate == pytest.approx(2 / 3)
        assert m.profit_factor == pytest.approx((0.10 + 2.10) / 3.90)

    def test_max_drawdown_from_cumulative_curve(self):
        """Peak then trough — drawdown is trough minus peak."""
        # +$10 net win → peak, -$20 net loss → trough
        t1 = _closed_trade("2024-01-02 13:30:00+00:00", 100.0, 106.0)  # +$12 - $1.90 = $10.10
        t2 = _closed_trade("2024-01-02 14:30:00+00:00", 100.0, 90.0)  # -$20 - $1.90 = -$21.90
        m = compute_metrics([t1, t2])
        # Equity (anchored at $25K starting_equity):
        #   25_010.10 → peak, 24_988.20 → trough → drawdown -$21.90
        # DD% = -21.90 / 25_010.10 ≈ -0.000876 (near zero — as it should be on a $25K account)
        assert m.max_drawdown_dollars == pytest.approx(-21.90)
        assert m.max_drawdown_pct == pytest.approx(-21.90 / 25_010.10)

    def test_starting_equity_baseline_makes_dd_pct_meaningful(self):
        """A small loss against a tiny per-trade peak no longer reports a
        massive percentage — the bug that hid in folds 0-3 of the 6-month
        ES sweep (2024-07 → 2024-12) where a $-8 drawdown reported -54%.

        Helper math: 1 point = $2 net of commission per round trip
            (tick_value=0.50, 4 ticks/pt, commission $1.90).
        """
        # t1 long 100→130 = +30pt = +$60 gross − $1.90 = $58.10 net (peak)
        t1 = _closed_trade("2024-01-02 13:30:00+00:00", 100.0, 130.0)
        # t2 long 100→96 = −4pt = −$8 gross − $1.90 = −$9.90 net (drawdown leg)
        t2 = _closed_trade("2024-01-02 14:30:00+00:00", 100.0, 96.0)
        m_default = compute_metrics([t1, t2])
        # With $25K anchor: peak ≈ $25,058.10, DD = −$9.90 → DD% ≈ −0.04%
        assert m_default.max_drawdown_pct > -0.001
        # Unanchored behavior is recoverable by passing a tiny baseline:
        # peak = 1 + 58.10 = 59.10; dd_dollars = −9.90; dd_pct = −9.90/59.10
        m_tiny = compute_metrics([t1, t2], starting_equity_dollars=1.0)
        assert m_tiny.max_drawdown_pct == pytest.approx(
            -9.90 / 59.10, abs=1e-6
        )

    def test_sharpe_requires_at_least_two_days(self):
        """Sharpe from 1 day of P&L is undefined — defaults to 0."""
        t = _closed_trade("2024-01-02 13:30:00+00:00", 100.0, 102.0)
        m = compute_metrics([t])
        # Only 1 day in the series → no std → no annualization
        assert m.sharpe_annualized == 0.0

    def test_sharpe_positive_when_positive_daily_pnl(self):
        """Sharpe should be positive when mean daily P&L > 0 with defined std."""
        t1 = _closed_trade("2024-01-02 13:30:00+00:00", 100.0, 101.0)
        t2 = _closed_trade("2024-01-03 13:30:00+00:00", 100.0, 102.0)
        t3 = _closed_trade("2024-01-04 13:30:00+00:00", 100.0, 101.5)
        m = compute_metrics([t1, t2, t3])
        assert m.sharpe_annualized > 0

    def test_per_setup_tag_breakdown(self):
        t1 = _closed_trade("2024-01-02 13:30:00+00:00", 100.0, 102.0, setup="choch_plus_reversal")
        t2 = _closed_trade("2024-01-02 13:45:00+00:00", 100.0, 99.0, setup="bos_breakout")
        m = compute_metrics([t1, t2])
        assert "choch_plus_reversal" in m.by_setup_tag
        assert "bos_breakout" in m.by_setup_tag
        assert m.by_setup_tag["choch_plus_reversal"]["win_rate"] == 1.0
        assert m.by_setup_tag["bos_breakout"]["win_rate"] == 0.0


class TestMetricsSerialization:
    def test_to_dict_has_expected_keys(self):
        t = _closed_trade("2024-01-02 13:30:00+00:00", 100.0, 102.0)
        m = compute_metrics([t])
        d = metrics_to_dict(m)
        for k in (
            "trade_count",
            "win_rate",
            "profit_factor",
            "max_drawdown_dollars",
            "sharpe_annualized",
            "expectancy_dollars",
        ):
            assert k in d
