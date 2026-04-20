"""Tests for `options_features.vix`.

yfinance calls are mocked — we test the cache behavior and vx_ratio
derivation, not yfinance itself.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import numpy as np
import pandas as pd


def _fake_yf_download(ticker: str, **_):
    """Return deterministic synthetic VIX-ish data keyed on ticker."""
    dates = pd.date_range("2024-01-02", "2024-01-10", freq="D")
    values = {
        "^VIX": [15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.0, 22.0, 23.0],
        "^VIX9D": [14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.0, 22.0],
        "^VIX1D": [13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.0],
        "^VVIX": [90.0, 91.0, 92.0, 93.0, 94.0, 95.0, 96.0, 97.0, 98.0],
    }
    ser = pd.Series(values[ticker], index=dates, name="Close")
    return pd.DataFrame({"Close": ser})


def test_load_vix_daily_fresh_pull(tmp_path, monkeypatch):
    """Fresh pull writes cache and returns a frame with vx_ratio column."""
    cache_path = tmp_path / "vix_family_daily.parquet"
    monkeypatch.setattr("options_features.vix._CACHE_PATH", cache_path)

    with patch("options_features.vix.yf.download", side_effect=_fake_yf_download):
        from options_features.vix import load_vix_daily

        df = load_vix_daily(start="2024-01-02", end="2024-01-11", refresh=True)

    assert cache_path.exists(), "Cache file should be written on fresh pull"
    expected_cols = {"day", "vix", "vix9d", "vix1d", "vvix", "vx_ratio"}
    assert expected_cols.issubset(set(df.columns))
    assert len(df) > 0


def test_vx_ratio_computed_correctly(tmp_path, monkeypatch):
    """vx_ratio must equal vix / vix9d element-wise."""
    cache_path = tmp_path / "vix_family_daily.parquet"
    monkeypatch.setattr("options_features.vix._CACHE_PATH", cache_path)

    with patch("options_features.vix.yf.download", side_effect=_fake_yf_download):
        from options_features.vix import load_vix_daily

        df = load_vix_daily(start="2024-01-02", end="2024-01-11", refresh=True)

    # Row 0 in synthetic data: vix=15, vix9d=14 → ratio=15/14≈1.0714
    assert df["vx_ratio"].iloc[0] == 15.0 / 14.0


def test_vx_ratio_nan_when_vix9d_zero(tmp_path, monkeypatch):
    """Guard against divide-by-zero: vx_ratio must be NaN when vix9d ≤ 0."""

    def fake_download_zero(ticker: str, **_):
        dates = pd.date_range("2024-01-02", periods=3, freq="D")
        if ticker == "^VIX9D":
            vals = [0.0, 14.0, 15.0]
        elif ticker == "^VIX":
            vals = [15.0, 16.0, 17.0]
        else:
            vals = [13.0, 14.0, 15.0]
        return pd.DataFrame({"Close": pd.Series(vals, index=dates, name="Close")})

    cache_path = tmp_path / "vix_family_daily.parquet"
    monkeypatch.setattr("options_features.vix._CACHE_PATH", cache_path)

    with patch("options_features.vix.yf.download", side_effect=fake_download_zero):
        from options_features.vix import load_vix_daily

        df = load_vix_daily(start="2024-01-02", end="2024-01-05", refresh=True)

    assert np.isnan(df["vx_ratio"].iloc[0])  # vix9d=0 on first day
    assert df["vx_ratio"].iloc[1] == 16.0 / 14.0  # normal division on 2nd day


def test_cache_reuse_on_fresh_range(tmp_path, monkeypatch):
    """Second call with same range should not re-pull from yfinance."""
    cache_path = tmp_path / "vix_family_daily.parquet"
    monkeypatch.setattr("options_features.vix._CACHE_PATH", cache_path)

    with patch(
        "options_features.vix.yf.download", side_effect=_fake_yf_download
    ) as mock_yf:
        from options_features.vix import load_vix_daily

        load_vix_daily(start="2024-01-02", end="2024-01-11", refresh=True)
        first_call_count = mock_yf.call_count

        # Second call — with end before the cached end, should NOT refetch
        load_vix_daily(start="2024-01-02", end="2024-01-05")

    assert mock_yf.call_count == first_call_count, (
        "Cache was not reused for within-range second call"
    )


def test_day_column_is_date_type(tmp_path, monkeypatch):
    """Downstream overlay joins on date objects — normalize consistently."""
    cache_path = tmp_path / "vix_family_daily.parquet"
    monkeypatch.setattr("options_features.vix._CACHE_PATH", cache_path)

    with patch("options_features.vix.yf.download", side_effect=_fake_yf_download):
        from options_features.vix import load_vix_daily

        df = load_vix_daily(start="2024-01-02", end="2024-01-11", refresh=True)

    assert isinstance(df["day"].iloc[0], date)


def test_range_filter_respected(tmp_path, monkeypatch):
    """Explicit end parameter must be honored — no dates beyond it."""
    cache_path = tmp_path / "vix_family_daily.parquet"
    monkeypatch.setattr("options_features.vix._CACHE_PATH", cache_path)

    with patch("options_features.vix.yf.download", side_effect=_fake_yf_download):
        from options_features.vix import load_vix_daily

        df = load_vix_daily(start="2024-01-02", end="2024-01-06", refresh=True)

    assert df["day"].max() < date(2024, 1, 6)
