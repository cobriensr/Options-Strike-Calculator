"""Tests for setups_backtest.features — pure feature functions.

All tests use synthetic frames with known values; no DB or parquet access.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from setups_backtest import features

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc(ts: str) -> pd.Timestamp:
    return pd.Timestamp(ts, tz="UTC")


def _make_tbbo(minutes: list[str], buy_vols: list[int], sell_vols: list[int]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "minute": [_utc(m) for m in minutes],
            "buy_vol": buy_vols,
            "sell_vol": sell_vols,
        }
    )


def _make_ohlcv(rows: list[tuple[str, float, float, float, float, int]]) -> pd.DataFrame:
    return pd.DataFrame(
        rows, columns=["ts", "open", "high", "low", "close", "volume"]
    ).assign(ts=lambda d: pd.to_datetime(d["ts"], utc=True))


# ---------------------------------------------------------------------------
# OFI window
# ---------------------------------------------------------------------------


def test_ofi_window_basic():
    tbbo = _make_tbbo(
        minutes=["2026-04-15 14:00", "2026-04-15 14:01", "2026-04-15 14:02"],
        buy_vols=[100, 50, 200],
        sell_vols=[50, 100, 100],
    )
    end_ts = _utc("2026-04-15 14:03")
    val = features.ofi_window(tbbo, end_ts, window_minutes=5)
    # buy = 350, sell = 250, OFI = 100/600 = 0.1667
    assert val == pytest.approx(0.16666, rel=1e-3)


def test_ofi_window_empty_returns_nan():
    tbbo = pd.DataFrame(columns=["minute", "buy_vol", "sell_vol"])
    val = features.ofi_window(tbbo, _utc("2026-04-15 14:00"), window_minutes=5)
    assert pd.isna(val)


def test_ofi_window_no_trades_in_window_returns_nan():
    tbbo = _make_tbbo(
        minutes=["2026-04-15 13:00"], buy_vols=[100], sell_vols=[100]
    )
    val = features.ofi_window(tbbo, _utc("2026-04-15 14:00"), window_minutes=5)
    assert pd.isna(val)


def test_ofi_window_exclusive_end():
    # Trade at exactly end_ts must be excluded.
    tbbo = _make_tbbo(
        minutes=["2026-04-15 14:00"], buy_vols=[100], sell_vols=[0]
    )
    val = features.ofi_window(
        tbbo, _utc("2026-04-15 14:00"), window_minutes=5
    )
    assert pd.isna(val)


def test_ofi_window_perfect_buy():
    tbbo = _make_tbbo(
        minutes=["2026-04-15 14:00"], buy_vols=[1000], sell_vols=[0]
    )
    val = features.ofi_window(tbbo, _utc("2026-04-15 14:01"), window_minutes=5)
    assert val == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# CVD
# ---------------------------------------------------------------------------


def test_cvd_session_cumulative():
    tbbo = _make_tbbo(
        minutes=["2026-04-15 13:30", "2026-04-15 13:31", "2026-04-15 13:32"],
        buy_vols=[100, 200, 50],
        sell_vols=[50, 150, 100],
    )
    val = features.cvd_session(
        tbbo, _utc("2026-04-15 13:30"), _utc("2026-04-15 13:33")
    )
    # (100-50) + (200-150) + (50-100) = 50 + 50 - 50 = 50
    assert val == pytest.approx(50.0)


def test_cvd_session_empty_window_is_nan():
    # No data → NaN (not 0.0) so callers distinguish "no data" from "balanced".
    tbbo = _make_tbbo(minutes=[], buy_vols=[], sell_vols=[])
    val = features.cvd_session(
        tbbo, _utc("2026-04-15 13:30"), _utc("2026-04-15 13:33")
    )
    assert pd.isna(val)


def test_cvd_session_window_with_no_rows_is_nan():
    # Data exists but none in the requested window.
    tbbo = _make_tbbo(
        minutes=["2026-04-15 14:00"], buy_vols=[100], sell_vols=[100]
    )
    val = features.cvd_session(
        tbbo, _utc("2026-04-15 13:30"), _utc("2026-04-15 13:33")
    )
    assert pd.isna(val)


def test_cvd_series_cumsum():
    tbbo = _make_tbbo(
        minutes=["2026-04-15 13:30", "2026-04-15 13:31", "2026-04-15 13:32"],
        buy_vols=[100, 200, 50],
        sell_vols=[50, 150, 100],
    )
    s = features.cvd_series(tbbo, _utc("2026-04-15 13:30"))
    assert list(s.values) == [50.0, 100.0, 50.0]


# ---------------------------------------------------------------------------
# ATR
# ---------------------------------------------------------------------------


def test_atr_returns_nan_until_window_filled():
    rows = []
    base = 5000.0
    for i in range(20):
        rows.append(
            (
                f"2026-04-15 13:{30 + i:02d}",
                base + i,
                base + i + 1,
                base + i - 1,
                base + i + 0.5,
                100,
            )
        )
    ohlcv = _make_ohlcv(rows)
    s = features.atr(ohlcv, window=14)
    # First 13 should be NaN, 14th onward populated.
    assert s.iloc[:13].isna().all()
    assert s.iloc[13:].notna().all()
    # With constant 2-wide ranges and 1-pt step closes, true range is ~2 on
    # most bars; ATR should be near 2.
    assert s.iloc[-1] == pytest.approx(2.0, rel=0.1)


def test_atr_all_nan_when_input_shorter_than_window():
    # Fewer bars than window → every output is NaN (pin pandas behavior).
    rows = [
        (f"2026-04-15 13:{30 + i:02d}", 5000.0, 5001.0, 4999.0, 5000.0, 100)
        for i in range(5)
    ]
    ohlcv = _make_ohlcv(rows)
    s = features.atr(ohlcv, window=14)
    assert s.isna().all()


# ---------------------------------------------------------------------------
# Session VWAP
# ---------------------------------------------------------------------------


def test_session_vwap_volume_weighted():
    ohlcv = _make_ohlcv(
        [
            ("2026-04-15 13:30", 100, 102, 100, 101, 100),  # typ = 101
            ("2026-04-15 13:31", 101, 103, 101, 102, 200),  # typ = 102
        ]
    )
    val = features.session_vwap(
        ohlcv, _utc("2026-04-15 13:30"), _utc("2026-04-15 13:32")
    )
    # (101*100 + 102*200) / 300 = (10100 + 20400) / 300 = 101.6667
    assert val == pytest.approx(101.6667, rel=1e-3)


# ---------------------------------------------------------------------------
# Volume profile
# ---------------------------------------------------------------------------


def test_volume_profile_poc_at_dominant_bar():
    # One huge bar at 5050, two small bars at 5000.
    ohlcv = _make_ohlcv(
        [
            ("2026-04-15 13:30", 5000, 5001, 4999, 5000, 100),
            ("2026-04-15 13:31", 5050, 5051, 5049, 5050, 10_000),
            ("2026-04-15 13:32", 5000, 5001, 4999, 5000, 100),
        ]
    )
    out = features.volume_profile(ohlcv, n_bins=50)
    assert out["poc"] == pytest.approx(5050, abs=2)
    # VAH/VAL should bracket POC.
    assert out["val"] <= out["poc"] <= out["vah"]


def test_volume_profile_empty_returns_nans():
    ohlcv = pd.DataFrame(columns=["ts", "open", "high", "low", "close", "volume"])
    out = features.volume_profile(ohlcv)
    assert all(pd.isna(v) for v in out.values())


def test_volume_profile_single_bar_returns_nans():
    # One bar carries no profile information — return NaNs rather than a
    # nonsense single-bar profile that violates val <= poc <= vah.
    ohlcv = _make_ohlcv([("2026-04-15 13:30", 5000, 5005, 4995, 5000, 100)])
    out = features.volume_profile(ohlcv)
    assert all(pd.isna(v) for v in out.values())


def test_volume_profile_constant_price_returns_nans():
    # All bars at the same price — hi == lo, no profile possible.
    ohlcv = _make_ohlcv(
        [
            ("2026-04-15 13:30", 5000, 5000, 5000, 5000, 100),
            ("2026-04-15 13:31", 5000, 5000, 5000, 5000, 100),
            ("2026-04-15 13:32", 5000, 5000, 5000, 5000, 100),
        ]
    )
    out = features.volume_profile(ohlcv)
    assert all(pd.isna(v) for v in out.values())


def test_volume_profile_poc_within_value_area():
    # Construct a realistic 5-bar session; POC must sit inside [VAL, VAH].
    ohlcv = _make_ohlcv(
        [
            ("2026-04-15 13:30", 5000, 5005, 4998, 5002, 200),
            ("2026-04-15 13:31", 5002, 5010, 5000, 5008, 500),
            ("2026-04-15 13:32", 5008, 5015, 5005, 5010, 1000),
            ("2026-04-15 13:33", 5010, 5012, 5005, 5008, 300),
            ("2026-04-15 13:34", 5008, 5012, 5000, 5005, 200),
        ]
    )
    out = features.volume_profile(ohlcv, n_bins=20)
    assert out["val"] <= out["poc"] <= out["vah"]


# ---------------------------------------------------------------------------
# ETH extremes
# ---------------------------------------------------------------------------


def test_eth_extremes_overnight_range():
    # ETH for 2026-04-15 RTH = 21:00 UTC 04-14 -> 13:30 UTC 04-15.
    ohlcv = _make_ohlcv(
        [
            ("2026-04-14 22:00", 5000, 5020, 4990, 5010, 1000),  # in ETH
            ("2026-04-15 04:00", 5010, 5040, 5005, 5030, 1000),  # in ETH; high
            ("2026-04-15 12:00", 5030, 5035, 4985, 4990, 1000),  # in ETH; low
            ("2026-04-15 14:00", 4990, 5000, 4985, 4995, 1000),  # RTH, excluded
        ]
    )
    out = features.eth_extremes(ohlcv, pd.Timestamp("2026-04-15", tz="UTC"))
    assert out["eth_high"] == 5040
    assert out["eth_low"] == 4985


def test_eth_session_bounds():
    start, end = features.eth_session_bounds(pd.Timestamp("2026-04-15", tz="UTC"))
    assert start == pd.Timestamp("2026-04-14 21:00", tz="UTC")
    assert end == pd.Timestamp("2026-04-15 13:30", tz="UTC")


def test_eth_session_bounds_accepts_date():
    # datetime.date input must work — calling code naturally produces these.
    from datetime import date as date_cls

    start, end = features.eth_session_bounds(date_cls(2026, 4, 15))
    assert start == pd.Timestamp("2026-04-14 21:00", tz="UTC")
    assert end == pd.Timestamp("2026-04-15 13:30", tz="UTC")


def test_eth_session_bounds_accepts_naive_timestamp():
    # tz-naive Timestamp should be treated as UTC.
    start, end = features.eth_session_bounds(pd.Timestamp("2026-04-15"))
    assert start == pd.Timestamp("2026-04-14 21:00", tz="UTC")
    assert end == pd.Timestamp("2026-04-15 13:30", tz="UTC")


# ---------------------------------------------------------------------------
# Returns & correlation
# ---------------------------------------------------------------------------


def test_returns_minute_log_returns():
    ohlcv = _make_ohlcv(
        [
            ("2026-04-15 13:30", 100, 100, 100, 100, 1),
            ("2026-04-15 13:31", 100, 100, 100, 110, 1),
        ]
    )
    s = features.returns_minute(ohlcv)
    assert pd.isna(s.iloc[0])
    assert s.iloc[1] == pytest.approx(np.log(110 / 100), rel=1e-6)


def test_rolling_correlation_perfect_corr():
    idx = pd.date_range("2026-04-15", periods=40, freq="1min", tz="UTC")
    rng = np.random.default_rng(0)
    a = pd.Series(rng.standard_normal(40), index=idx)
    b = a.copy()
    corr = features.rolling_correlation(a, b, window_minutes=30)
    # Last value should be 1.0 (perfect correlation with self).
    assert corr.iloc[-1] == pytest.approx(1.0, abs=1e-6)


def test_rolling_correlation_constant_series_is_nan():
    # Correlation against a constant series is undefined (zero std dev).
    idx = pd.date_range("2026-04-15", periods=40, freq="1min", tz="UTC")
    rng = np.random.default_rng(0)
    a = pd.Series(rng.standard_normal(40), index=idx)
    b = pd.Series(np.full(40, 100.0), index=idx)
    corr = features.rolling_correlation(a, b, window_minutes=30)
    # Pandas yields NaN where one series is constant — pin that behavior.
    assert pd.isna(corr.iloc[-1])


# ---------------------------------------------------------------------------
# Trailing p95
# ---------------------------------------------------------------------------


def test_trailing_p95_nan_when_short():
    s = pd.Series([0.1, 0.2, 0.3])
    assert pd.isna(features.trailing_p95(s, lookback_days=252))


def test_trailing_p95_computes_when_enough():
    rng = np.random.default_rng(0)
    s = pd.Series(rng.uniform(-0.5, 0.5, 500))
    val = features.trailing_p95(s, lookback_days=252)
    # 95th percentile of uniform(-0.5, 0.5) over the trailing 252 should be near 0.45.
    assert 0.35 < val < 0.5


# ---------------------------------------------------------------------------
# Macro stress
# ---------------------------------------------------------------------------


def test_macro_stress_triggers_on_large_move():
    rows = [
        ("2026-04-15 13:00", 80.0, 80.0, 80.0, 80.0, 100),
        ("2026-04-15 13:25", 80.0, 80.0, 80.0, 82.5, 100),  # +3.125% over 30m
    ]
    cl = _make_ohlcv(rows)
    assert features.macro_stress_30m(cl, _utc("2026-04-15 13:30"), pct_threshold=2.0)


def test_macro_stress_quiet_market():
    rows = [
        ("2026-04-15 13:00", 80.0, 80.0, 80.0, 80.0, 100),
        ("2026-04-15 13:25", 80.0, 80.0, 80.0, 80.5, 100),  # +0.625% over 30m
    ]
    cl = _make_ohlcv(rows)
    assert not features.macro_stress_30m(cl, _utc("2026-04-15 13:30"), pct_threshold=2.0)


def test_macro_stress_insufficient_data():
    cl = _make_ohlcv([("2026-04-15 13:00", 80.0, 80.0, 80.0, 80.0, 100)])
    assert not features.macro_stress_30m(cl, _utc("2026-04-15 13:30"))
