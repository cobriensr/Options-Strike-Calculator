"""Tests for `pac_classifier.features.build_features`.

Coverage:
- Engine passthrough columns appear at the right values.
- Rolling returns: NaN before lookback, correct value after.
- Realized vol: NaN before window, finite after.
- BOS density: rolls correctly over trailing window.
- day_of_week derived from ts_event.
- Empty events input → empty frame with schema.
- Out-of-range bar_idx is silently dropped (defensive).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pac_classifier.features import build_features


def _enriched(n: int = 300) -> pd.DataFrame:
    """Build a minimal enriched-shape DataFrame for feature tests.

    We don't need realistic OHLC dynamics here — just enough columns
    that build_features doesn't KeyError, plus deterministic close
    series so the rolling-return math is checkable.
    """
    closes = 100.0 + np.arange(n, dtype=float) * 0.01  # 0.01 per bar
    return pd.DataFrame(
        {
            "ts_event": pd.date_range("2024-01-02 09:30", periods=n, freq="5min", tz="UTC"),
            "open": closes,
            "high": closes + 0.05,
            "low": closes - 0.05,
            "close": closes,
            "volume": np.full(n, 1000.0),
            "BOS": [1.0 if i % 50 == 0 else np.nan for i in range(n)],
            "CHOCH": [np.nan] * n,
            "CHOCHPlus": [np.nan] * n,
            "atr_14": np.full(n, 0.5),
            "adx_14": np.full(n, 25.0),
            "di_plus_14": np.full(n, 22.0),
            "di_minus_14": np.full(n, 18.0),
            "z_close_vwap": np.linspace(-1.0, 1.0, n),
            "ob_pct_atr": np.full(n, 30.0),
            "ob_volume_z_50": np.full(n, 1.5),
            "session_bucket": ["any"] * n,
            "minutes_from_rth_open": np.arange(n, dtype=float),
            "minutes_to_rth_close": (n - np.arange(n, dtype=float)),
            "is_fomc": [False] * n,
            "is_opex": [False] * n,
            "is_event_day": [False] * n,
        }
    )


def test_empty_events_returns_empty_frame() -> None:
    enriched = _enriched(50)
    events = pd.DataFrame(
        {
            "bar_idx": pd.Series([], dtype=np.int64),
            "signal_type": pd.Series([], dtype=object),
            "signal_direction": pd.Series([], dtype=object),
            "atr_14": pd.Series([], dtype=np.float64),
        }
    )
    out = build_features(enriched, events)
    assert len(out) == 0
    # Schema check — at least the canonical columns must exist
    for col in ("bar_idx", "signal_type", "atr_14", "ret_5b", "rv_30b", "bos_density_60b"):
        assert col in out.columns


def test_engine_passthrough() -> None:
    enriched = _enriched(100)
    events = pd.DataFrame(
        {
            "bar_idx": [50],
            "signal_type": ["BOS"],
            "signal_direction": ["up"],
            "atr_14": [0.5],
        }
    )
    out = build_features(enriched, events)
    assert len(out) == 1
    row = out.iloc[0]
    assert row["atr_14"] == pytest.approx(0.5)
    assert row["adx_14"] == pytest.approx(25.0)
    assert row["di_plus_14"] == pytest.approx(22.0)
    assert row["session_bucket"] == "any"
    assert not row["is_fomc"]


def test_rolling_returns_nan_before_lookback() -> None:
    """Returns at bar_idx < lookback should be NaN."""
    enriched = _enriched(300)
    events = pd.DataFrame(
        {
            "bar_idx": [3, 4, 60],  # 3<5, 4<5, 60≥5 → first NaN, last finite
            "signal_type": ["BOS"] * 3,
            "signal_direction": ["up"] * 3,
            "atr_14": [0.5] * 3,
        }
    )
    out = build_features(enriched, events)
    assert np.isnan(out.iloc[0]["ret_5b"])
    assert np.isnan(out.iloc[1]["ret_5b"])
    assert np.isfinite(out.iloc[2]["ret_5b"])


def test_rolling_returns_match_log_diff() -> None:
    """Closes increment by 0.01/bar, so 5-bar return ≈ log(close[i] / close[i-5])."""
    enriched = _enriched(300)
    events = pd.DataFrame(
        {
            "bar_idx": [100],
            "signal_type": ["BOS"],
            "signal_direction": ["up"],
            "atr_14": [0.5],
        }
    )
    out = build_features(enriched, events)
    expected = np.log((100.0 + 100 * 0.01) / (100.0 + 95 * 0.01))
    assert out.iloc[0]["ret_5b"] == pytest.approx(expected, rel=1e-6)


def test_rv_30b_nan_before_window_finite_after() -> None:
    enriched = _enriched(100)
    events = pd.DataFrame(
        {
            "bar_idx": [10, 50],
            "signal_type": ["BOS"] * 2,
            "signal_direction": ["up"] * 2,
            "atr_14": [0.5] * 2,
        }
    )
    out = build_features(enriched, events)
    assert np.isnan(out.iloc[0]["rv_30b"])
    assert np.isfinite(out.iloc[1]["rv_30b"])


def test_bos_density_counts_recent_events() -> None:
    """BOS fires every 50 bars in fixture (bars 0, 50, 100, 150, ...).
    At bar 100: trailing-60 window covers bars 41-100, which includes
    bars 50 and 100 → density = 2."""
    enriched = _enriched(300)
    events = pd.DataFrame(
        {
            "bar_idx": [100],
            "signal_type": ["BOS"],
            "signal_direction": ["up"],
            "atr_14": [0.5],
        }
    )
    out = build_features(enriched, events)
    assert out.iloc[0]["bos_density_60b"] == 2.0


def test_day_of_week_derived() -> None:
    enriched = _enriched(50)
    events = pd.DataFrame(
        {
            "bar_idx": [0],
            "signal_type": ["BOS"],
            "signal_direction": ["up"],
            "atr_14": [0.5],
        }
    )
    out = build_features(enriched, events)
    # 2024-01-02 is a Tuesday → dayofweek = 1
    assert out.iloc[0]["day_of_week"] == 1


def test_out_of_range_bar_idx_skipped() -> None:
    enriched = _enriched(20)
    events = pd.DataFrame(
        {
            "bar_idx": [10, 999, 15],  # 999 is out of range, dropped
            "signal_type": ["BOS"] * 3,
            "signal_direction": ["up"] * 3,
            "atr_14": [0.5] * 3,
        }
    )
    out = build_features(enriched, events)
    assert len(out) == 2
    assert sorted(out["bar_idx"].tolist()) == [10, 15]


def test_signal_type_and_direction_passed_through() -> None:
    enriched = _enriched(50)
    events = pd.DataFrame(
        {
            "bar_idx": [10, 20, 30],
            "signal_type": ["BOS", "CHOCH", "CHOCHPLUS"],
            "signal_direction": ["up", "dn", "up"],
            "atr_14": [0.5] * 3,
        }
    )
    out = build_features(enriched, events)
    assert out["signal_type"].tolist() == ["BOS", "CHOCH", "CHOCHPLUS"]
    assert out["signal_direction"].tolist() == ["up", "dn", "up"]


def test_missing_engine_column_emits_nan_not_keyerror() -> None:
    """If an optional engine column (e.g., adx_14) is absent, we should
    pass through NaN rather than KeyError. Defensive against engine
    schema drift."""
    enriched = _enriched(50)
    enriched = enriched.drop(columns=["adx_14"])
    events = pd.DataFrame(
        {
            "bar_idx": [10],
            "signal_type": ["BOS"],
            "signal_direction": ["up"],
            "atr_14": [0.5],
        }
    )
    out = build_features(enriched, events)
    assert len(out) == 1
    assert np.isnan(out.iloc[0]["adx_14"])
