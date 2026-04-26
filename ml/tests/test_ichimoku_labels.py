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
    STRATEGY_TK_REV_COMBINED,
    STRATEGY_TK_REV_THRESH_05,
    STRATEGY_TK_REV_TRAILING,
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


# ---------------------------------------------------------------------------
# Trailing Kijun stop (Strategy C variant)
# ---------------------------------------------------------------------------


def test_trailing_stop_ratchets_with_kijun() -> None:
    """Long, entry=105, initial Kijun=100 (stop_distance=5). Kijun
    rises bar by bar; by end of bar 4 the trailing stop has ratcheted
    to kijun[4]=106 (causally — using prior bar's kijun for current
    bar's check). At bar 5 price drops, low=105.5 ≤ 106 → stop fires
    at the trailed level of 106. Realized_R = (106-105)/5 = +0.2 →
    profitable stop hit, label_a=1 (default threshold 0).
    """
    closes = [105.0, 106.0, 107.0, 108.0, 109.0, 105.5]
    n = len(closes)
    kijun = [100.0, 101.5, 103.0, 104.5, 106.0, 107.0]
    df = pd.DataFrame(
        {
            "ts_event": pd.date_range("2024-01-02 13:30", periods=n, freq="5min", tz="UTC"),
            "open": closes,
            "high": [c + 0.2 for c in closes],
            "low": [c - 0.2 for c in closes],
            "close": closes,
            "volume": [1000.0] * n,
            "kijun_26": kijun,
            "cloud_top": [np.nan] * n,
            "cloud_bottom": [np.nan] * n,
            "BOS": [np.nan] * n,
        }
    )
    # Bar 5 explicitly low enough to hit the trailing stop at 106 (kijun[4])
    df.loc[5, "low"] = 105.5
    r = label_ichimoku_event(df, 0, "up", STRATEGY_TK_REV_TRAILING)
    assert r.exit_reason == "stop"
    # Trailing stop at 106 (kijun ratcheted through bar 4). +0.2R locked.
    assert r.realized_R == pytest.approx(0.2)
    assert r.label_a == pytest.approx(1.0)  # threshold 0.0 → 0.2 is a win


def test_trailing_stop_does_not_ratchet_against_trade() -> None:
    """Long with kijun ABOVE entry briefly — stop must NOT move down to
    track the unfavorable kijun. Stop price stays at the original level."""
    # Entry=105, initial Kijun=100. Bar 1: Kijun=98 (dropped, unfavorable).
    # Bar 2: price drops to 99.5 → stop SHOULD fire at the original 100,
    # NOT at the lower 98.
    closes = [105.0, 104.0, 99.5]
    df = pd.DataFrame(
        {
            "ts_event": pd.date_range("2024-01-02 13:30", periods=3, freq="5min", tz="UTC"),
            "open": closes,
            "high": [105.5, 104.5, 100.0],
            "low": [104.5, 103.5, 99.5],
            "close": closes,
            "volume": [1000.0] * 3,
            "kijun_26": [100.0, 98.0, 98.0],  # drops then stays
            "cloud_top": [np.nan] * 3,
            "cloud_bottom": [np.nan] * 3,
            "BOS": [np.nan] * 3,
        }
    )
    r = label_ichimoku_event(df, 0, "up", STRATEGY_TK_REV_TRAILING)
    assert r.exit_reason == "stop"
    # Stop fires at the original 100 (because trailing only ratchets up,
    # never down). Realized_R = (100 - 105) / 5 = -1.0 → label_a = 0
    assert r.realized_R == pytest.approx(-1.0)
    assert r.label_a == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# Win threshold (Strategy C variants)
# ---------------------------------------------------------------------------


def test_win_threshold_demotes_marginal_wins_to_loss() -> None:
    """Strategy C with default threshold=0 vs threshold=0.5: a TK
    reversal exit at +0.3R → label_a=1 under default, label_a=0 under
    threshold=0.5.
    """
    # Entry=105, kijun=100 (stop_distance=5). Price drifts to 106.5,
    # then opposite TK cross at bar 3 → exit at 106.5. realized_R = 1.5/5 = 0.3
    closes = [105.0, 105.5, 106.0, 106.5]
    df = pd.DataFrame(
        {
            "ts_event": pd.date_range("2024-01-02 13:30", periods=4, freq="5min", tz="UTC"),
            "open": closes,
            "high": [c + 0.1 for c in closes],
            "low": [c - 0.1 for c in closes],
            "close": closes,
            "volume": [1000.0] * 4,
            "kijun_26": [100.0] * 4,
            "cloud_top": [np.nan] * 4,
            "cloud_bottom": [np.nan] * 4,
            "BOS": [np.nan, np.nan, np.nan, -1.0],
        }
    )
    # Default threshold=0
    r_default = label_ichimoku_event(df, 0, "up", STRATEGY_TK_REVERSAL_EXIT)
    assert r_default.exit_reason == "tk_reversal"
    assert r_default.realized_R == pytest.approx(0.3)
    assert r_default.label_a == pytest.approx(1.0)  # 0.3 > 0

    # With threshold 0.5 → 0.3 is no longer a win
    r_thresh = label_ichimoku_event(df, 0, "up", STRATEGY_TK_REV_THRESH_05)
    assert r_thresh.exit_reason == "tk_reversal"
    assert r_thresh.realized_R == pytest.approx(0.3)
    assert r_thresh.label_a == pytest.approx(0.0)  # 0.3 NOT > 0.5


def test_win_threshold_keeps_big_wins_as_wins() -> None:
    """A reversal exit at +0.8R should still be label_a=1 under threshold=0.5."""
    # Entry=105, kijun=100. Price drifts to 109 (R = 4/5 = 0.8).
    closes = [105.0, 106.5, 108.0, 109.0]
    df = pd.DataFrame(
        {
            "ts_event": pd.date_range("2024-01-02 13:30", periods=4, freq="5min", tz="UTC"),
            "open": closes,
            "high": [c + 0.1 for c in closes],
            "low": [c - 0.1 for c in closes],
            "close": closes,
            "volume": [1000.0] * 4,
            "kijun_26": [100.0] * 4,
            "cloud_top": [np.nan] * 4,
            "cloud_bottom": [np.nan] * 4,
            "BOS": [np.nan, np.nan, np.nan, -1.0],
        }
    )
    r = label_ichimoku_event(df, 0, "up", STRATEGY_TK_REV_THRESH_05)
    assert r.exit_reason == "tk_reversal"
    assert r.realized_R == pytest.approx(0.8)
    assert r.label_a == pytest.approx(1.0)


def test_combined_variant_uses_both_knobs() -> None:
    """Combined strategy = trailing stop + 0.5 threshold. Both behaviors fire."""
    spec = STRATEGY_TK_REV_COMBINED
    assert spec.use_trailing_stop is True
    assert spec.win_threshold_r == pytest.approx(0.5)
    assert spec.exit_on_tk_reversal is True
    assert spec.exit_on_kijun_recross is True


def test_custom_strategy_spec_validates_knobs() -> None:
    """Spec accepts the new fields with sensible defaults."""
    spec = StrategySpec(
        name="custom",
        stop_mode="kijun",
        target_mode="none",
        use_trailing_stop=True,
        win_threshold_r=0.25,
    )
    assert spec.use_trailing_stop is True
    assert spec.win_threshold_r == pytest.approx(0.25)
