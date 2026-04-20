"""Tests for options-feature filters in the backtest event loop."""

from __future__ import annotations

import numpy as np
import pandas as pd

from pac_backtest.loop import apply_options_filters, run_backtest
from pac_backtest.params import EntryTrigger, StrategyParams


def _make_bar(**overrides) -> pd.Series:
    """Synthetic single-bar Series with defaults for all optional feature cols."""
    defaults = {
        "ts_event": pd.Timestamp("2024-01-02 13:30:00+00:00"),
        "open": 100.0,
        "high": 100.5,
        "low": 99.5,
        "close": 100.0,
        "volume": 1000,
    }
    defaults.update(overrides)
    return pd.Series(defaults)


class TestApplyOptionsFilters:
    def test_no_filters_passes_by_default(self):
        """Default StrategyParams has no filters set — all bars allowed."""
        bar = _make_bar()
        allowed, reason = apply_options_filters(bar, StrategyParams())
        assert allowed is True
        assert reason is None

    def test_iv_tercile_filter_matches(self):
        bar = _make_bar(iv_tercile="low")
        params = StrategyParams(iv_tercile_filter="low")
        allowed, _ = apply_options_filters(bar, params)
        assert allowed is True

    def test_iv_tercile_filter_rejects_mismatch(self):
        bar = _make_bar(iv_tercile="high")
        params = StrategyParams(iv_tercile_filter="low")
        allowed, reason = apply_options_filters(bar, params)
        assert allowed is False
        assert "iv_tercile" in reason

    def test_iv_tercile_filter_skipped_when_column_missing(self):
        """No iv_tercile column on the bar → filter is a no-op (backward compat)."""
        bar = _make_bar()  # no iv_tercile key
        params = StrategyParams(iv_tercile_filter="low")
        allowed, _ = apply_options_filters(bar, params)
        assert allowed is True

    def test_iv_tercile_filter_skipped_when_value_nan(self):
        """NaN iv_tercile (e.g. pre-market-open bar) → filter passes."""
        bar = _make_bar(iv_tercile=np.nan)
        params = StrategyParams(iv_tercile_filter="low")
        allowed, _ = apply_options_filters(bar, params)
        assert allowed is True

    def test_skip_events_rejects_event_day(self):
        bar = _make_bar(is_event_day=True)
        params = StrategyParams(event_day_filter="skip_events")
        allowed, reason = apply_options_filters(bar, params)
        assert allowed is False
        assert "skip_events" in reason

    def test_skip_events_allows_non_event_day(self):
        bar = _make_bar(is_event_day=False)
        params = StrategyParams(event_day_filter="skip_events")
        allowed, _ = apply_options_filters(bar, params)
        assert allowed is True

    def test_events_only_rejects_non_event_day(self):
        bar = _make_bar(is_event_day=False)
        params = StrategyParams(event_day_filter="events_only")
        allowed, reason = apply_options_filters(bar, params)
        assert allowed is False
        assert "events_only" in reason

    def test_events_only_allows_event_day(self):
        bar = _make_bar(is_event_day=True)
        params = StrategyParams(event_day_filter="events_only")
        allowed, _ = apply_options_filters(bar, params)
        assert allowed is True

    def test_multiple_filters_all_must_pass(self):
        """IV matches but event filter rejects → overall rejection."""
        bar = _make_bar(iv_tercile="low", is_event_day=True)
        params = StrategyParams(
            iv_tercile_filter="low",
            event_day_filter="skip_events",
        )
        allowed, reason = apply_options_filters(bar, params)
        assert allowed is False
        assert "skip_events" in reason

    def test_multiple_filters_pass_when_both_match(self):
        bar = _make_bar(iv_tercile="low", is_event_day=False)
        params = StrategyParams(
            iv_tercile_filter="low",
            event_day_filter="skip_events",
        )
        allowed, _ = apply_options_filters(bar, params)
        assert allowed is True


def _synthetic_bars_with_signal(n: int = 50) -> pd.DataFrame:
    """Bars with a CHoCH+ entry signal at bar 5 and no other events."""
    ts = pd.date_range("2024-01-02 13:30", periods=n, freq="1min", tz="UTC")
    base = np.linspace(100.0, 110.0, n)
    df = pd.DataFrame(
        {
            "ts_event": ts,
            "open": base,
            "high": base + 0.5,
            "low": base - 0.5,
            "close": base,
            "volume": [100] * n,
            "HighLow": [np.nan] * n,
            "Level_shl": [np.nan] * n,
            "BOS": [np.nan] * n,
            "CHOCH": [np.nan] * n,
            "Level_bc": [np.nan] * n,
            "CHOCHPlus": [0] * n,
        }
    )
    df.loc[5, "CHOCH"] = 1
    df.loc[5, "CHOCHPlus"] = 1
    return df


class TestRunBacktestWithFilters:
    def test_filter_passes_entry_through_when_bar_matches(self):
        """IV filter set to 'low' + bar has iv_tercile='low' → entry fires."""
        bars = _synthetic_bars_with_signal()
        bars["iv_tercile"] = "low"
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            iv_tercile_filter="low",
        )
        trades = run_backtest(bars, params)
        assert len(trades) >= 1

    def test_filter_rejects_entry_when_bar_mismatches(self):
        """IV filter set to 'low' but bar has iv_tercile='high' → no trade."""
        bars = _synthetic_bars_with_signal()
        bars["iv_tercile"] = "high"
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            iv_tercile_filter="low",
        )
        trades = run_backtest(bars, params)
        assert len(trades) == 0

    def test_skip_events_filter_rejects_event_day_entry(self):
        """Event-day filter rejects entry on OPEX/FOMC day."""
        bars = _synthetic_bars_with_signal()
        bars["is_event_day"] = True
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            event_day_filter="skip_events",
        )
        trades = run_backtest(bars, params)
        assert len(trades) == 0

    def test_skip_events_allows_non_event_day_entry(self):
        bars = _synthetic_bars_with_signal()
        bars["is_event_day"] = False
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            event_day_filter="skip_events",
        )
        trades = run_backtest(bars, params)
        assert len(trades) >= 1

    def test_missing_overlay_columns_does_not_crash(self):
        """Bars without overlay columns should NOT crash when filters are set —
        filters degrade to no-op (backward compat)."""
        bars = _synthetic_bars_with_signal()
        # Intentionally omit iv_tercile / is_event_day columns
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            iv_tercile_filter="low",
            event_day_filter="skip_events",
        )
        trades = run_backtest(bars, params)
        # Entry fires because filters couldn't evaluate and fall through
        assert len(trades) >= 1
