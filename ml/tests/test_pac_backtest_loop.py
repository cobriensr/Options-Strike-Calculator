"""Tests for `pac_backtest.loop` — end-to-end event loop on synthetic and real data."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pac_backtest.loop import compute_atr, run_backtest, session_window_mask
from pac_backtest.params import (
    EntryTrigger,
    ExitTrigger,
    SessionFilter,
    StopPlacement,
    StrategyParams,
)


def _synthetic_enriched_bars(n: int = 100) -> pd.DataFrame:
    """Build a synthetic PAC-enriched bar DataFrame for unit tests."""
    ts = pd.date_range("2024-01-02 13:30", periods=n, freq="1min", tz="UTC")
    base = np.linspace(100.0, 110.0, n)
    return pd.DataFrame(
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


class TestComputeAtr:
    def test_atr_is_nonnegative(self):
        bars = _synthetic_enriched_bars(50)
        atr = compute_atr(bars, period=14)
        assert (atr >= 0).all()

    def test_atr_aligned_to_bars(self):
        bars = _synthetic_enriched_bars(30)
        atr = compute_atr(bars)
        assert len(atr) == len(bars)


class TestSessionWindowMask:
    def test_rth_mask_covers_13_30_to_20_00_utc(self):
        bars = _synthetic_enriched_bars(400)  # covers >6 hours from 13:30
        mask = session_window_mask(bars, SessionFilter.RTH)
        # All bars from our fixture start at 13:30 UTC, so all within RTH should be True.
        # After 20:00 UTC (bar ~390 in 1m cadence), mask should go False.
        in_rth = bars[mask]
        # First bar of RTH is 13:30, last should be before 20:00
        assert in_rth["ts_event"].iloc[0].hour == 13
        assert in_rth["ts_event"].iloc[0].minute == 30
        assert in_rth["ts_event"].iloc[-1].hour < 20

    def test_ny_open_mask_is_narrower(self):
        bars = _synthetic_enriched_bars(400)
        rth_count = int(session_window_mask(bars, SessionFilter.RTH).sum())
        ny_count = int(session_window_mask(bars, SessionFilter.NY_OPEN).sum())
        assert ny_count < rth_count

    def test_rth_ex_lunch_excludes_17_utc(self):
        bars = _synthetic_enriched_bars(400)
        mask = session_window_mask(bars, SessionFilter.RTH_EX_LUNCH)
        # No 17:xx UTC bar should be in the mask
        bars_in_mask = bars[mask]
        assert (bars_in_mask["ts_event"].dt.hour != 17).all()


class TestRunBacktest:
    def test_missing_columns_raises(self):
        bars = pd.DataFrame({"ts_event": [], "open": []})
        with pytest.raises(KeyError, match="missing required columns"):
            run_backtest(bars, StrategyParams())

    def test_empty_bars_produces_no_trades(self):
        bars = _synthetic_enriched_bars(0)
        # Even empty, the required columns are present
        trades = run_backtest(bars, StrategyParams())
        assert trades == []

    def test_no_signals_produces_no_trades(self):
        """A bar set with no CHOCH/BOS events should produce zero trades."""
        bars = _synthetic_enriched_bars(100)
        trades = run_backtest(bars, StrategyParams())
        assert len(trades) == 0

    def test_single_choch_plus_fires_one_long_trade(self):
        """A bullish CHoCH+ at bar 5 should produce one long trade."""
        bars = _synthetic_enriched_bars(50)
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1
        bars.loc[5, "Level_bc"] = float(bars.loc[5, "close"])

        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            exit_trigger=ExitTrigger.OPPOSITE_CHOCH,
            stop_placement=StopPlacement.N_ATR,
            stop_atr_multiple=1.5,
            session=SessionFilter.RTH,
        )
        trades = run_backtest(bars, params)
        assert len(trades) >= 1
        t = trades[0]
        assert t.direction == "long"
        assert t.setup_tag == "choch_plus_reversal"

    def test_stop_hit_closes_trade(self):
        """Insert a CHoCH+ entry then a bar whose low crashes below the stop."""
        bars = _synthetic_enriched_bars(20)
        # Entry signal at bar 5
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1
        # Bar 7 crashes: low goes far below entry → stop hits
        bars.loc[7, "low"] = 50.0
        bars.loc[7, "high"] = 55.0

        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            stop_atr_multiple=1.5,
            stop_placement=StopPlacement.N_ATR,
        )
        trades = run_backtest(bars, params)
        assert len(trades) == 1
        assert trades[0].exit_reason == "stop_hit"

    def test_one_position_at_a_time(self):
        """Multiple CHoCH+ signals in quick succession should NOT produce
        overlapping trades — only the first fires, the second waits until exit.
        """
        bars = _synthetic_enriched_bars(50)
        # Two bullish CHoCH+ events within 3 bars
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1
        bars.loc[7, "CHOCH"] = 1
        bars.loc[7, "CHOCHPlus"] = 1

        params = StrategyParams()
        trades = run_backtest(bars, params)
        # If the second signal fired a new trade, we'd have 2 overlapping trades.
        # The event loop must gate new entries on open_trade is None.
        # Both trades (if any) should have non-overlapping [entry_ts, exit_ts].
        for i in range(len(trades) - 1):
            assert trades[i].exit_ts <= trades[i + 1].entry_ts


_ARCHIVE_ROOT = Path(__file__).resolve().parents[1] / "data" / "archive"
_ARCHIVE_MISSING = not (_ARCHIVE_ROOT / "ohlcv_1m").exists()


@pytest.mark.skipif(_ARCHIVE_MISSING, reason="Archive not present")
class TestRunBacktestOnRealData:
    """End-to-end integration — the 2026-04-17 journal day smoke test."""

    def test_journal_day_produces_at_least_one_trade(self):
        import os

        os.environ.setdefault("SMC_CREDIT", "0")
        from pac.archive_loader import load_bars, reset_connection_for_tests
        from pac.engine import PACEngine, PACParams

        reset_connection_for_tests()
        bars = load_bars("NQ", "2026-04-17", "2026-04-18")
        enriched = PACEngine(PACParams(swing_length=5)).batch_state(bars)

        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            exit_trigger=ExitTrigger.OPPOSITE_CHOCH,
            stop_placement=StopPlacement.N_ATR,
            stop_atr_multiple=1.5,
            session=SessionFilter.RTH,
        )
        trades = run_backtest(enriched, params)
        # Journal day has multiple CHoCH+ events during RTH — expect 1+ trades
        assert len(trades) >= 1

    def test_every_real_trade_has_all_fields_populated(self):
        import os

        os.environ.setdefault("SMC_CREDIT", "0")
        from pac.archive_loader import load_bars, reset_connection_for_tests
        from pac.engine import PACEngine

        reset_connection_for_tests()
        bars = load_bars("NQ", "2026-04-17", "2026-04-18")
        enriched = PACEngine().batch_state(bars)
        trades = run_backtest(enriched, StrategyParams())

        for t in trades:
            assert t.status == "closed"
            assert t.entry_ts is not None
            assert t.exit_ts is not None
            assert t.entry_price is not None
            assert t.exit_price is not None
            assert t.exit_reason is not None
            assert t.pnl_dollars is not None
            assert t.mae_price is not None
            assert t.mfe_price is not None
