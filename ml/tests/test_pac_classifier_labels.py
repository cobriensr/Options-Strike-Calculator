"""Tests for `pac_classifier.labels.label_event` + `label_events`.

This is the HIGHEST-priority test file in the classifier package
because the labels are what the model learns from. If the simulator
diverges from `pac_backtest/loop.py`'s bar-walk semantics, Model A's
predictions won't transfer to actual backtest behavior.

Coverage:
- Long: target hit → label=1, R=+target_r_mult
- Long: stop hit → label=0, R=-1
- Short: target hit (price falls) → label=1
- Short: stop hit (price rises) → label=0
- Same-bar tie: stop wins (matches loop.py priority)
- Timeout: label=NaN, realized_R = signed forward distance / stop_distance
- Edge of frame: event near end → no_data result
- Zero ATR: no_data result
- Long/short P&L sign on Label B (forward_return_dollars)
- horizon_idx beyond frame: forward_return = NaN
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pac_classifier.labels import (
    DEFAULT_STOP_ATR_MULT,
    DEFAULT_TARGET_R_MULT,
    label_event,
    label_events,
)


def _bars_from_closes(
    closes: list[float],
    *,
    spread: float = 0.0,
) -> pd.DataFrame:
    """Build minimal OHLC: high=close+spread/2, low=close-spread/2,
    open=prev close, volume=1000. spread=0 → high=low=close (each bar
    is a single point — useful for deterministic stop/target tests).
    """
    n = len(closes)
    closes_arr = np.asarray(closes, dtype=float)
    highs = closes_arr + spread / 2.0
    lows = closes_arr - spread / 2.0
    opens = np.r_[closes_arr[:1], closes_arr[:-1]]
    return pd.DataFrame(
        {
            "ts_event": pd.date_range("2024-01-02 09:30", periods=n, freq="5min", tz="UTC"),
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes_arr,
            "volume": np.full(n, 1000.0),
        }
    )


# ---------------------------------------------------------------------------
# Long-side tests
# ---------------------------------------------------------------------------

def test_long_target_hit() -> None:
    """Entry at 100, ATR=2 → stop=98.5, target=104.5. Bar 1 high=105 → target hit."""
    closes = [100.0, 105.0, 100.0]
    bars = _bars_from_closes(closes, spread=2.0)  # high goes to 106 on bar 1
    r = label_event(bars, event_bar_idx=0, direction="up", atr_at_event=1.0)
    # stop = 100 - 1.5 = 98.5; target = 100 + 2.25 = 102.25
    # Bar 1 high = 106 ≥ 102.25 → target hit
    assert r.label_a == 1.0
    assert r.exit_reason == "target"
    assert r.realized_R == pytest.approx(DEFAULT_TARGET_R_MULT)
    assert r.bars_to_exit == 1


def test_long_stop_hit() -> None:
    """Entry at 100, ATR=1 → stop=98.5. Bar 1 low=95 → stop hit."""
    closes = [100.0, 95.0]
    bars = _bars_from_closes(closes, spread=2.0)
    r = label_event(bars, event_bar_idx=0, direction="up", atr_at_event=1.0)
    assert r.label_a == 0.0
    assert r.exit_reason == "stop"
    assert r.realized_R == -1.0
    assert r.bars_to_exit == 1


# ---------------------------------------------------------------------------
# Short-side tests
# ---------------------------------------------------------------------------

def test_short_target_hit() -> None:
    """Entry at 100, ATR=1, short → stop=101.5, target=97.75.
    Bar 1 low=95 → target hit (price fell, short profits)."""
    closes = [100.0, 95.0]
    bars = _bars_from_closes(closes, spread=2.0)
    r = label_event(bars, event_bar_idx=0, direction="dn", atr_at_event=1.0)
    assert r.label_a == 1.0
    assert r.exit_reason == "target"
    assert r.realized_R == pytest.approx(DEFAULT_TARGET_R_MULT)


def test_short_stop_hit() -> None:
    """Short, price rises → stop hit."""
    closes = [100.0, 105.0]
    bars = _bars_from_closes(closes, spread=2.0)
    r = label_event(bars, event_bar_idx=0, direction="dn", atr_at_event=1.0)
    assert r.label_a == 0.0
    assert r.exit_reason == "stop"
    assert r.realized_R == -1.0


# ---------------------------------------------------------------------------
# Tie-break: stop wins on the same bar
# ---------------------------------------------------------------------------

def test_same_bar_both_stop_and_target_hit_stop_wins() -> None:
    """Bar 1 has high=105 (target hit) AND low=95 (stop hit). Stop
    must win per loop.py's intrabar priority — conservative."""
    bars = pd.DataFrame(
        {
            "ts_event": pd.date_range("2024-01-02 09:30", periods=2, freq="5min", tz="UTC"),
            "open": [100.0, 100.0],
            "high": [100.0, 110.0],
            "low": [100.0, 90.0],
            "close": [100.0, 100.0],
            "volume": [1000.0, 1000.0],
        }
    )
    r = label_event(bars, event_bar_idx=0, direction="up", atr_at_event=1.0)
    # Both stop (98.5) and target (102.25) hit on bar 1. Stop wins.
    assert r.label_a == 0.0
    assert r.exit_reason == "stop"


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------

def test_timeout_returns_nan_label_a() -> None:
    """No stop or target hit within timeout → label_a=NaN, realized_R
    = signed forward return in R units."""
    # Constant 100 — no movement → never hits stop or target
    bars = _bars_from_closes([100.0] * 5, spread=0.5)
    r = label_event(
        bars,
        event_bar_idx=0,
        direction="up",
        atr_at_event=1.0,
        timeout_bars=3,
    )
    assert np.isnan(r.label_a)
    assert r.exit_reason == "timeout"
    assert r.bars_to_exit == 3
    # realized_R: closed at bar 3 close = 100; entry = 100; (100-100)/1.5 = 0
    assert r.realized_R == pytest.approx(0.0)


def test_timeout_drift_reflected_in_realized_R() -> None:
    """Timeout with drift toward target → realized_R captures the
    fraction of R achieved at horizon, even when stop/target untouched."""
    # Drift up 1.0 over 3 bars; target=2.25 not hit, stop=-1.5 not hit
    closes = [100.0, 100.3, 100.6, 101.0]
    bars = _bars_from_closes(closes, spread=0.1)
    r = label_event(
        bars,
        event_bar_idx=0,
        direction="up",
        atr_at_event=1.0,
        timeout_bars=3,
    )
    assert np.isnan(r.label_a)
    assert r.exit_reason == "timeout"
    # realized_R = (101 - 100) / 1.5 ≈ 0.667
    assert r.realized_R == pytest.approx(2 / 3, rel=1e-3)


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

def test_event_at_last_bar_returns_no_data() -> None:
    bars = _bars_from_closes([100.0, 100.0], spread=2.0)
    r = label_event(bars, event_bar_idx=1, direction="up", atr_at_event=1.0)
    assert np.isnan(r.label_a)
    assert r.exit_reason == "no_data"


def test_zero_atr_returns_no_data() -> None:
    bars = _bars_from_closes([100.0, 105.0], spread=2.0)
    r = label_event(bars, event_bar_idx=0, direction="up", atr_at_event=0.0)
    assert np.isnan(r.label_a)
    assert r.exit_reason == "no_data"


def test_nan_atr_returns_no_data() -> None:
    bars = _bars_from_closes([100.0, 105.0], spread=2.0)
    r = label_event(bars, event_bar_idx=0, direction="up", atr_at_event=float("nan"))
    assert np.isnan(r.label_a)
    assert r.exit_reason == "no_data"


def test_invalid_direction_raises() -> None:
    bars = _bars_from_closes([100.0, 105.0])
    with pytest.raises(ValueError):
        label_event(bars, event_bar_idx=0, direction="long", atr_at_event=1.0)


# ---------------------------------------------------------------------------
# Label B — forward return
# ---------------------------------------------------------------------------

def test_label_b_long_positive_return() -> None:
    """Long event, price rises +2 over horizon → forward_return positive."""
    closes = [100.0, 100.5, 101.0, 101.5, 102.0]
    bars = _bars_from_closes(closes, spread=0.1)
    r = label_event(
        bars,
        event_bar_idx=0,
        direction="up",
        atr_at_event=1.0,
        return_horizon_bars=4,
        tick_value_dollars=5.0,
    )
    # forward = (102 - 100) * 5 = 10
    assert r.forward_return_dollars == pytest.approx(10.0)


def test_label_b_short_inverted_sign() -> None:
    """Short event, price falls → forward_return positive (short profits).
    Label B is signed BY DIRECTION, so a winning short emits positive
    return — same convention as long."""
    closes = [100.0, 99.5, 99.0, 98.5, 98.0]
    bars = _bars_from_closes(closes, spread=0.1)
    r = label_event(
        bars,
        event_bar_idx=0,
        direction="dn",
        atr_at_event=1.0,
        return_horizon_bars=4,
        tick_value_dollars=5.0,
    )
    # forward = (100 - 98) * 5 = 10
    assert r.forward_return_dollars == pytest.approx(10.0)


def test_label_b_horizon_beyond_frame_returns_nan() -> None:
    bars = _bars_from_closes([100.0, 101.0], spread=0.1)
    r = label_event(
        bars,
        event_bar_idx=0,
        direction="up",
        atr_at_event=1.0,
        return_horizon_bars=10,
        tick_value_dollars=5.0,
    )
    assert np.isnan(r.forward_return_dollars)


# ---------------------------------------------------------------------------
# Batch path
# ---------------------------------------------------------------------------

def test_label_events_batch() -> None:
    bars = _bars_from_closes([100.0, 105.0, 95.0, 100.0, 100.0], spread=2.0)
    events = pd.DataFrame(
        {
            "bar_idx": [0, 1, 3],
            "signal_direction": ["up", "dn", "up"],
            "atr_14": [1.0, 1.0, 1.0],
        }
    )
    out = label_events(bars, events, timeframe="5m")
    assert len(out) == 3
    # event 0 long entry 100 — bar 1 high=106 → target hit (label=1)
    assert out.iloc[0]["label_a"] == 1.0
    # event 1 short entry 105 — bar 2 high=96 (low=94), short stop=106.5
    # not hit, target=101.625 hit (low=94) → label=1
    assert out.iloc[1]["label_a"] == 1.0
    # event 3 — only one bar after = bar 4 (close=100). No move; timeout NaN.
    assert np.isnan(out.iloc[2]["label_a"])


def test_label_events_unsupported_timeframe_raises() -> None:
    bars = _bars_from_closes([100.0, 100.0])
    events = pd.DataFrame(
        {"bar_idx": [0], "signal_direction": ["up"], "atr_14": [1.0]}
    )
    with pytest.raises(ValueError):
        label_events(bars, events, timeframe="15m")


def test_label_events_empty_input() -> None:
    bars = _bars_from_closes([100.0, 100.0])
    events = pd.DataFrame(
        {
            "bar_idx": pd.Series([], dtype=np.int64),
            "signal_direction": pd.Series([], dtype=object),
            "atr_14": pd.Series([], dtype=np.float64),
        }
    )
    out = label_events(bars, events, timeframe="5m")
    assert len(out) == 0
    assert "label_a" in out.columns
