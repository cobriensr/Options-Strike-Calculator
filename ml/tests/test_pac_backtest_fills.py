"""Tests for `pac_backtest.fills`."""

from __future__ import annotations

import pandas as pd
import pytest

from pac_backtest.fills import (
    apply_slippage,
    compute_fill_price,
    next_bar_open_price,
)
from pac_backtest.params import StrategyParams


def _mini_bars(opens: list[float]) -> pd.DataFrame:
    ts = pd.date_range("2024-01-02 13:30", periods=len(opens), freq="1min", tz="UTC")
    return pd.DataFrame(
        {
            "ts_event": ts,
            "open": opens,
            "high": [o + 0.5 for o in opens],
            "low": [o - 0.5 for o in opens],
            "close": opens,
            "volume": [100] * len(opens),
        }
    )


class TestNextBarOpen:
    def test_returns_next_bar_open(self):
        bars = _mini_bars([100.0, 101.0, 102.0])
        assert next_bar_open_price(bars, 0) == 101.0
        assert next_bar_open_price(bars, 1) == 102.0

    def test_returns_none_at_last_bar(self):
        bars = _mini_bars([100.0, 101.0])
        assert next_bar_open_price(bars, 1) is None

    def test_empty_bars_returns_none(self):
        empty = pd.DataFrame({"open": []})
        assert next_bar_open_price(empty, 0) is None


class TestApplySlippage:
    def test_entry_long_shifts_up(self):
        """Buying = paying the ask = price shifts up by slippage."""
        assert apply_slippage(100.0, "entry_long", 1.0, tick_size=0.25) == 100.25

    def test_entry_short_shifts_down(self):
        """Selling short = hitting the bid = price shifts down."""
        assert apply_slippage(100.0, "entry_short", 1.0, tick_size=0.25) == 99.75

    def test_exit_long_shifts_down(self):
        """Exiting long = selling = hitting the bid = price shifts down."""
        assert apply_slippage(100.0, "exit_long", 1.0, tick_size=0.25) == 99.75

    def test_exit_short_shifts_up(self):
        """Covering short = buying = paying the ask = price shifts up."""
        assert apply_slippage(100.0, "exit_short", 1.0, tick_size=0.25) == 100.25

    def test_zero_slippage(self):
        """Zero-slippage returns the raw price regardless of side."""
        for side in ("entry_long", "entry_short", "exit_long", "exit_short"):
            assert apply_slippage(100.0, side, 0.0) == 100.0  # type: ignore[arg-type]

    def test_fractional_slippage(self):
        """Half-tick slippage is common for market orders."""
        assert apply_slippage(100.0, "entry_long", 0.5, tick_size=0.25) == 100.125

    def test_unknown_side_raises(self):
        with pytest.raises(ValueError, match="Unknown fill side"):
            apply_slippage(100.0, "bad_side", 1.0)  # type: ignore[arg-type]


class TestComputeFillPrice:
    def test_entry_long_next_open_plus_slippage(self):
        bars = _mini_bars([100.0, 101.0, 102.0])
        params = StrategyParams(slippage_ticks=1.0)
        # Signal at bar 0 → fill at bar 1 open (101.0) + slippage (0.25) = 101.25
        assert compute_fill_price(bars, 0, "entry_long", params) == 101.25

    def test_exit_short_pays_offer(self):
        bars = _mini_bars([100.0, 101.0])
        params = StrategyParams(slippage_ticks=2.0)
        # Bar 1's open = 101.0, exit_short shifts up 2*0.25 = 0.5 → 101.5
        assert compute_fill_price(bars, 0, "exit_short", params) == 101.5

    def test_last_bar_returns_none(self):
        bars = _mini_bars([100.0, 101.0])
        params = StrategyParams()
        assert compute_fill_price(bars, 1, "entry_long", params) is None
