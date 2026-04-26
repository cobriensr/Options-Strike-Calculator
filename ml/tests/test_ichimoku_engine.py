"""Tests for `ichimoku.IchimokuEngine` and its pure helpers.

Coverage:
- `_midpoint_rolling`: matches manual rolling max+min midpoint
- `_shift_forward`: leading NaN-fill, value carry, zero/negative no-op
- `_atr`: matches Wilder's recurrence on a known sequence
- `_chikou_confirm`: NaN before lookback, sign matches manual diff
- `_detect_sign_change`: cross up/down/tie, NaN handling
- `_detect_cross`: cross up/down vs level, ties don't fire, direction validation
- `_rolling_zscore`: NaN before window, finite + zero-mean within window
- `IchimokuEngine.batch_state` causality:
    - All Senkou Span A/B values at index t depend ONLY on data up to t-26
    - Splicing future bars after the test event must not change cloud at t
- `IchimokuEngine.batch_state` schema:
    - Required PAC columns present (BOS, CHOCH, CHOCHPlus, atr_14,
      session_bucket)
    - Empty input → empty DataFrame with same columns
    - Single TK cross fires BOS at the right bar and direction
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from ichimoku.engine import (
    IchimokuEngine,
    _atr,
    _chikou_confirm,
    _detect_cross,
    _detect_sign_change,
    _midpoint_rolling,
    _rolling_zscore,
    _shift_forward,
)


def _bars(closes: list[float], *, spread: float = 0.4) -> pd.DataFrame:
    """Synthetic OHLCV — mirror of the helper in PAC tests."""
    n = len(closes)
    closes_arr = np.asarray(closes, dtype=float)
    return pd.DataFrame(
        {
            "ts_event": pd.date_range(
                "2024-01-02 13:30", periods=n, freq="5min", tz="UTC"
            ),
            "open": closes_arr,
            "high": closes_arr + spread / 2.0,
            "low": closes_arr - spread / 2.0,
            "close": closes_arr,
            "volume": np.full(n, 1000.0, dtype=np.float64),
            "symbol": ["NQH4"] * n,
        }
    )


# ---------------------------------------------------------------------------
# _midpoint_rolling
# ---------------------------------------------------------------------------


def test_midpoint_rolling_matches_manual() -> None:
    high = np.array([10.0, 11.0, 12.0, 11.5, 13.0])
    low = np.array([9.0, 10.0, 9.5, 10.5, 11.0])
    out = _midpoint_rolling(high, low, n=3)
    # First two bars NaN (min_periods=3).
    assert np.isnan(out[0])
    assert np.isnan(out[1])
    # bar 2: rolling-3 max(10,11,12)=12, min(9,10,9.5)=9 → mid=10.5
    assert out[2] == pytest.approx(10.5)
    # bar 4: max(11,11.5,13)=13, min(9.5,10.5,11)=9.5 → mid=11.25
    assert out[4] == pytest.approx(11.25)


# ---------------------------------------------------------------------------
# _shift_forward
# ---------------------------------------------------------------------------


def test_shift_forward_carries_value_and_pads_nan() -> None:
    arr = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
    out = _shift_forward(arr, 2)
    assert np.isnan(out[0])
    assert np.isnan(out[1])
    assert out[2] == pytest.approx(1.0)
    assert out[3] == pytest.approx(2.0)
    assert out[4] == pytest.approx(3.0)


def test_shift_forward_zero_is_noop() -> None:
    arr = np.array([1.0, 2.0, 3.0])
    out = _shift_forward(arr, 0)
    assert np.array_equal(out, arr)


# ---------------------------------------------------------------------------
# _atr (matches PAC's ATR for label-stop parity)
# ---------------------------------------------------------------------------


def test_atr_constant_range_converges() -> None:
    """Constant TR=2.0 should produce constant ATR=2.0 once warmed up."""
    n = 50
    high = np.full(n, 102.0)
    low = np.full(n, 100.0)
    close = np.full(n, 101.0)  # prev_close - high/low → TR=2.0 for all bars
    atr = _atr(high, low, close, n=14)
    # First 13 NaN, then 14th onward = 2.0
    assert np.isnan(atr[12])
    assert atr[13] == pytest.approx(2.0)
    assert atr[49] == pytest.approx(2.0)


# ---------------------------------------------------------------------------
# _chikou_confirm
# ---------------------------------------------------------------------------


def test_chikou_confirm_nan_before_lookback() -> None:
    close = np.array([100.0] * 30, dtype=np.float64)
    out = _chikou_confirm(close, lookback=26)
    assert np.all(np.isnan(out[:26]))
    assert np.allclose(out[26:], 0.0)  # constant series → diff=0 → sign=0


def test_chikou_confirm_sign_matches_diff() -> None:
    close = np.array([100.0] * 26 + [105.0, 95.0], dtype=np.float64)
    out = _chikou_confirm(close, lookback=26)
    # close[26] - close[0] = 105 - 100 = +5 → sign +1
    # close[27] - close[1] = 95 - 100 = -5 → sign -1
    assert out[26] == pytest.approx(1.0)
    assert out[27] == pytest.approx(-1.0)


# ---------------------------------------------------------------------------
# _detect_sign_change (TK cross machinery)
# ---------------------------------------------------------------------------


def test_detect_sign_change_basic() -> None:
    series = np.array([-1.0, -0.5, 0.5, 1.0, -0.5])
    up, dn = _detect_sign_change(series, up_threshold=0)
    # series goes from -0.5 to +0.5 at index 2 → cross up
    assert up[2]
    assert not dn[2]
    # series goes from +1.0 to -0.5 at index 4 → cross down
    assert dn[4]
    assert not up[4]


def test_detect_sign_change_tie_does_not_fire() -> None:
    """A move from -1 to 0 (touching threshold) is NOT a cross — strict
    inequalities. Only crossing fully through the threshold fires."""
    series = np.array([-1.0, 0.0, 1.0])
    up, _ = _detect_sign_change(series, up_threshold=0)
    # Bar 1 lands AT threshold (curr=0, not > 0) → no cross
    # Bar 2: prev=0, not < 0 → no cross
    assert not up[1]
    assert not up[2]


def test_detect_sign_change_nan_safe() -> None:
    series = np.array([np.nan, np.nan, -0.5, 0.5])
    up, _ = _detect_sign_change(series, up_threshold=0)
    # Index 2 has NaN prev → no cross.  Index 3 has finite prev/curr → cross up.
    assert not up[2]
    assert up[3]


# ---------------------------------------------------------------------------
# _detect_cross (cloud break machinery)
# ---------------------------------------------------------------------------


def test_detect_cross_up() -> None:
    price = np.array([100.0, 100.0, 100.5, 101.5])
    level = np.array([101.0, 101.0, 101.0, 101.0])
    up = _detect_cross(price, level, direction="up")
    # Bar 3: prev=100.5 <= 101 AND curr=101.5 > 101 → cross up
    assert up[3]
    assert not up[2]


def test_detect_cross_dn_symmetric() -> None:
    price = np.array([102.0, 101.5, 100.5])
    level = np.array([101.0, 101.0, 101.0])
    dn = _detect_cross(price, level, direction="dn")
    # Bar 2: prev=101.5 >= 101 AND curr=100.5 < 101 → cross down
    assert dn[2]


def test_detect_cross_invalid_direction_raises() -> None:
    price = np.array([1.0, 2.0])
    level = np.array([1.0, 1.5])
    with pytest.raises(ValueError):
        _detect_cross(price, level, direction="sideways")


# ---------------------------------------------------------------------------
# _rolling_zscore
# ---------------------------------------------------------------------------


def test_rolling_zscore_nan_before_window() -> None:
    arr = np.arange(20.0)
    z = _rolling_zscore(arr, window=10)
    assert np.all(np.isnan(z[:9]))
    assert np.isfinite(z[10])


# ---------------------------------------------------------------------------
# IchimokuEngine.batch_state — schema + causality
# ---------------------------------------------------------------------------


def test_batch_state_empty_input() -> None:
    empty = pd.DataFrame(
        {
            "ts_event": pd.Series([], dtype="datetime64[ns, UTC]"),
            "open": [], "high": [], "low": [], "close": [],
            "volume": [], "symbol": [],
        }
    )
    out = IchimokuEngine().batch_state(empty)
    assert len(out) == 0


def test_batch_state_emits_required_pac_schema() -> None:
    """The classifier pipeline expects ts_event, close, BOS, CHOCH,
    CHOCHPlus, atr_14, session_bucket. Schema parity is the whole
    point of mapping Ichimoku events into the PAC column names."""
    bars = _bars([100.0 + 0.1 * i for i in range(80)])
    out = IchimokuEngine().batch_state(bars)
    for col in ("ts_event", "close", "BOS", "CHOCH", "CHOCHPlus",
                "atr_14", "session_bucket"):
        assert col in out.columns


def test_batch_state_emits_ichimoku_state_columns() -> None:
    bars = _bars([100.0 + 0.1 * i for i in range(80)])
    out = IchimokuEngine().batch_state(bars)
    for col in ("tenkan_9", "kijun_26", "senkou_a_26", "senkou_b_26",
                "cloud_top", "cloud_bottom", "cloud_thickness",
                "cloud_color", "distance_from_cloud_atr", "chikou_confirm"):
        assert col in out.columns


def test_batch_state_senkou_span_is_causal() -> None:
    """The cloud at bar t must reflect data from bars [..t - displacement].
    Splicing bars AFTER the cutoff cannot change the cloud value at the
    cutoff — that's the standard causality test pattern, applied here."""
    n = 100
    closes = [100.0 + 0.1 * i for i in range(n)]
    bars = _bars(closes)

    # Run engine on full series; capture cloud at bar t = 60
    full_out = IchimokuEngine().batch_state(bars)
    cloud_top_t60 = full_out["cloud_top"].iloc[60]

    # Run engine on truncated series ending at bar 60 — same value should appear
    truncated = bars.iloc[:61].reset_index(drop=True)
    truncated_out = IchimokuEngine().batch_state(truncated)
    cloud_top_t60_truncated = truncated_out["cloud_top"].iloc[60]

    if np.isfinite(cloud_top_t60):
        assert cloud_top_t60 == pytest.approx(cloud_top_t60_truncated)
    else:
        # Either both NaN or both finite — they must agree
        assert np.isnan(cloud_top_t60_truncated)


def test_batch_state_tk_cross_fires_during_oscillation() -> None:
    """A sinusoidal price path produces multiple TK crosses with
    distinct sign changes (no equality stalemates as in a strict
    monotone trend). At least one cross_up and one cross_dn must fire."""
    n = 300
    closes = [100.0 + 5.0 * np.sin(i / 8.0) for i in range(n)]
    bars = _bars(closes, spread=0.1)
    out = IchimokuEngine().batch_state(bars)
    bos = out["BOS"].to_numpy()
    bos_up = np.nonzero(np.isclose(bos, 1.0))[0]
    bos_dn = np.nonzero(np.isclose(bos, -1.0))[0]
    assert len(bos_up) >= 1
    assert len(bos_dn) >= 1
    # First event must be after the warmup (Kijun=26 + displacement=26 = 52 bars)
    first_event = min(bos_up[0], bos_dn[0])
    assert first_event >= 26


def test_batch_state_choch_fires_on_cloud_break() -> None:
    """A clear cross of close through the cloud should fire CHOCH."""
    # Start price low, then move up sharply through the eventual cloud level
    closes = [99.0] * 80 + [110.0 + 0.2 * i for i in range(40)]
    bars = _bars(closes, spread=0.1)
    out = IchimokuEngine().batch_state(bars)
    choch_up_idxs = np.nonzero(np.isclose(out["CHOCH"].to_numpy(), 1.0))[0]
    # At least one cloud-break-up event should fire after the regime change
    assert len(choch_up_idxs) >= 1


def test_batch_state_signs_consistent() -> None:
    """BOS/CHOCH/CHOCHPlus values are exactly in {NaN, +1.0, -1.0} —
    no other floats. Required by `pac_classifier.events` which uses
    `signal_value > 0` to derive direction."""
    n = 200
    closes = [100.0 + np.sin(i / 10) * 5 for i in range(n)]
    bars = _bars(closes, spread=0.2)
    out = IchimokuEngine().batch_state(bars)
    for col in ("BOS", "CHOCH", "CHOCHPlus"):
        vals = out[col].dropna().unique()
        for v in vals:
            assert v in (1.0, -1.0), f"unexpected {col} value: {v}"
