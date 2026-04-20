"""Tests for `pac_backtest.trades.Trade`."""

from __future__ import annotations

import pandas as pd
import pytest

from pac_backtest.trades import Trade, trades_to_dataframe


def _mini_bars_between(ts_start: str, ts_end: str, highs: list[float], lows: list[float]) -> pd.DataFrame:
    n = len(highs)
    ts = pd.date_range(ts_start, ts_end, periods=n, tz="UTC")
    return pd.DataFrame({"ts_event": ts, "high": highs, "low": lows})


class TestTradeClose:
    def test_long_winner_pnl(self):
        """Long from 100 to 102, 4 ticks/pt × $0.50 = $2/pt × 1 contract × 2pt = $4, minus $1.90 comm = $2.10."""
        trade = Trade(
            entry_ts=pd.Timestamp("2024-01-02 13:30:00+00:00"),
            entry_price=100.0,
            direction="long",
            stop_price=99.0,
            setup_tag="choch_plus_reversal",
            contracts=1,
            tick_value_dollars=0.50,
            commission_per_rt=1.90,
        )
        during = _mini_bars_between(
            "2024-01-02 13:31:00+00:00",
            "2024-01-02 13:32:00+00:00",
            highs=[102.0, 102.5],
            lows=[99.5, 101.5],
        )
        trade.close(
            exit_ts=pd.Timestamp("2024-01-02 13:32:00+00:00"),
            exit_price=102.0,
            exit_reason="target_hit",
            bars_during_trade=during,
        )
        assert trade.status == "closed"
        assert trade.pnl_points == pytest.approx(2.0)
        # gross = 2 pt * 0.50 tick_value * 4 ticks_per_pt = $4.00
        assert trade.pnl_dollars == pytest.approx(4.00 - 1.90)
        assert trade.duration_minutes == 2

    def test_short_winner(self):
        """Short from 100 to 98 yields +2 points."""
        trade = Trade(
            entry_ts=pd.Timestamp("2024-01-02 13:30:00+00:00"),
            entry_price=100.0,
            direction="short",
            stop_price=101.0,
            setup_tag="bos_breakout",
            contracts=1,
            tick_value_dollars=0.50,
            commission_per_rt=1.90,
        )
        during = _mini_bars_between(
            "2024-01-02 13:31:00+00:00",
            "2024-01-02 13:32:00+00:00",
            highs=[100.5, 99.5],
            lows=[98.0, 97.5],
        )
        trade.close(
            exit_ts=pd.Timestamp("2024-01-02 13:32:00+00:00"),
            exit_price=98.0,
            exit_reason="opposite_choch",
            bars_during_trade=during,
        )
        assert trade.pnl_points == pytest.approx(2.0)
        assert trade.pnl_dollars == pytest.approx(4.00 - 1.90)

    def test_long_loser(self):
        """Long from 100 to 99 yields -1 point."""
        trade = Trade(
            entry_ts=pd.Timestamp("2024-01-02 13:30:00+00:00"),
            entry_price=100.0,
            direction="long",
            stop_price=99.0,
            setup_tag="choch_plus_reversal",
            contracts=1,
            tick_value_dollars=0.50,
            commission_per_rt=1.90,
        )
        during = _mini_bars_between(
            "2024-01-02 13:31:00+00:00",
            "2024-01-02 13:32:00+00:00",
            highs=[100.2, 99.8],
            lows=[99.0, 98.9],
        )
        trade.close(
            exit_ts=pd.Timestamp("2024-01-02 13:32:00+00:00"),
            exit_price=99.0,
            exit_reason="stop_hit",
            bars_during_trade=during,
        )
        assert trade.pnl_points == pytest.approx(-1.0)
        # gross = -1 * 0.50 * 4 = -$2.00, minus $1.90 commission = -$3.90
        assert trade.pnl_dollars == pytest.approx(-2.00 - 1.90)

    def test_mae_mfe_long(self):
        """Long trade: MAE = worst low, MFE = best high."""
        trade = Trade(
            entry_ts=pd.Timestamp("2024-01-02 13:30:00+00:00"),
            entry_price=100.0,
            direction="long",
            stop_price=95.0,
            setup_tag="choch",
            contracts=1,
        )
        during = _mini_bars_between(
            "2024-01-02 13:31:00+00:00",
            "2024-01-02 13:33:00+00:00",
            highs=[101.0, 103.5, 102.0],
            lows=[99.5, 100.0, 98.5],
        )
        trade.close(
            exit_ts=pd.Timestamp("2024-01-02 13:33:00+00:00"),
            exit_price=102.0,
            exit_reason="target_hit",
            bars_during_trade=during,
        )
        assert trade.mae_price == pytest.approx(98.5)  # lowest low
        assert trade.mfe_price == pytest.approx(103.5)  # highest high

    def test_mae_mfe_short_is_inverted(self):
        """Short trade: MAE = worst high, MFE = best low."""
        trade = Trade(
            entry_ts=pd.Timestamp("2024-01-02 13:30:00+00:00"),
            entry_price=100.0,
            direction="short",
            stop_price=103.0,
            setup_tag="bos_breakout",
            contracts=1,
        )
        during = _mini_bars_between(
            "2024-01-02 13:31:00+00:00",
            "2024-01-02 13:33:00+00:00",
            highs=[102.0, 101.5, 100.5],
            lows=[98.0, 97.0, 98.5],
        )
        trade.close(
            exit_ts=pd.Timestamp("2024-01-02 13:33:00+00:00"),
            exit_price=98.0,
            exit_reason="target_hit",
            bars_during_trade=during,
        )
        assert trade.mae_price == pytest.approx(102.0)  # highest high
        assert trade.mfe_price == pytest.approx(97.0)  # lowest low

    def test_cannot_close_twice(self):
        trade = Trade(
            entry_ts=pd.Timestamp("2024-01-02 13:30:00+00:00"),
            entry_price=100.0,
            direction="long",
            stop_price=99.0,
            setup_tag="x",
            contracts=1,
        )
        during = _mini_bars_between(
            "2024-01-02 13:31:00+00:00",
            "2024-01-02 13:31:00+00:00",
            highs=[100.5],
            lows=[99.5],
        )
        trade.close(
            exit_ts=pd.Timestamp("2024-01-02 13:31:00+00:00"),
            exit_price=100.0,
            exit_reason="stop_hit",
            bars_during_trade=during,
        )
        with pytest.raises(ValueError, match="already closed"):
            trade.close(
                exit_ts=pd.Timestamp("2024-01-02 13:32:00+00:00"),
                exit_price=101.0,
                exit_reason="target_hit",
                bars_during_trade=during,
            )

    def test_zero_bar_trade(self):
        """Same-bar fill-to-stop should still compute MAE/MFE bounds."""
        trade = Trade(
            entry_ts=pd.Timestamp("2024-01-02 13:30:00+00:00"),
            entry_price=100.0,
            direction="long",
            stop_price=99.5,
            setup_tag="x",
            contracts=1,
        )
        empty = _mini_bars_between(
            "2024-01-02 13:30:00+00:00", "2024-01-02 13:30:00+00:00", [], []
        )
        trade.close(
            exit_ts=pd.Timestamp("2024-01-02 13:30:00+00:00"),
            exit_price=99.5,
            exit_reason="stop_hit",
            bars_during_trade=empty,
        )
        # Fallback uses entry/exit as bounds
        assert trade.mae_price == 99.5
        assert trade.mfe_price == 100.0


class TestTradesToDataFrame:
    def test_empty_list_produces_empty_df(self):
        df = trades_to_dataframe([])
        assert len(df) == 0

    def test_row_per_trade(self):
        trade = Trade(
            entry_ts=pd.Timestamp("2024-01-02 13:30:00+00:00"),
            entry_price=100.0,
            direction="long",
            stop_price=99.0,
            setup_tag="x",
            contracts=1,
        )
        during = _mini_bars_between(
            "2024-01-02 13:31:00+00:00", "2024-01-02 13:32:00+00:00", [101.0, 102.0], [99.5, 100.5]
        )
        trade.close(
            exit_ts=pd.Timestamp("2024-01-02 13:32:00+00:00"),
            exit_price=102.0,
            exit_reason="target_hit",
            bars_during_trade=during,
        )
        df = trades_to_dataframe([trade, trade])
        assert len(df) == 2
        assert "entry_ts" in df.columns
        assert "pnl_dollars" in df.columns
