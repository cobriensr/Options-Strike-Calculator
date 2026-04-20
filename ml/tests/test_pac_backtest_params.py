"""Tests for `pac_backtest.params.StrategyParams` validation."""

from __future__ import annotations

import pytest

from pac_backtest.params import (
    EntryTrigger,
    ExitTrigger,
    SessionFilter,
    StopPlacement,
    StrategyParams,
)


class TestStrategyParamsDefaults:
    def test_defaults_construct_cleanly(self):
        p = StrategyParams()
        assert p.entry_trigger == EntryTrigger.CHOCH_PLUS_REVERSAL
        assert p.exit_trigger == ExitTrigger.OPPOSITE_CHOCH
        assert p.stop_placement == StopPlacement.N_ATR
        assert p.contracts == 1
        assert p.commission_per_rt == 1.90
        assert p.tick_value_dollars == 0.50

    def test_frozen_dataclass_cannot_mutate(self):
        from dataclasses import FrozenInstanceError

        p = StrategyParams()
        with pytest.raises(FrozenInstanceError):
            p.contracts = 2  # type: ignore[misc]


class TestStrategyParamsValidation:
    def test_rejects_zero_contracts(self):
        with pytest.raises(ValueError, match="contracts must be >= 1"):
            StrategyParams(contracts=0)

    def test_rejects_negative_contracts(self):
        with pytest.raises(ValueError, match="contracts"):
            StrategyParams(contracts=-1)

    def test_rejects_zero_stop_multiple(self):
        with pytest.raises(ValueError, match="stop_atr_multiple"):
            StrategyParams(stop_atr_multiple=0)

    def test_rejects_negative_target(self):
        with pytest.raises(ValueError, match="target_atr_multiple"):
            StrategyParams(target_atr_multiple=-0.5)

    def test_rejects_negative_commission(self):
        with pytest.raises(ValueError, match="commission_per_rt"):
            StrategyParams(commission_per_rt=-1.0)

    def test_rejects_negative_slippage(self):
        with pytest.raises(ValueError, match="slippage_ticks"):
            StrategyParams(slippage_ticks=-0.1)

    def test_rejects_zero_tick_value(self):
        with pytest.raises(ValueError, match="tick_value_dollars"):
            StrategyParams(tick_value_dollars=0)


class TestSessionWindow:
    def test_rth_window(self):
        p = StrategyParams(session=SessionFilter.RTH)
        assert p.session_window_utc() == ("13:30", "20:00")

    def test_ny_open_window(self):
        p = StrategyParams(session=SessionFilter.NY_OPEN)
        assert p.session_window_utc() == ("13:30", "15:30")

    def test_rth_ex_lunch_uses_rth_bounds(self):
        """rth_ex_lunch uses same outer bounds as RTH — lunch is handled separately."""
        p = StrategyParams(session=SessionFilter.RTH_EX_LUNCH)
        assert p.session_window_utc() == ("13:30", "20:00")
