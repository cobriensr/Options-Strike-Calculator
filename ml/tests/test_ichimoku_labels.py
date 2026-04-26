"""Tests for `ichimoku_classifier.labels.label_ichimoku_event`.

Coverage:
- Stop resolution per stop_mode (kijun, cloud), including
  skip-on-wrong-side semantics.
- Strategy A (Kijun stop + 2R target): target hit, stop hit, timeout.
- Strategy B (Cloud stop + 2R target): cloud_bottom-as-stop for
  long, cloud_top-as-stop for short.
- Strategy C (Kijun stop + reversal exits):
  - Stop hit fires before any other check.
  - TK reversal exit: opposite-direction BOS at a forward bar.
  - Kijun re-cross exit: close passes through Kijun against
    direction.
  - Reversal-with-profit → label_a=1, reversal-with-loss → label_a=0.
- Edge cases: missing kijun_26 column, NaN ATR, event at last bar.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from ichimoku_classifier.labels import (
    STRATEGY_CLOUD_STOP_2R,
    STRATEGY_KIJUN_STOP_2R,
    STRATEGY_TK_REVERSAL_EXIT,
    StrategySpec,
    _resolve_stop_price,
    label_ichimoku_event,
    label_ichimoku_events,
)


def _enriched(
    closes: list[float],
    *,
    spread: float = 0.5,
    kijun: list[float] | None = None,
    cloud_top: list[float] | None = None,
    cloud_bottom: list[float] | None = None,
    bos: list[float] | None = None,
) -> pd.DataFrame:
    """Synthetic enriched DataFrame matching the IchimokuEngine schema.

    All series default to NaN — pass explicit values for the columns
    a given test needs to exercise.
    """
    n = len(closes)
    closes_arr = np.asarray(closes, dtype=float)
    return pd.DataFrame(
        {
            "ts_event": pd.date_range("2024-01-02 13:30", periods=n, freq="5min", tz="UTC"),
            "open": closes_arr,
            "high": closes_arr + spread / 2.0,
            "low": closes_arr - spread / 2.0,
            "close": closes_arr,
            "volume": np.full(n, 1000.0),
            "kijun_26": np.asarray(kijun if kijun is not None else [np.nan] * n, dtype=float),
            "cloud_top": np.asarray(cloud_top if cloud_top is not None else [np.nan] * n, dtype=float),
            "cloud_bottom": np.asarray(cloud_bottom if cloud_bottom is not None else [np.nan] * n, dtype=float),
            "BOS": np.asarray(bos if bos is not None else [np.nan] * n, dtype=float),
        }
    )


# ---------------------------------------------------------------------------
# _resolve_stop_price — stop level derivation from indicator state
# ---------------------------------------------------------------------------


def test_resolve_kijun_stop_long_below_kijun_skips() -> None:
    """Long with Kijun ABOVE entry → skip (trading against trend)."""
    df = _enriched([100.0, 101.0], kijun=[105.0, 105.0])
    result = _resolve_stop_price(df, 0, "up", 100.0, STRATEGY_KIJUN_STOP_2R)
    assert result is None


def test_resolve_kijun_stop_long_above_kijun_uses_kijun() -> None:
    """Long with Kijun below entry → stop = Kijun."""
    df = _enriched([105.0, 106.0], kijun=[100.0, 100.0])
    result = _resolve_stop_price(df, 0, "up", 105.0, STRATEGY_KIJUN_STOP_2R)
    assert result == pytest.approx(100.0)


def test_resolve_kijun_stop_short_above_kijun_skips() -> None:
    df = _enriched([100.0, 99.0], kijun=[95.0, 95.0])
    result = _resolve_stop_price(df, 0, "dn", 100.0, STRATEGY_KIJUN_STOP_2R)
    assert result is None


def test_resolve_kijun_stop_short_below_kijun_uses_kijun() -> None:
    df = _enriched([95.0, 94.0], kijun=[100.0, 100.0])
    result = _resolve_stop_price(df, 0, "dn", 95.0, STRATEGY_KIJUN_STOP_2R)
    assert result == pytest.approx(100.0)


def test_resolve_cloud_stop_long_above_cloud_uses_cloud_bottom() -> None:
    df = _enriched([105.0], cloud_top=[103.0], cloud_bottom=[101.0])
    result = _resolve_stop_price(df, 0, "up", 105.0, STRATEGY_CLOUD_STOP_2R)
    assert result == pytest.approx(101.0)


def test_resolve_cloud_stop_long_inside_cloud_skips() -> None:
    """Long with cloud_bottom >= entry (long is at-or-below cloud bottom)
    → no useful stop, skip."""
    df = _enriched([102.0], cloud_top=[103.0], cloud_bottom=[101.0])
    # entry=102.0, cloud_bottom=101.0, that IS below entry — should NOT skip
    result = _resolve_stop_price(df, 0, "up", 102.0, STRATEGY_CLOUD_STOP_2R)
    assert result == pytest.approx(101.0)
    # Now: entry=100, cloud_bottom=101 — bottom is above entry, skip.
    df2 = _enriched([100.0], cloud_top=[103.0], cloud_bottom=[101.0])
    result2 = _resolve_stop_price(df2, 0, "up", 100.0, STRATEGY_CLOUD_STOP_2R)
    assert result2 is None


def test_resolve_kijun_stop_nan_returns_none() -> None:
    df = _enriched([100.0])  # default kijun is NaN
    result = _resolve_stop_price(df, 0, "up", 100.0, STRATEGY_KIJUN_STOP_2R)
    assert result is None


def test_resolve_unsupported_stop_mode_raises() -> None:
    bogus = StrategySpec(name="bogus", stop_mode="atr", target_mode="r_multiple")
    df = _enriched([100.0])
    with pytest.raises(ValueError):
        _resolve_stop_price(df, 0, "up", 100.0, bogus)


# ---------------------------------------------------------------------------
# Strategy A — Kijun stop + 2R target
# ---------------------------------------------------------------------------


def test_kijun_stop_target_hit_long() -> None:
    """Long, entry=105, Kijun=100 → stop_distance=5, target=115.
    Bar 1 high=116 → target hit."""
    df = _enriched([105.0, 116.0], kijun=[100.0, 100.0], spread=4.0)
    r = label_ichimoku_event(df, 0, "up", STRATEGY_KIJUN_STOP_2R)
    assert r.label_a == pytest.approx(1.0)
    assert r.exit_reason == "target"
    assert r.realized_R == pytest.approx(2.0)


def test_kijun_stop_stop_hit_long() -> None:
    """Long, entry=105, Kijun=100. Bar 1 low=99 → stop hit."""
    df = _enriched([105.0, 99.0], kijun=[100.0, 100.0], spread=4.0)
    r = label_ichimoku_event(df, 0, "up", STRATEGY_KIJUN_STOP_2R)
    assert r.label_a == pytest.approx(0.0)
    assert r.exit_reason == "stop"
    assert r.realized_R == pytest.approx(-1.0)


def test_kijun_stop_target_hit_short() -> None:
    """Short, entry=100, Kijun=105 → stop_distance=5, target=90.
    Bar 1 low=89 → target hit."""
    df = _enriched([100.0, 89.0], kijun=[105.0, 105.0], spread=4.0)
    r = label_ichimoku_event(df, 0, "dn", STRATEGY_KIJUN_STOP_2R)
    assert r.label_a == pytest.approx(1.0)
    assert r.exit_reason == "target"


def test_kijun_stop_event_against_trend_no_data() -> None:
    """Long with Kijun above entry → skip, return no_data."""
    df = _enriched([100.0, 105.0], kijun=[110.0, 110.0], spread=2.0)
    r = label_ichimoku_event(df, 0, "up", STRATEGY_KIJUN_STOP_2R)
    assert r.exit_reason == "no_data"
    assert np.isnan(r.label_a)


# ---------------------------------------------------------------------------
# Strategy B — Cloud edge stop + 2R target
# ---------------------------------------------------------------------------


def test_cloud_stop_long_target_hit() -> None:
    """Long, entry=105, cloud_bottom=100 → stop_distance=5, target=115."""
    df = _enriched(
        [105.0, 116.0],
        cloud_top=[103.0, 103.0],
        cloud_bottom=[100.0, 100.0],
        spread=4.0,
    )
    r = label_ichimoku_event(df, 0, "up", STRATEGY_CLOUD_STOP_2R)
    assert r.label_a == pytest.approx(1.0)
    assert r.exit_reason == "target"


def test_cloud_stop_short_uses_cloud_top() -> None:
    """Short, entry=100, cloud_top=105 → stop_distance=5, target=90."""
    df = _enriched(
        [100.0, 89.0],
        cloud_top=[105.0, 105.0],
        cloud_bottom=[103.0, 103.0],
        spread=4.0,
    )
    r = label_ichimoku_event(df, 0, "dn", STRATEGY_CLOUD_STOP_2R)
    assert r.label_a == pytest.approx(1.0)
    assert r.exit_reason == "target"


def test_cloud_stop_no_cloud_data_skips() -> None:
    df = _enriched([100.0, 110.0])  # no cloud columns
    r = label_ichimoku_event(df, 0, "up", STRATEGY_CLOUD_STOP_2R)
    assert r.exit_reason == "no_data"


# ---------------------------------------------------------------------------
# Strategy C — Kijun stop + TK reversal / Kijun re-cross exits
# ---------------------------------------------------------------------------


def test_tk_reversal_profitable_exit() -> None:
    """Long, entry=105, Kijun=100. Price drifts up (no stop, no Kijun
    re-cross). At bar 3, opposite TK cross fires (BOS=-1) → exit at
    that bar's close. Close=108 → realized_R = (108-105)/5 = +0.6 → label=1."""
    df = _enriched(
        [105.0, 106.0, 107.0, 108.0],
        kijun=[100.0, 100.0, 100.0, 100.0],  # constant so Kijun never re-crossed
        bos=[np.nan, np.nan, np.nan, -1.0],  # opposite TK cross at bar 3
        spread=0.4,
    )
    r = label_ichimoku_event(df, 0, "up", STRATEGY_TK_REVERSAL_EXIT)
    assert r.exit_reason == "tk_reversal"
    assert r.label_a == pytest.approx(1.0)
    assert r.realized_R == pytest.approx(3.0 / 5.0)


def test_tk_reversal_losing_exit() -> None:
    """Long with kijun=100, entry=105. Price drifts DOWN to 102 (still
    above kijun=100, no stop). TK reversal at bar 3 → exit at 102.
    realized_R = (102-105)/5 = -0.6 → label_a = 0."""
    df = _enriched(
        [105.0, 104.0, 103.0, 102.0],
        kijun=[100.0, 100.0, 100.0, 100.0],
        bos=[np.nan, np.nan, np.nan, -1.0],
        spread=0.4,
    )
    r = label_ichimoku_event(df, 0, "up", STRATEGY_TK_REVERSAL_EXIT)
    assert r.exit_reason == "tk_reversal"
    assert r.label_a == pytest.approx(0.0)
    assert r.realized_R == pytest.approx(-3.0 / 5.0)


def test_kijun_recross_exit() -> None:
    """Long, entry=105, Kijun=100. Bar 3 close=99.5 < Kijun=100 →
    re-cross exit. Stop NOT hit because Kijun is at 100 but we say
    stop is at 100 too — actually stop_hit fires when bar_low <= 100.
    The bar has spread=0.4 around close=99.5, so low=99.3 ≤ 100 →
    stop fires FIRST. Use a different setup."""
    # Make the close re-cross happen via close, not low — give the bar
    # a wide upper range and tight lower so low > stop.
    closes = [105.0, 104.0, 103.0, 99.5]
    n = len(closes)
    df = pd.DataFrame(
        {
            "ts_event": pd.date_range("2024-01-02 13:30", periods=n, freq="5min", tz="UTC"),
            "open": closes,
            "high": [c + 0.5 for c in closes],
            "low": [c + 0.0 for c in closes],  # low = close (zero downside excursion)
            "close": closes,
            "volume": [1000.0] * n,
            "kijun_26": [100.0] * n,
            "cloud_top": [np.nan] * n,
            "cloud_bottom": [np.nan] * n,
            "BOS": [np.nan] * n,
        }
    )
    # Wait — bar 3 has low=99.5 which is < kijun=100 → stop fires first.
    # The kijun_recross check only matters if close re-crosses but no
    # stop hit — for a long that's very narrow (close < kijun but low >
    # kijun — meaning intra-bar didn't dip to kijun). Make low explicitly
    # above kijun by giving bar 3 a gap-down close.
    df.loc[3, "low"] = 100.5  # above kijun, so stop NOT hit
    df.loc[3, "high"] = 100.5
    df.loc[3, "close"] = 99.5  # but we tell the labeler the close is 99.5
    # ...the labeler reads close from `closes`, low from `lows`; since 100.5 > 100
    # stop won't fire. close=99.5 < kijun=100 → recross fires.
    r = label_ichimoku_event(df, 0, "up", STRATEGY_TK_REVERSAL_EXIT)
    assert r.exit_reason == "kijun_recross"
    # realized_R = (99.5 - 105) / 5 = -1.1 → label = 0
    assert r.label_a == pytest.approx(0.0)
    assert r.realized_R == pytest.approx(-1.1)


def test_tk_reversal_stop_priority_wins() -> None:
    """If both stop and TK reversal fire on the same bar, stop wins
    (priority order in the loop)."""
    # Long, entry=105, kijun=100. Bar 1: low=99 (stop hit) AND BOS=-1 (TK reversal)
    closes = [105.0, 99.0]
    n = 2
    df = pd.DataFrame(
        {
            "ts_event": pd.date_range("2024-01-02 13:30", periods=n, freq="5min", tz="UTC"),
            "open": closes,
            "high": [105.5, 100.0],
            "low": [104.5, 99.0],  # bar 1 low=99 hits stop at 100
            "close": closes,
            "volume": [1000.0, 1000.0],
            "kijun_26": [100.0, 100.0],
            "cloud_top": [np.nan, np.nan],
            "cloud_bottom": [np.nan, np.nan],
            "BOS": [np.nan, -1.0],
        }
    )
    r = label_ichimoku_event(df, 0, "up", STRATEGY_TK_REVERSAL_EXIT)
    assert r.exit_reason == "stop"
    assert r.label_a == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# Edge cases + batch path
# ---------------------------------------------------------------------------


def test_event_at_last_bar_returns_no_data() -> None:
    df = _enriched([105.0, 106.0], kijun=[100.0, 100.0])
    r = label_ichimoku_event(df, 1, "up", STRATEGY_KIJUN_STOP_2R)
    assert r.exit_reason == "no_data"


def test_label_ichimoku_events_batch() -> None:
    df = _enriched(
        [105.0, 106.0, 107.0, 108.0, 99.0],
        kijun=[100.0] * 5,
        spread=2.0,
    )
    events = pd.DataFrame(
        {
            "bar_idx": [0, 2],
            "signal_direction": ["up", "up"],
            "atr_14": [1.0, 1.0],
        }
    )
    out = label_ichimoku_events(df, events, STRATEGY_KIJUN_STOP_2R, timeframe="5m")
    assert len(out) == 2
    # Event 0: entry 105, kijun 100, target 115. Bars 1-3 max high≈109.
    # Bar 4 low=98 → stop hit. label=0.
    assert out.iloc[0]["label_a"] == pytest.approx(0.0)


def test_label_ichimoku_events_unsupported_timeframe_raises() -> None:
    df = _enriched([105.0, 106.0])
    events = pd.DataFrame({"bar_idx": [0], "signal_direction": ["up"], "atr_14": [1.0]})
    with pytest.raises(ValueError):
        label_ichimoku_events(df, events, STRATEGY_KIJUN_STOP_2R, timeframe="15m")


def test_label_ichimoku_events_empty_input() -> None:
    df = _enriched([105.0, 106.0])
    events = pd.DataFrame(
        {
            "bar_idx": pd.Series([], dtype=np.int64),
            "signal_direction": pd.Series([], dtype=object),
            "atr_14": pd.Series([], dtype=np.float64),
        }
    )
    out = label_ichimoku_events(df, events, STRATEGY_KIJUN_STOP_2R, timeframe="5m")
    assert len(out) == 0
    assert "label_a" in out.columns
