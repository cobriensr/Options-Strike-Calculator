"""Tests for `pac_classifier.cross_asset`.

Coverage:
- align_to_events: backward merge_asof — no peek, no future leak.
- align_to_events: events earlier than first asset bar → NaN.
- align_to_events: out-of-order event timestamps preserved.
- snapshot_cross_asset_features: graceful NaN when cross_assets is None.
- snapshot_cross_asset_features: graceful NaN for missing symbol.
- snapshot_cross_asset_features: returns + close populated when data present.
- CrossAssetBars.from_mapping: rejects frames without close column.
- CrossAssetBars.from_mapping: tz-aware sort enforced.
- CrossAssetBars.from_parquet_root: round-trip from on-disk layout.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pac_classifier.cross_asset import (
    CROSS_ASSET_RETURN_LOOKBACKS,
    CROSS_ASSET_SYMBOLS,
    CrossAssetBars,
    align_to_events,
    snapshot_cross_asset_features,
)


def _asset_frame(start: str, n: int, base: float, step: float) -> pd.DataFrame:
    closes = base + np.arange(n, dtype=float) * step
    return pd.DataFrame(
        {
            "ts_event": pd.date_range(start, periods=n, freq="1min", tz="UTC"),
            "close": closes,
        }
    )


# ---------------------------------------------------------------------------
# align_to_events
# ---------------------------------------------------------------------------


def test_align_picks_most_recent_bar_at_or_before_event() -> None:
    asset = _asset_frame("2024-01-02 09:30", n=10, base=400.0, step=0.5)
    # Events sit on the same grid + slightly offset (no future bars exist).
    event_ts = pd.Series(
        pd.to_datetime(
            [
                "2024-01-02 09:30:00",  # exactly first bar → close[0]=400.0
                "2024-01-02 09:32:30",  # between bar 2 and 3 → close[2]=401.0
                "2024-01-02 09:39:00",  # exactly last bar → close[9]=404.5
            ],
            utc=True,
            format="ISO8601",
        )
    )
    snapped = align_to_events(asset, event_ts)
    assert snapped["close"].tolist() == pytest.approx([400.0, 401.0, 404.5])


def test_align_event_before_any_bar_emits_nan() -> None:
    asset = _asset_frame("2024-01-02 09:30", n=5, base=400.0, step=0.5)
    event_ts = pd.Series(
        pd.to_datetime(["2024-01-02 09:00"], utc=True)
    )
    snapped = align_to_events(asset, event_ts)
    assert np.isnan(snapped.iloc[0]["close"])


def test_align_no_peek_into_future() -> None:
    """Asset has bar at 09:35 with close=999. Event at 09:34 must NOT
    receive that bar — it's still in the future at 09:34."""
    asset = pd.DataFrame(
        {
            "ts_event": pd.to_datetime(
                ["2024-01-02 09:30", "2024-01-02 09:35"], utc=True
            ),
            "close": [400.0, 999.0],
        }
    )
    event_ts = pd.Series(pd.to_datetime(["2024-01-02 09:34"], utc=True))
    snapped = align_to_events(asset, event_ts)
    # At 09:34 only the 09:30 bar has closed → close=400.0
    assert snapped.iloc[0]["close"] == pytest.approx(400.0)


def test_align_preserves_event_order() -> None:
    asset = _asset_frame("2024-01-02 09:30", n=10, base=400.0, step=0.5)
    # Events deliberately out of chronological order
    event_ts = pd.Series(
        pd.to_datetime(
            [
                "2024-01-02 09:35",  # bar 5 → 402.5
                "2024-01-02 09:31",  # bar 1 → 400.5
                "2024-01-02 09:39",  # bar 9 → 404.5
            ],
            utc=True,
        )
    )
    snapped = align_to_events(asset, event_ts)
    # Order preserved (caller's order, not sorted)
    assert snapped["close"].tolist() == pytest.approx([402.5, 400.5, 404.5])


def test_align_empty_event_ts_returns_empty() -> None:
    asset = _asset_frame("2024-01-02 09:30", n=10, base=400.0, step=0.5)
    snapped = align_to_events(asset, pd.Series([], dtype="datetime64[ns, UTC]"))
    assert len(snapped) == 0


def test_align_empty_asset_returns_all_nan() -> None:
    asset = pd.DataFrame({"ts_event": pd.Series([], dtype="datetime64[ns, UTC]"), "close": []})
    event_ts = pd.Series(pd.to_datetime(["2024-01-02 09:30"], utc=True))
    snapped = align_to_events(asset, event_ts)
    assert len(snapped) == 1
    assert np.isnan(snapped.iloc[0]["close"])


# ---------------------------------------------------------------------------
# snapshot_cross_asset_features
# ---------------------------------------------------------------------------


def test_snapshot_none_emits_nan_columns() -> None:
    event_ts = pd.Series(pd.to_datetime(["2024-01-02 09:30", "2024-01-02 09:35"], utc=True))
    out = snapshot_cross_asset_features(None, event_ts)
    assert len(out) == 2
    for symbol in CROSS_ASSET_SYMBOLS:
        assert f"{symbol}_close" in out.columns
        assert out[f"{symbol}_close"].isna().all()
        for nb in CROSS_ASSET_RETURN_LOOKBACKS:
            assert f"{symbol}_ret_{nb}b" in out.columns
            assert out[f"{symbol}_ret_{nb}b"].isna().all()


def test_snapshot_partial_symbols_only_fills_present() -> None:
    """SPY has data, QQQ + VIX do not → SPY columns finite, others NaN."""
    spy = _asset_frame("2024-01-02 09:00", n=120, base=470.0, step=0.01)
    cross = CrossAssetBars.from_mapping({"SPY": spy})
    event_ts = pd.Series(pd.to_datetime(["2024-01-02 09:31"], utc=True))
    out = snapshot_cross_asset_features(cross, event_ts)
    # SPY has 31 minutes of bars before event → ret_5/30 finite
    assert np.isfinite(out.iloc[0]["SPY_close"])
    assert np.isfinite(out.iloc[0]["SPY_ret_5b"])
    assert np.isfinite(out.iloc[0]["SPY_ret_30b"])
    # QQQ + VIX absent → NaN
    assert np.isnan(out.iloc[0]["QQQ_close"])
    assert np.isnan(out.iloc[0]["VIX_ret_5b"])


def test_snapshot_returns_match_log_diff() -> None:
    """SPY closes increment +0.01/bar. 5-bar log return at minute 31 ≈
    log(c[31] / c[26]) where c[i] = 470 + i*0.01."""
    spy = _asset_frame("2024-01-02 09:00", n=120, base=470.0, step=0.01)
    cross = CrossAssetBars.from_mapping({"SPY": spy})
    # event_ts at minute 31 from start (09:31) — exactly bar index 31
    event_ts = pd.Series(pd.to_datetime(["2024-01-02 09:31"], utc=True))
    out = snapshot_cross_asset_features(cross, event_ts)
    expected = float(np.log((470.0 + 31 * 0.01) / (470.0 + 26 * 0.01)))
    assert out.iloc[0]["SPY_ret_5b"] == pytest.approx(expected, rel=1e-9)


def test_snapshot_empty_event_ts() -> None:
    spy = _asset_frame("2024-01-02 09:00", n=10, base=470.0, step=0.01)
    cross = CrossAssetBars.from_mapping({"SPY": spy})
    out = snapshot_cross_asset_features(cross, pd.Series([], dtype="datetime64[ns, UTC]"))
    assert len(out) == 0
    # Schema still present
    assert "SPY_close" in out.columns


def test_snapshot_event_before_first_bar_nan() -> None:
    spy = _asset_frame("2024-01-02 10:00", n=10, base=470.0, step=0.01)
    cross = CrossAssetBars.from_mapping({"SPY": spy})
    event_ts = pd.Series(pd.to_datetime(["2024-01-02 09:00"], utc=True))
    out = snapshot_cross_asset_features(cross, event_ts)
    assert np.isnan(out.iloc[0]["SPY_close"])
    assert np.isnan(out.iloc[0]["SPY_ret_5b"])


# ---------------------------------------------------------------------------
# CrossAssetBars validation + parquet load
# ---------------------------------------------------------------------------


def test_from_mapping_rejects_frame_without_close() -> None:
    bad = pd.DataFrame(
        {"ts_event": pd.date_range("2024-01-02", periods=3, freq="1min", tz="UTC")}
    )
    with pytest.raises(KeyError):
        CrossAssetBars.from_mapping({"SPY": bad})


def test_from_mapping_sorts_unsorted_input() -> None:
    """Input frame may arrive unsorted; constructor sorts ascending so
    merge_asof preconditions hold."""
    df = pd.DataFrame(
        {
            "ts_event": pd.to_datetime(
                [
                    "2024-01-02 09:32",
                    "2024-01-02 09:30",
                    "2024-01-02 09:31",
                ],
                utc=True,
            ),
            "close": [402.0, 400.0, 401.0],
        }
    )
    cross = CrossAssetBars.from_mapping({"SPY": df})
    sorted_df = cross.get("SPY")
    assert sorted_df is not None
    assert sorted_df["close"].tolist() == pytest.approx([400.0, 401.0, 402.0])


def test_from_parquet_root_round_trip(tmp_path: Path) -> None:
    """Write a SPY frame in archive layout, read it back via loader."""
    spy_2024 = _asset_frame("2024-01-02 09:30", n=20, base=470.0, step=0.01)
    qqq_2024 = _asset_frame("2024-01-02 09:30", n=20, base=400.0, step=0.02)

    for sym, df in [("SPY", spy_2024), ("QQQ", qqq_2024)]:
        target = tmp_path / sym / "year=2024" / "part.parquet"
        target.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(target, index=False, engine="pyarrow")

    loaded = CrossAssetBars.from_parquet_root(tmp_path, symbols=("SPY", "QQQ", "VIX"))
    assert "SPY" in loaded
    assert "QQQ" in loaded
    assert "VIX" not in loaded  # no VIX data on disk → silently skipped
    assert len(loaded.get("SPY")) == 20
    assert loaded.get("SPY")["close"].iloc[0] == pytest.approx(470.0)


def test_from_parquet_root_year_filter(tmp_path: Path) -> None:
    """Multi-year archive filtered by `years` arg loads only matching."""
    for year in (2023, 2024, 2025):
        df = _asset_frame(f"{year}-06-01 09:30", n=5, base=400.0, step=0.5)
        target = tmp_path / "SPY" / f"year={year}" / "part.parquet"
        target.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(target, index=False, engine="pyarrow")

    loaded = CrossAssetBars.from_parquet_root(tmp_path, symbols=("SPY",), years=(2024,))
    spy = loaded.get("SPY")
    assert spy is not None
    assert len(spy) == 5
    # Only 2024 dates
    assert spy["ts_event"].dt.year.unique().tolist() == [2024]
