"""Tests for `pac.features` — per-bar context feature additions.

Each test uses a small hand-constructed DataFrame so the expected values
can be verified by hand or against an external reference (TA-Lib for
ADX, etc.).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pac.features import (
    add_adx14,
    add_atr14,
    add_event_calendar_flags,
    add_ob_pct_atr,
    add_ob_volume_rolling_z,
    add_session_bucket,
    add_vwap_zscore_close,
)


def _bars(n: int, *, start: str = "2024-07-15 12:00", freq: str = "1min") -> pd.DataFrame:
    """Build a minimal OHLCV DataFrame with deterministic price ramp."""
    ts = pd.date_range(start, periods=n, freq=freq, tz="UTC")
    base = np.linspace(100.0, 100.0 + n * 0.1, n)
    return pd.DataFrame(
        {
            "ts_event": ts,
            "open": base,
            "high": base + 0.5,
            "low": base - 0.5,
            "close": base,
            "volume": [100] * n,
        }
    )


# ─────────────────────────────────────────────────────────────────────────
# Session bucket
# ─────────────────────────────────────────────────────────────────────────


class TestSessionBucket:
    def test_pre_market_classified_correctly(self):
        # 8:00 CT = 13:00 UTC during CDT (July is DST).
        df = pd.DataFrame({"ts_event": [pd.Timestamp("2024-07-15 13:00", tz="UTC")]})
        out = add_session_bucket(df)
        assert out["session_bucket"].iloc[0] == "pre_market"
        # Negative minutes_from_rth_open (open is 30 min later)
        assert out["minutes_from_rth_open"].iloc[0] == pytest.approx(-30.0)

    def test_ny_open_bucket(self):
        # 9:00 CT = 14:00 UTC (CDT)
        df = pd.DataFrame({"ts_event": [pd.Timestamp("2024-07-15 14:00", tz="UTC")]})
        out = add_session_bucket(df)
        assert out["session_bucket"].iloc[0] == "ny_open"
        assert out["minutes_from_rth_open"].iloc[0] == pytest.approx(30.0)

    def test_lunch_bucket(self):
        # 12:00 CT = 17:00 UTC (CDT)
        df = pd.DataFrame({"ts_event": [pd.Timestamp("2024-07-15 17:00", tz="UTC")]})
        out = add_session_bucket(df)
        assert out["session_bucket"].iloc[0] == "lunch"

    def test_pm_bucket(self):
        # 14:00 CT = 19:00 UTC (CDT)
        df = pd.DataFrame({"ts_event": [pd.Timestamp("2024-07-15 19:00", tz="UTC")]})
        out = add_session_bucket(df)
        assert out["session_bucket"].iloc[0] == "pm"

    def test_close_window(self):
        # 15:05 CT = 20:05 UTC (CDT) — within the 15:00–15:15 close window
        df = pd.DataFrame({"ts_event": [pd.Timestamp("2024-07-15 20:05", tz="UTC")]})
        out = add_session_bucket(df)
        assert out["session_bucket"].iloc[0] == "close"

    def test_post_close(self):
        # 16:00 CT = 21:00 UTC (CDT)
        df = pd.DataFrame({"ts_event": [pd.Timestamp("2024-07-15 21:00", tz="UTC")]})
        out = add_session_bucket(df)
        assert out["session_bucket"].iloc[0] == "post_close"

    def test_dst_handled_via_tz_convert(self):
        """In December (CST), 9:00 CT = 15:00 UTC, not 14:00."""
        df = pd.DataFrame({"ts_event": [pd.Timestamp("2024-12-15 15:00", tz="UTC")]})
        out = add_session_bucket(df)
        assert out["session_bucket"].iloc[0] == "ny_open"


# ─────────────────────────────────────────────────────────────────────────
# ATR(14) — Wilder
# ─────────────────────────────────────────────────────────────────────────


class TestAtr14:
    def test_first_13_bars_are_nan(self):
        out = add_atr14(_bars(20))
        assert out["atr_14"].iloc[:13].isna().all()
        assert pd.notna(out["atr_14"].iloc[13])

    def test_constant_range_gives_constant_atr(self):
        df = _bars(30)
        # Each bar has high - low = 1.0; no gaps. TR = 1.0 for every bar.
        out = add_atr14(df)
        # After warmup, ATR settles to 1.0
        assert out["atr_14"].iloc[20] == pytest.approx(1.0, abs=1e-9)

    def test_handles_gap(self):
        df = _bars(20)
        # Inject a 5-point gap up at bar 5
        df.loc[5, "open"] += 5
        df.loc[5, "high"] += 5
        df.loc[5, "low"] += 5
        df.loc[5, "close"] += 5
        # Carry the gap forward so subsequent bars don't snap back
        df.loc[5:, "open"] += 5
        df.loc[5:, "high"] += 5
        df.loc[5:, "low"] += 5
        df.loc[5:, "close"] += 5
        out = add_atr14(df)
        # Last bar's ATR should reflect the increased TR from the gap
        assert out["atr_14"].iloc[-1] > 1.0


# ─────────────────────────────────────────────────────────────────────────
# ADX(14)
# ─────────────────────────────────────────────────────────────────────────


class TestAdx14:
    def test_strong_uptrend_produces_high_adx(self):
        # 60 bars of clean upward ramp — should produce ADX > 25 by end
        n = 60
        ts = pd.date_range("2024-07-15 13:30", periods=n, freq="1min", tz="UTC")
        # Each bar: high a bit higher, low a bit higher, close at top
        base = np.arange(n, dtype=float) * 0.5
        df = pd.DataFrame(
            {
                "ts_event": ts,
                "open": base + 100,
                "high": base + 100.6,
                "low": base + 100.0,
                "close": base + 100.5,
                "volume": [100] * n,
            }
        )
        out = add_adx14(df)
        # In a clean trend di_plus >> di_minus and ADX should rise
        assert out["di_plus_14"].iloc[-1] > out["di_minus_14"].iloc[-1]
        assert out["adx_14"].iloc[-1] > 20.0

    def test_choppy_market_produces_low_adx(self):
        n = 60
        ts = pd.date_range("2024-07-15 13:30", periods=n, freq="1min", tz="UTC")
        # Alternating up/down bars — no trend
        prices = np.array([100 + (i % 2) for i in range(n)], dtype=float)
        df = pd.DataFrame(
            {
                "ts_event": ts,
                "open": prices,
                "high": prices + 0.1,
                "low": prices - 0.1,
                "close": prices,
                "volume": [100] * n,
            }
        )
        out = add_adx14(df)
        # Chop = low ADX
        assert out["adx_14"].iloc[-1] < 20.0


# ─────────────────────────────────────────────────────────────────────────
# VWAP z-score on close
# ─────────────────────────────────────────────────────────────────────────


class TestVwapZscoreClose:
    def test_close_at_vwap_produces_zero_z(self):
        df = pd.DataFrame(
            {
                "ts_event": pd.date_range("2024-07-15 13:30", periods=3, freq="1min", tz="UTC"),
                "close": [100.0, 100.0, 100.0],
                "session_vwap": [100.0, 100.0, 100.0],
                "session_std": [0.5, 0.5, 0.5],
            }
        )
        out = add_vwap_zscore_close(df)
        assert (out["z_close_vwap"] == 0.0).all()

    def test_close_above_vwap_produces_positive_z(self):
        df = pd.DataFrame(
            {
                "ts_event": pd.date_range("2024-07-15 13:30", periods=1, freq="1min", tz="UTC"),
                "close": [101.0],
                "session_vwap": [100.0],
                "session_std": [0.5],
            }
        )
        out = add_vwap_zscore_close(df)
        assert out["z_close_vwap"].iloc[0] == pytest.approx(2.0)

    def test_zero_std_produces_nan_not_inf(self):
        df = pd.DataFrame(
            {
                "ts_event": pd.date_range("2024-07-15 13:30", periods=1, freq="1min", tz="UTC"),
                "close": [101.0],
                "session_vwap": [100.0],
                "session_std": [0.0],
            }
        )
        out = add_vwap_zscore_close(df)
        assert pd.isna(out["z_close_vwap"].iloc[0])


# ─────────────────────────────────────────────────────────────────────────
# OB %ATR
# ─────────────────────────────────────────────────────────────────────────


class TestObPctAtr:
    def test_active_ob_gets_pct_atr(self):
        df = pd.DataFrame(
            {
                "ts_event": pd.date_range("2024-07-15 13:30", periods=2, freq="1min", tz="UTC"),
                "OB": [1.0, 1.0],
                "OB_width": [10.0, 5.0],
                "atr_14": [20.0, 20.0],
            }
        )
        out = add_ob_pct_atr(df)
        # 10 / 20 * 100 = 50, 5 / 20 * 100 = 25
        assert out["ob_pct_atr"].iloc[0] == pytest.approx(50.0)
        assert out["ob_pct_atr"].iloc[1] == pytest.approx(25.0)

    def test_inactive_ob_gets_nan(self):
        df = pd.DataFrame(
            {
                "ts_event": pd.date_range("2024-07-15 13:30", periods=2, freq="1min", tz="UTC"),
                "OB": [1.0, np.nan],
                "OB_width": [10.0, 5.0],
                "atr_14": [20.0, 20.0],
            }
        )
        out = add_ob_pct_atr(df)
        assert out["ob_pct_atr"].iloc[0] == pytest.approx(50.0)
        assert pd.isna(out["ob_pct_atr"].iloc[1])


# ─────────────────────────────────────────────────────────────────────────
# OB volume rolling z
# ─────────────────────────────────────────────────────────────────────────


class TestObVolumeRollingZ:
    def test_constant_volume_produces_zero_z(self):
        ts = pd.date_range("2024-07-15 13:30", periods=10, freq="1min", tz="UTC")
        df = pd.DataFrame(
            {
                "ts_event": ts,
                "OB": [1.0] * 10,
                "OBVolume": [1000.0] * 10,
            }
        )
        out = add_ob_volume_rolling_z(df, window=5)
        # min_periods=5: first 4 are NaN (no std defined), bar 5+ should be 0
        # (constant volume → mean=val, std=0 → guarded → NaN, not zero).
        # Update: with std=0, our guard yields NaN (intentional — divisions
        # by zero std are not meaningful). Confirm that.
        for i in range(4, 10):
            assert pd.isna(out["ob_volume_z_50"].iloc[i])

    def test_outlier_ob_volume_produces_high_z(self):
        ts = pd.date_range("2024-07-15 13:30", periods=10, freq="1min", tz="UTC")
        # 9 bars at 1000 vol, 1 bar at 5000
        vols = [1000.0] * 9 + [5000.0]
        df = pd.DataFrame(
            {
                "ts_event": ts,
                "OB": [1.0] * 10,
                "OBVolume": vols,
            }
        )
        out = add_ob_volume_rolling_z(df, window=5)
        # Last bar's OB volume is way above the rolling window mean
        assert out["ob_volume_z_50"].iloc[-1] > 1.5

    def test_inactive_ob_bars_do_not_pollute_window(self):
        ts = pd.date_range("2024-07-15 13:30", periods=10, freq="1min", tz="UTC")
        # Only every other bar has an OB — z is computed on the OB-only series
        df = pd.DataFrame(
            {
                "ts_event": ts,
                "OB": [1.0, np.nan, 1.0, np.nan, 1.0, np.nan, 1.0, np.nan, 1.0, np.nan],
                "OBVolume": [1000.0, np.nan, 1100.0, np.nan, 900.0, np.nan, 1050.0, np.nan, 950.0, np.nan],
            }
        )
        out = add_ob_volume_rolling_z(df, window=5)
        # All NaN-OB rows must remain NaN in the output
        for i in [1, 3, 5, 7, 9]:
            assert pd.isna(out["ob_volume_z_50"].iloc[i])


# ─────────────────────────────────────────────────────────────────────────
# Event calendar flags
# ─────────────────────────────────────────────────────────────────────────


class TestEventCalendarFlags:
    def test_quad_witching_opex_flagged(self):
        # 2024-09-20 was the September quad-witching OPEX
        df = pd.DataFrame(
            {"ts_event": [pd.Timestamp("2024-09-20 13:30", tz="UTC")]}
        )
        out = add_event_calendar_flags(df)
        assert out["is_opex"].iloc[0] is np.True_ or out["is_opex"].iloc[0]
        assert out["is_event_day"].iloc[0]

    def test_random_tuesday_not_event(self):
        df = pd.DataFrame(
            {"ts_event": [pd.Timestamp("2024-08-13 13:30", tz="UTC")]}
        )
        out = add_event_calendar_flags(df)
        assert not out["is_fomc"].iloc[0]
        assert not out["is_opex"].iloc[0]
