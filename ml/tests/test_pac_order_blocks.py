"""Tests for `pac.order_blocks` — session VWAP/std + OB z-score enrichment."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pac.order_blocks import (
    enrich_ob_with_z,
    session_vwap_and_std,
    z_at_timestamp,
)


def _make_bars(
    start: str = "2024-01-02 00:00:00+00",
    n: int = 390,
    base_price: float = 100.0,
) -> pd.DataFrame:
    """Generate a synthetic 1m RTH-ish session of bars for testing."""
    ts = pd.date_range(start=start, periods=n, freq="1min", tz="UTC")
    rng = np.random.default_rng(42)
    noise = rng.normal(0, 0.5, n).cumsum()
    close = base_price + noise
    high = close + rng.uniform(0.1, 0.5, n)
    low = close - rng.uniform(0.1, 0.5, n)
    open_ = np.r_[close[:1], close[:-1]]
    volume = rng.integers(100, 1000, n)
    return pd.DataFrame(
        {
            "ts_event": ts,
            "open": open_,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        }
    )


class TestSessionVwapAndStd:
    def test_shape_matches_input(self):
        df = _make_bars(n=100)
        stats = session_vwap_and_std(df)
        assert len(stats) == len(df)
        assert set(stats.columns) == {"ts_event", "session_vwap", "session_std"}

    def test_vwap_equals_first_tp_on_bar_one(self):
        """The first bar of a session has VWAP = its typical price (no history)."""
        df = _make_bars(n=10)
        stats = session_vwap_and_std(df)
        tp0 = (df["high"].iloc[0] + df["low"].iloc[0] + df["close"].iloc[0]) / 3
        assert stats["session_vwap"].iloc[0] == pytest.approx(tp0)

    def test_std_zero_on_first_bar(self):
        """std of a single observation is undefined; we coerce to 0 for safety."""
        df = _make_bars(n=10)
        stats = session_vwap_and_std(df)
        assert stats["session_std"].iloc[0] == 0.0

    def test_vwap_resets_at_utc_day_boundary(self):
        """VWAP should restart when a new UTC day begins."""
        df1 = _make_bars(start="2024-01-02 23:58:00+00", n=5, base_price=100.0)
        df2 = _make_bars(start="2024-01-03 00:03:00+00", n=5, base_price=200.0)
        df = pd.concat([df1, df2]).reset_index(drop=True)
        stats = session_vwap_and_std(df)

        # After the day boundary, VWAP should be close to 200 (new session)
        # not close to 100+ (contaminated from prior session)
        post_boundary_vwap = stats["session_vwap"].iloc[-1]
        assert post_boundary_vwap > 150, (
            f"VWAP didn't reset at day boundary: {post_boundary_vwap}"
        )

    def test_missing_column_raises(self):
        df = pd.DataFrame({"ts_event": pd.date_range("2024-01-01", periods=3, tz="UTC")})
        with pytest.raises(KeyError, match="Missing required columns"):
            session_vwap_and_std(df)

    def test_monotonic_cumulative_volume_implicit(self):
        """VWAP should be a weighted average — can't be below min(tp) or above max(tp)."""
        df = _make_bars(n=50)
        stats = session_vwap_and_std(df)
        tp = (df["high"] + df["low"] + df["close"]) / 3
        # After bar N, VWAP must be within [min(tp[:N+1]), max(tp[:N+1])]
        for i in range(1, len(df)):
            tp_so_far = tp.iloc[: i + 1]
            assert tp_so_far.min() - 1e-9 <= stats["session_vwap"].iloc[i] <= tp_so_far.max() + 1e-9


class TestZAtTimestamp:
    def test_standard_z_computation(self):
        assert z_at_timestamp(102.0, 100.0, 2.0) == pytest.approx(1.0)
        assert z_at_timestamp(96.0, 100.0, 2.0) == pytest.approx(-2.0)

    def test_zero_std_returns_nan(self):
        result = z_at_timestamp(100.0, 100.0, 0.0)
        assert np.isnan(result)

    def test_negative_std_returns_nan(self):
        """Defensive: bogus negative std should not produce a real z-value."""
        result = z_at_timestamp(100.0, 100.0, -1.0)
        assert np.isnan(result)

    def test_nan_std_returns_nan(self):
        result = z_at_timestamp(100.0, 100.0, float("nan"))
        assert np.isnan(result)


class TestEnrichObWithZ:
    def _make_ob_frame(self, n: int, ob_at: dict[int, tuple[int, float, float]]) -> pd.DataFrame:
        """Synthetic smc.ob() output. `ob_at[idx] = (direction, top, bottom)`."""
        ob = np.full(n, np.nan)
        top = np.full(n, np.nan)
        bot = np.full(n, np.nan)
        vol = np.full(n, np.nan)
        pct = np.full(n, np.nan)
        mit = np.full(n, np.nan)
        for i, (d, t, b) in ob_at.items():
            ob[i] = d
            top[i] = t
            bot[i] = b
            vol[i] = 1000.0
            pct[i] = 50.0
        return pd.DataFrame(
            {
                "OB": ob,
                "Top": top,
                "Bottom": bot,
                "OBVolume": vol,
                "MitigatedIndex": mit,
                "Percentage": pct,
            }
        )

    def test_adds_expected_columns(self):
        df = _make_bars(n=100)
        ob = self._make_ob_frame(100, {50: (1, 102.0, 100.0)})
        enriched = enrich_ob_with_z(df, ob)
        expected = {"OB_mid", "OB_width", "OB_z_top", "OB_z_bot", "OB_z_mid"}
        assert expected.issubset(set(enriched.columns))

    def test_z_columns_nan_where_no_ob(self):
        df = _make_bars(n=100)
        ob = self._make_ob_frame(100, {50: (1, 102.0, 100.0)})
        enriched = enrich_ob_with_z(df, ob)
        # Bar 0 has no OB → all z columns NaN
        assert np.isnan(enriched["OB_z_top"].iloc[0])
        assert np.isnan(enriched["OB_z_bot"].iloc[0])
        # Bar 50 has an OB → z columns are real numbers
        assert not np.isnan(enriched["OB_z_top"].iloc[50])

    def test_ob_mid_is_average_of_top_bottom(self):
        df = _make_bars(n=100)
        ob = self._make_ob_frame(100, {50: (1, 102.0, 100.0)})
        enriched = enrich_ob_with_z(df, ob)
        assert enriched["OB_mid"].iloc[50] == pytest.approx(101.0)

    def test_ob_width_is_top_minus_bottom(self):
        df = _make_bars(n=100)
        ob = self._make_ob_frame(100, {50: (1, 102.5, 100.0)})
        enriched = enrich_ob_with_z(df, ob)
        assert enriched["OB_width"].iloc[50] == pytest.approx(2.5)

    def test_length_mismatch_raises(self):
        df = _make_bars(n=100)
        ob = self._make_ob_frame(50, {})  # wrong length
        with pytest.raises(ValueError, match="must align"):
            enrich_ob_with_z(df, ob)

    def test_z_zero_when_price_equals_vwap(self):
        """Sanity: z = 0 exactly when OB top equals session VWAP."""
        df = _make_bars(n=100)
        stats = session_vwap_and_std(df)
        vwap_at_50 = stats["session_vwap"].iloc[50]
        # Place an OB where top == VWAP
        ob = self._make_ob_frame(100, {50: (1, vwap_at_50, vwap_at_50 - 1.0)})
        enriched = enrich_ob_with_z(df, ob, stats=stats)
        assert enriched["OB_z_top"].iloc[50] == pytest.approx(0.0, abs=1e-9)


_ARCHIVE_ROOT = Path(__file__).resolve().parents[1] / "data" / "archive"
_ARCHIVE_MISSING = not (_ARCHIVE_ROOT / "ohlcv_1m").exists()


@pytest.mark.skipif(_ARCHIVE_MISSING, reason="Archive not present")
class TestOrderBlocksIntegration:
    def test_journal_day_enrichment_runs_clean(self):
        """Full pipeline on 2026-04-17 must produce well-formed z columns."""
        import os

        os.environ.setdefault("SMC_CREDIT", "0")
        from pac.archive_loader import load_bars, reset_connection_for_tests
        from pac.engine import PACEngine

        reset_connection_for_tests()
        df = load_bars("NQ", "2026-04-17", "2026-04-18")
        enriched = PACEngine().batch_state(df)

        # Any row with an OB must also have z-scores (not NaN)
        ob_rows = enriched[enriched["OB"].abs() == 1]
        assert len(ob_rows) > 0, "Expected at least one OB on this known-active day"
        # Some very-early-in-session OBs may have std==0 and thus NaN z;
        # require majority are well-defined
        z_defined = ob_rows["OB_z_mid"].notna().sum()
        assert z_defined > len(ob_rows) * 0.8, (
            f"Only {z_defined}/{len(ob_rows)} OBs have defined z-scores; "
            "check session_std computation"
        )
