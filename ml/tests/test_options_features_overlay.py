"""Tests for `options_features.overlay` — the per-bar feature joiner.

Mocks the yfinance pull underneath so tests are hermetic.
"""

from __future__ import annotations

from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest


def _fake_yf_download(ticker: str, **_):
    """Deterministic synthetic VIX-family values for 2024-01-02 through 2024-01-10."""
    dates = pd.date_range("2024-01-02", "2024-01-10", freq="D")
    values = {
        "^VIX": [15.0] * len(dates),
        "^VIX9D": [14.0] * len(dates),
        "^VIX1D": [13.0] * len(dates),
        "^VVIX": [90.0] * len(dates),
    }
    ser = pd.Series(values[ticker], index=dates, name="Close")
    return pd.DataFrame({"Close": ser})


def _make_bars(start_utc: str, n_bars: int = 10) -> pd.DataFrame:
    ts = pd.date_range(start=start_utc, periods=n_bars, freq="1min", tz="UTC")
    return pd.DataFrame({"ts_event": ts, "close": 100.0})


@pytest.fixture
def patched_vix_cache(tmp_path, monkeypatch):
    cache_path = tmp_path / "vix_family_daily.parquet"
    monkeypatch.setattr("options_features.vix._CACHE_PATH", cache_path)
    yield cache_path


class TestOptionsFeaturesForBars:
    def test_produces_expected_columns(self, patched_vix_cache):
        bars = _make_bars("2024-01-05 13:30:00+00:00", n_bars=5)
        with patch("options_features.vix.yf.download", side_effect=_fake_yf_download):
            from options_features.overlay import options_features_for_bars

            out = options_features_for_bars(bars, refresh_vix=True)

        expected = {
            "ts_event",
            "day",
            "vix",
            "vix9d",
            "vix1d",
            "vvix",
            "vx_ratio",
            "is_opex",
            "is_quarterly_opex",
            "is_fomc",
            "is_event_day",
        }
        assert expected.issubset(set(out.columns))

    def test_row_count_matches_input(self, patched_vix_cache):
        bars = _make_bars("2024-01-05 13:30:00+00:00", n_bars=20)
        with patch("options_features.vix.yf.download", side_effect=_fake_yf_download):
            from options_features.overlay import options_features_for_bars

            out = options_features_for_bars(bars, refresh_vix=True)

        assert len(out) == len(bars)

    def test_vix_forward_filled_to_all_bars(self, patched_vix_cache):
        """Every bar within the requested day should have a VIX value."""
        bars = _make_bars("2024-01-05 13:30:00+00:00", n_bars=5)
        with patch("options_features.vix.yf.download", side_effect=_fake_yf_download):
            from options_features.overlay import options_features_for_bars

            out = options_features_for_bars(bars, refresh_vix=True)

        assert out["vix"].notna().all(), "VIX should be forward-filled on all bars"
        assert (out["vix"] == 15.0).all()

    def test_vx_ratio_computed_per_bar(self, patched_vix_cache):
        bars = _make_bars("2024-01-05 13:30:00+00:00", n_bars=5)
        with patch("options_features.vix.yf.download", side_effect=_fake_yf_download):
            from options_features.overlay import options_features_for_bars

            out = options_features_for_bars(bars, refresh_vix=True)

        expected_ratio = 15.0 / 14.0
        assert np.allclose(out["vx_ratio"].values, expected_ratio)

    def test_opex_day_flagged(self, patched_vix_cache):
        """2024-01-19 was a Friday, day 19 — monthly OPEX."""

        def fake_download_jan(ticker: str, **_):
            dates = pd.date_range("2024-01-10", "2024-01-20", freq="D")
            return pd.DataFrame(
                {"Close": pd.Series([15.0] * len(dates), index=dates, name="Close")}
            )

        bars = _make_bars("2024-01-19 13:30:00+00:00", n_bars=5)
        with patch("options_features.vix.yf.download", side_effect=fake_download_jan):
            from options_features.overlay import options_features_for_bars

            out = options_features_for_bars(bars, refresh_vix=True)

        assert (out["is_opex"] == True).all()  # noqa: E712
        assert (out["is_event_day"] == True).all()  # noqa: E712

    def test_non_opex_day_not_flagged(self, patched_vix_cache):
        bars = _make_bars("2024-01-08 13:30:00+00:00", n_bars=5)
        with patch("options_features.vix.yf.download", side_effect=_fake_yf_download):
            from options_features.overlay import options_features_for_bars

            out = options_features_for_bars(bars, refresh_vix=True)

        assert (out["is_opex"] == False).all()  # noqa: E712

    def test_empty_input_returns_empty_frame_with_schema(self, patched_vix_cache):
        empty = pd.DataFrame(columns=["ts_event"])
        with patch("options_features.vix.yf.download", side_effect=_fake_yf_download):
            from options_features.overlay import options_features_for_bars

            out = options_features_for_bars(empty)

        assert len(out) == 0
        # Schema preserved even when empty
        assert set(out.columns) >= {
            "ts_event",
            "day",
            "vix",
            "vx_ratio",
            "is_opex",
            "is_event_day",
        }

    def test_missing_ts_event_raises(self, patched_vix_cache):
        bogus = pd.DataFrame({"other_col": [1, 2, 3]})
        from options_features.overlay import options_features_for_bars

        with pytest.raises(KeyError, match="ts_event"):
            options_features_for_bars(bogus)

    def test_fomc_day_flagged(self, patched_vix_cache):
        """2024-12-18 is a known FOMC date."""

        def fake_download_dec(ticker: str, **_):
            dates = pd.date_range("2024-12-10", "2024-12-20", freq="D")
            return pd.DataFrame(
                {"Close": pd.Series([22.0] * len(dates), index=dates, name="Close")}
            )

        bars = _make_bars("2024-12-18 13:30:00+00:00", n_bars=5)
        with patch("options_features.vix.yf.download", side_effect=fake_download_dec):
            from options_features.overlay import options_features_for_bars

            out = options_features_for_bars(bars, refresh_vix=True)

        assert (out["is_fomc"] == True).all()  # noqa: E712
        assert (out["is_event_day"] == True).all()  # noqa: E712
