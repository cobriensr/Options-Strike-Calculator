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

    def test_entry_features_populated_from_signal_bar(self):
        """E1.4d Phase 2 — Trade.entry_features captures context columns
        that exist on the signal bar at entry time."""
        bars = _synthetic_enriched_bars(50)
        # Add a few of the E1.4d feature columns. Loop should pick them up.
        bars["session_bucket"] = "ny_open"
        bars["adx_14"] = 25.0
        bars["z_close_vwap"] = 1.5
        bars["is_event_day"] = False
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1

        trades = run_backtest(
            bars,
            StrategyParams(entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL),
        )
        assert len(trades) >= 1
        ef = trades[0].entry_features
        assert ef["session_bucket"] == "ny_open"
        assert ef["adx_14"] == 25.0
        assert ef["z_close_vwap"] == 1.5
        assert ef["is_event_day"] is False

    def test_entry_features_partial_when_columns_missing(self):
        """If the bar frame doesn't have E1.4d columns (legacy fixture),
        entry_features is just an empty dict — no crash."""
        bars = _synthetic_enriched_bars(50)
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1
        trades = run_backtest(
            bars,
            StrategyParams(entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL),
        )
        assert len(trades) >= 1
        # No new columns on this fixture → snapshot is empty
        assert trades[0].entry_features == {}


# ─────────────────────────────────────────────────────────────────────────
# E1.4d Phase 3 — opposite-signal handling, BoS-count exit, v4 filters
# ─────────────────────────────────────────────────────────────────────────


def _bars_with_long_then_opposite_short(n: int = 30) -> pd.DataFrame:
    """Build bars where a long signal fires at bar 5 and a short signal
    fires at bar 12 (opposite-direction signal mid-trade)."""
    bars = _synthetic_enriched_bars(n)
    # Long entry: bullish CHoCH+ at bar 5
    bars.loc[5, "CHOCH"] = 1
    bars.loc[5, "CHOCHPlus"] = 1
    # Opposite signal: bearish CHoCH+ at bar 12
    bars.loc[12, "CHOCH"] = -1
    bars.loc[12, "CHOCHPlus"] = -1
    return bars


class TestOnOppositeSignal:
    """Each of the 4 OnOppositeSignal rules has a distinct trade outcome."""

    def test_hold_and_skip_ignores_opposite_signal(self):
        from pac_backtest.params import OnOppositeSignal
        bars = _bars_with_long_then_opposite_short(40)
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            on_opposite_signal=OnOppositeSignal.HOLD_AND_SKIP,
            # Use ATR_TARGET so the trade can run to a target instead of being closed by opposite_choch
            exit_trigger=ExitTrigger.ATR_TARGET,
            target_atr_multiple=4.0,  # large target so trade stays open past bar 12
        )
        trades = run_backtest(bars, params)
        # HOLD_AND_SKIP must NOT close on the opposite signal at bar 12.
        # Either: trade is still open at end (force-flat with data_end) or
        # exited via stop / session / target — but never "opposite_signal".
        assert all(t.exit_reason != "opposite_signal" for t in trades)

    def test_exit_only_closes_but_does_not_flip(self):
        from pac_backtest.params import OnOppositeSignal
        bars = _bars_with_long_then_opposite_short(40)
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            on_opposite_signal=OnOppositeSignal.EXIT_ONLY,
            exit_trigger=ExitTrigger.ATR_TARGET,
            target_atr_multiple=10.0,
        )
        trades = run_backtest(bars, params)
        # Exactly one trade — the long, exited via opposite_signal. No flip.
        assert len(trades) == 1
        assert trades[0].direction == "long"
        assert trades[0].exit_reason == "opposite_signal"

    def test_exit_and_flip_opens_opposite_trade(self):
        from pac_backtest.params import OnOppositeSignal
        bars = _bars_with_long_then_opposite_short(40)
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            on_opposite_signal=OnOppositeSignal.EXIT_AND_FLIP,
            exit_trigger=ExitTrigger.ATR_TARGET,
            target_atr_multiple=10.0,
        )
        trades = run_backtest(bars, params)
        # Two trades: long (closed via opposite_signal), then short (flip).
        assert len(trades) >= 2
        assert trades[0].direction == "long"
        assert trades[0].exit_reason == "opposite_signal"
        assert trades[1].direction == "short"

    def test_hold_and_tighten_moves_stop_to_breakeven(self):
        from pac_backtest.params import OnOppositeSignal
        bars = _bars_with_long_then_opposite_short(40)
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            on_opposite_signal=OnOppositeSignal.HOLD_AND_TIGHTEN,
            exit_trigger=ExitTrigger.ATR_TARGET,
            target_atr_multiple=10.0,
            stop_atr_multiple=2.0,
        )
        trades = run_backtest(bars, params)
        # After the bar-12 opposite signal, stop is at the entry price.
        # If price later dips back through entry, the trade closes at
        # stop_hit with exit_price == entry_price.
        assert len(trades) >= 1
        # If a trade was stopped, the stop price should equal entry price
        # for the trade that saw the tightening event.
        for t in trades:
            if t.exit_reason == "stop_hit":
                assert t.stop_price == t.entry_price


class TestExitAfterNBos:
    def test_close_after_two_same_direction_bos(self):
        bars = _synthetic_enriched_bars(40)
        # Long entry at bar 5
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1
        # Two bullish (same-direction) BOS events post-entry at bars 8 and 11
        bars.loc[8, "BOS"] = 1
        bars.loc[11, "BOS"] = 1
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            exit_after_n_bos=2,
            exit_trigger=ExitTrigger.SESSION_END,  # don't compete with the BoS exit
        )
        trades = run_backtest(bars, params)
        assert len(trades) == 1
        assert trades[0].exit_reason == "exit_after_2_bos"

    def test_only_same_direction_bos_counts(self):
        bars = _synthetic_enriched_bars(40)
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1
        # One bullish, one bearish BOS post-entry — bearish doesn't count.
        bars.loc[8, "BOS"] = 1
        bars.loc[11, "BOS"] = -1
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            exit_after_n_bos=2,
            exit_trigger=ExitTrigger.SESSION_END,
        )
        trades = run_backtest(bars, params)
        # Should NOT close via exit_after_2_bos — only 1 same-direction BOS
        assert all(t.exit_reason != "exit_after_2_bos" for t in trades)


class TestV4EntryFilters:
    def test_min_adx_blocks_low_adx_entry(self):
        bars = _synthetic_enriched_bars(40)
        bars["adx_14"] = 10.0  # below any reasonable threshold
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            min_adx_14=25.0,
        )
        trades = run_backtest(bars, params)
        assert trades == []

    def test_min_adx_allows_high_adx_entry(self):
        bars = _synthetic_enriched_bars(40)
        bars["adx_14"] = 30.0
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            min_adx_14=25.0,
        )
        trades = run_backtest(bars, params)
        assert len(trades) >= 1

    def test_session_bucket_filter_blocks_wrong_bucket(self):
        from pac_backtest.params import SessionBucket
        bars = _synthetic_enriched_bars(40)
        bars["session_bucket"] = "lunch"  # signal during lunch
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            session_bucket=SessionBucket.NY_OPEN,  # only ny_open allowed
        )
        trades = run_backtest(bars, params)
        assert trades == []

    def test_min_z_vwap_directional(self):
        """Long entries require z_close_vwap >= +threshold."""
        bars = _synthetic_enriched_bars(40)
        bars["z_close_vwap"] = -0.5  # below VWAP — bad for long
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            min_z_entry_vwap=0.5,
        )
        trades = run_backtest(bars, params)
        # Long signal blocked because close is below VWAP, not above by +0.5
        assert trades == []


class TestObBoundaryStop:
    def test_long_stop_at_ob_bottom(self):
        """OB_BOUNDARY stop for a long trade = OB bottom (when OB is below entry)."""
        bars = _synthetic_enriched_bars(40)
        # Bars ramp 100 → 110, so bar 5 close ≈ 101.3, entry fills at bar 6.
        # Place an OB whose bottom (90.0) is well below entry → valid long stop.
        bars["OB"] = np.nan
        bars["OB_Top"] = np.nan
        bars["OB_Bottom"] = np.nan
        bars["OB_MitigatedIndex"] = np.nan
        bars.loc[4, "OB"] = 1
        bars.loc[4, "OB_Top"] = 95.0
        bars.loc[4, "OB_Bottom"] = 90.0
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            stop_placement=StopPlacement.OB_BOUNDARY,
        )
        trades = run_backtest(bars, params)
        assert len(trades) >= 1
        assert trades[0].stop_price == pytest.approx(90.0)

    def test_wrong_side_ob_falls_back_to_n_atr(self):
        """If the OB sits ABOVE a long entry, OB-bottom would still be a
        wrong-side stop (above entry). Loop must fall back to N_ATR rather
        than create an instant-stop-out."""
        bars = _synthetic_enriched_bars(40)
        bars["OB"] = np.nan
        bars["OB_Top"] = np.nan
        bars["OB_Bottom"] = np.nan
        bars["OB_MitigatedIndex"] = np.nan
        # OB sits above the entry zone (entry ≈ 101.3 at bar 6, OB at 110/115)
        bars.loc[4, "OB"] = 1
        bars.loc[4, "OB_Top"] = 115.0
        bars.loc[4, "OB_Bottom"] = 110.0
        bars.loc[5, "CHOCH"] = 1
        bars.loc[5, "CHOCHPlus"] = 1
        params = StrategyParams(
            entry_trigger=EntryTrigger.CHOCH_PLUS_REVERSAL,
            stop_placement=StopPlacement.OB_BOUNDARY,
            stop_atr_multiple=1.5,
        )
        trades = run_backtest(bars, params)
        assert len(trades) >= 1
        # Stop must be BELOW entry (ATR fallback), not at OB bottom (110)
        assert trades[0].stop_price < trades[0].entry_price


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
