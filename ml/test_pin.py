"""
Unit tests for pin_analysis.py pure functions.

Covers:
  - compute_gamma_profile: gamma metrics from a strike-level snapshot
  - find_nearest_snapshot: timestamp proximity lookup
  - compute_oi_pin: OI-based pin strike and concentration

Run:
    cd ml && .venv/bin/python -m pytest test_pin.py -v
"""

import numpy as np
import pandas as pd
import pytest

from pin_analysis import compute_gamma_profile, compute_oi_pin, find_nearest_snapshot


# ── Helpers ───────────────────────────────────────────────────


def _gamma_snapshot(
    strikes: list[float],
    call_gamma_oi: list[float],
    put_gamma_oi: list[float],
    price: float = 5800.0,
) -> pd.DataFrame:
    """Build a minimal DataFrame mimicking one timestamp's strike data."""
    n = len(strikes)
    return pd.DataFrame(
        {
            "strike": strikes,
            "price": [price] * n,
            "call_gamma_oi": call_gamma_oi,
            "put_gamma_oi": put_gamma_oi,
        }
    )


def _oi_snapshot(
    strikes: list[float],
    call_oi: list[float],
    put_oi: list[float],
) -> pd.DataFrame:
    """Build a minimal DataFrame for compute_oi_pin."""
    return pd.DataFrame(
        {
            "strike": strikes,
            "call_oi": call_oi,
            "put_oi": put_oi,
        }
    )


# ── compute_gamma_profile ─────────────────────────────────────


class TestComputeGammaProfile:
    """Tests for compute_gamma_profile."""

    def test_empty_dataframe_returns_empty_dict(self):
        """An empty snapshot must return {}."""
        df = pd.DataFrame(
            columns=["strike", "price", "call_gamma_oi", "put_gamma_oi"]
        )
        assert compute_gamma_profile(df) == {}

    def test_all_zero_gamma_returns_empty_dict(self):
        """When every gamma value is zero, there is no signal to report."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_gamma_oi=[0, 0, 0, 0, 0],
            put_gamma_oi=[0, 0, 0, 0, 0],
        )
        assert compute_gamma_profile(df) == {}

    def test_peak_gamma_strike_is_highest_absolute(self):
        """peak_gamma_strike must be the strike with the largest |net_gamma|."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_gamma_oi=[1, 2, 10, 3, 1],
            put_gamma_oi=[0, 0, 0, 0, 0],
        )
        result = compute_gamma_profile(df)
        assert result["peak_gamma_strike"] == 5800
        assert result["peak_gamma_mag"] == 10

    def test_peak_gamma_with_negative_dominance(self):
        """When a large negative gamma dominates, peak should reflect it."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_gamma_oi=[1, 2, 3, 2, 1],
            put_gamma_oi=[0, 0, -50, 0, 0],
        )
        result = compute_gamma_profile(df)
        # net_gamma at 5800 = 3 + (-50) = -47, abs = 47 -- largest
        assert result["peak_gamma_strike"] == 5800
        assert result["peak_gamma_mag"] == pytest.approx(47.0)

    def test_pos_peak_is_highest_positive_gamma(self):
        """pos_peak_strike must be the strike with the largest positive net_gamma."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_gamma_oi=[5, 2, 3, 8, 1],
            put_gamma_oi=[0, 0, 0, 0, 0],
        )
        result = compute_gamma_profile(df)
        assert result["pos_peak_strike"] == 5810
        assert result["pos_peak_mag"] == 8

    def test_neg_peak_is_most_negative_gamma(self):
        """neg_peak_strike must be the strike with the most negative net_gamma."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_gamma_oi=[1, 1, 1, 1, 1],
            put_gamma_oi=[-10, -30, -5, -20, -2],
        )
        result = compute_gamma_profile(df)
        # net_gamma: -9, -29, -4, -19, -1 => most negative is 5790 (-29)
        assert result["neg_peak_strike"] == 5790
        assert result["neg_peak_mag"] == pytest.approx(-29.0)

    def test_pos_peak_fallback_when_no_positive_gamma(self):
        """When all net_gamma <= 0, pos_peak defaults to the abs peak strike."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_gamma_oi=[0, 0, 0, 0, 0],
            put_gamma_oi=[-10, -30, -5, -20, -2],
        )
        result = compute_gamma_profile(df)
        # All negative; pos_peak should fall back to peak_gamma_strike
        assert result["pos_peak_strike"] == result["peak_gamma_strike"]
        assert result["pos_peak_mag"] == 0.0

    def test_neg_peak_fallback_when_no_negative_gamma(self):
        """When all net_gamma >= 0, neg_peak defaults to the abs peak strike."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_gamma_oi=[10, 30, 5, 20, 2],
            put_gamma_oi=[0, 0, 0, 0, 0],
        )
        result = compute_gamma_profile(df)
        assert result["neg_peak_strike"] == result["peak_gamma_strike"]
        assert result["neg_peak_mag"] == 0.0

    def test_gamma_centroid_is_weighted_average(self):
        """gamma_centroid should be the abs-gamma-weighted average of strikes."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[0, 10, 0],
            put_gamma_oi=[0, 0, 0],
        )
        result = compute_gamma_profile(df)
        # All weight at 5800 => centroid == 5800
        assert result["gamma_centroid"] == pytest.approx(5800.0)

    def test_gamma_centroid_two_equal_weights(self):
        """With equal gamma at two strikes, centroid is the midpoint."""
        df = _gamma_snapshot(
            strikes=[5790, 5810],
            call_gamma_oi=[10, 10],
            put_gamma_oi=[0, 0],
            price=5800.0,
        )
        result = compute_gamma_profile(df)
        assert result["gamma_centroid"] == pytest.approx(5800.0)

    def test_gamma_centroid_skewed(self):
        """Centroid should pull toward the heavier strike."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[30, 10, 0],
            put_gamma_oi=[0, 0, 0],
        )
        result = compute_gamma_profile(df)
        # Weights: 30, 10, 0 => centroid = (5790*30 + 5800*10) / 40 = 5792.5
        assert result["gamma_centroid"] == pytest.approx(5792.5)

    def test_pos_centroid_uses_positive_gamma_only(self):
        """pos_centroid must ignore negative-gamma strikes."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[20, 0, 10],
            put_gamma_oi=[0, -50, 0],
        )
        result = compute_gamma_profile(df)
        # Positive net_gamma: 5790 (20), 5810 (10). 5800 net = -50 excluded.
        expected = (5790 * 20 + 5810 * 10) / 30
        assert result["pos_centroid"] == pytest.approx(expected, abs=0.01)

    def test_pos_gamma_above_below_relative_to_price(self):
        """Positive gamma must split correctly around the price level."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_gamma_oi=[5, 10, 3, 8, 4],
            put_gamma_oi=[0, 0, 0, 0, 0],
            price=5800.0,
        )
        result = compute_gamma_profile(df)
        # Above price (>5800): 5810 (8) + 5820 (4) = 12
        assert result["pos_gamma_above"] == pytest.approx(12.0)
        # Below or equal to price (<=5800): 5780 (5) + 5790 (10) + 5800 (3) = 18
        assert result["pos_gamma_below"] == pytest.approx(18.0)

    def test_pos_gamma_above_excludes_negative_gamma(self):
        """Only positive net_gamma counts toward above/below sums."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5810, 5820],
            call_gamma_oi=[5, 0, 8, 0],
            put_gamma_oi=[0, -20, 0, -10],
            price=5800.0,
        )
        result = compute_gamma_profile(df)
        # 5810 net=8 (positive, above) ; 5820 net=-10 (negative, excluded)
        assert result["pos_gamma_above"] == pytest.approx(8.0)
        # 5780 net=5 (positive, below) ; 5790 net=-20 (negative, excluded)
        assert result["pos_gamma_below"] == pytest.approx(5.0)

    def test_price_returned_in_result(self):
        """The result dict must include the snapshot's price."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[1, 2, 3],
            put_gamma_oi=[0, 0, 0],
            price=5805.25,
        )
        result = compute_gamma_profile(df)
        assert result["price"] == pytest.approx(5805.25)

    def test_result_keys_complete(self):
        """All expected keys must be present in a valid result."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[5, 10, 3],
            put_gamma_oi=[-1, -2, -1],
            price=5800.0,
        )
        result = compute_gamma_profile(df)
        expected_keys = {
            "peak_gamma_strike",
            "peak_gamma_mag",
            "pos_peak_strike",
            "pos_peak_mag",
            "neg_peak_strike",
            "neg_peak_mag",
            "gamma_centroid",
            "pos_centroid",
            "prox_centroid",
            "pos_gamma_above",
            "pos_gamma_below",
            "price",
        }
        assert set(result.keys()) == expected_keys

    def test_all_values_are_floats(self):
        """Every value in the result dict must be a Python float."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[5, 10, 3],
            put_gamma_oi=[-1, -2, -1],
        )
        result = compute_gamma_profile(df)
        for key, value in result.items():
            assert isinstance(value, float), f"{key} is {type(value)}, not float"

    def test_nan_gamma_treated_as_zero(self):
        """NaN gamma values should be filled to 0, not break computation."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[np.nan, 10, np.nan],
            put_gamma_oi=[np.nan, 0, np.nan],
        )
        result = compute_gamma_profile(df)
        # Only 5800 has nonzero gamma => it is the peak
        assert result["peak_gamma_strike"] == 5800
        assert result["peak_gamma_mag"] == pytest.approx(10.0)

    def test_string_gamma_coerced_to_numeric(self):
        """The function calls pd.to_numeric with errors='coerce'; strings become NaN then 0."""
        df = pd.DataFrame(
            {
                "strike": [5790, 5800, 5810],
                "price": [5800, 5800, 5800],
                "call_gamma_oi": ["bad", "10", "5"],
                "put_gamma_oi": ["0", "0", "0"],
            }
        )
        result = compute_gamma_profile(df)
        assert result["peak_gamma_strike"] == 5800

    def test_prox_centroid_favors_nearby_strikes(self):
        """Proximity-weighted centroid should pull toward strikes closer to price."""
        # Two strikes with equal gamma but different distances from price
        df = _gamma_snapshot(
            strikes=[5700, 5800, 5900],
            call_gamma_oi=[10, 10, 10],
            put_gamma_oi=[0, 0, 0],
            price=5800.0,
        )
        result = compute_gamma_profile(df)
        # 5800 is distance 1 (clipped), 5700 and 5900 are distance 100
        # prox_weight at 5800: 10 / 1 = 10
        # prox_weight at 5700: 10 / 10000 = 0.001
        # prox_weight at 5900: 10 / 10000 = 0.001
        # prox_centroid should be very close to 5800
        assert result["prox_centroid"] == pytest.approx(5800.0, abs=1.0)

    def test_single_strike_snapshot(self):
        """A single-strike snapshot should still produce valid results."""
        df = _gamma_snapshot(
            strikes=[5800],
            call_gamma_oi=[25],
            put_gamma_oi=[-5],
            price=5800.0,
        )
        result = compute_gamma_profile(df)
        assert result["peak_gamma_strike"] == 5800.0
        assert result["gamma_centroid"] == 5800.0
        assert result["pos_centroid"] == 5800.0
        assert result["prox_centroid"] == 5800.0
        # net_gamma = 20 (positive), so all positive gamma is at-or-below price
        assert result["pos_gamma_above"] == pytest.approx(0.0)
        assert result["pos_gamma_below"] == pytest.approx(20.0)


# ── find_nearest_snapshot ─────────────────────────────────────


class TestFindNearestSnapshot:
    """Tests for find_nearest_snapshot."""

    def _make_day_data(self, times: list[str]) -> pd.DataFrame:
        """Build a DataFrame with multiple timestamps for one day.

        Each timestamp gets two strikes so the result is a proper snapshot.
        """
        rows = []
        for t in times:
            ts = pd.Timestamp(f"2026-03-15 {t}", tz="UTC")
            for strike in [5800, 5810]:
                rows.append(
                    {
                        "timestamp": ts,
                        "strike": strike,
                        "price": 5800,
                        "call_gamma_oi": 10,
                        "put_gamma_oi": -5,
                    }
                )
        return pd.DataFrame(rows)

    def test_exact_match(self):
        """When a snapshot has the exact target time, return it."""
        df = self._make_day_data(["16:00", "18:00", "19:30"])
        result = find_nearest_snapshot(df, "18:00")
        assert result is not None
        assert len(result) == 2  # two strikes
        ts = result["timestamp"].iloc[0]
        assert ts.hour == 18 and ts.minute == 0

    def test_closest_within_tolerance(self):
        """When no exact match exists, return the closest within 15 min."""
        df = self._make_day_data(["17:52", "18:07"])
        result = find_nearest_snapshot(df, "18:00")
        assert result is not None
        ts = result["timestamp"].iloc[0]
        assert ts.hour == 18 and ts.minute == 7

    def test_returns_none_beyond_tolerance(self):
        """Snapshots >15 min from target should yield None."""
        df = self._make_day_data(["16:00", "17:00"])
        result = find_nearest_snapshot(df, "18:00")
        assert result is None

    def test_returns_none_for_empty_dataframe(self):
        """An empty DataFrame must return None."""
        df = pd.DataFrame(
            columns=["timestamp", "strike", "price", "call_gamma_oi", "put_gamma_oi"]
        )
        result = find_nearest_snapshot(df, "18:00")
        assert result is None

    def test_multiple_equidistant_picks_one(self):
        """When two timestamps are equidistant, one is returned (deterministic)."""
        df = self._make_day_data(["17:55", "18:05"])
        result = find_nearest_snapshot(df, "18:00")
        assert result is not None
        # Both are 5 min away; implementation iterates in order, so 17:55 wins
        ts = result["timestamp"].iloc[0]
        assert ts.hour == 17 and ts.minute == 55

    def test_boundary_exactly_15_min(self):
        """A snapshot exactly 15 min away should still be returned (<=15 check)."""
        df = self._make_day_data(["17:45"])
        result = find_nearest_snapshot(df, "18:00")
        assert result is not None

    def test_boundary_16_min_returns_none(self):
        """A snapshot 16 min away exceeds tolerance and should return None."""
        df = self._make_day_data(["17:44"])
        result = find_nearest_snapshot(df, "18:00")
        assert result is None

    def test_returned_dataframe_is_filtered(self):
        """The returned DataFrame must contain only rows from the chosen timestamp."""
        df = self._make_day_data(["16:00", "18:00", "19:30"])
        result = find_nearest_snapshot(df, "18:00")
        assert result is not None
        unique_ts = result["timestamp"].unique()
        assert len(unique_ts) == 1

    def test_late_day_target(self):
        """Target near close (20:00) picks the final snapshot correctly."""
        df = self._make_day_data(["19:55", "20:00"])
        result = find_nearest_snapshot(df, "20:00")
        assert result is not None
        ts = result["timestamp"].iloc[0]
        assert ts.hour == 20 and ts.minute == 0


# ── compute_oi_pin ────────────────────────────────────────────


class TestComputeOiPin:
    """Tests for compute_oi_pin."""

    def test_empty_dataframe_returns_empty_dict(self):
        """An empty OI snapshot must return {}."""
        df = pd.DataFrame(columns=["strike", "call_oi", "put_oi"])
        assert compute_oi_pin(df) == {}

    def test_all_zero_oi_returns_empty_dict(self):
        """When every OI value is zero, return {}."""
        df = _oi_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_oi=[0, 0, 0, 0, 0],
            put_oi=[0, 0, 0, 0, 0],
        )
        assert compute_oi_pin(df) == {}

    def test_pin_strike_is_highest_total_oi(self):
        """oi_pin_strike must be the strike with the highest combined OI."""
        df = _oi_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_oi=[100, 200, 500, 300, 100],
            put_oi=[50, 100, 400, 200, 50],
        )
        result = compute_oi_pin(df)
        assert result["oi_pin_strike"] == 5800
        assert result["oi_pin_total"] == 900  # 500 + 400

    def test_oi_centroid_is_weighted_average(self):
        """oi_centroid should be the total-OI-weighted average strike."""
        df = _oi_snapshot(
            strikes=[5790, 5810],
            call_oi=[100, 100],
            put_oi=[0, 0],
        )
        result = compute_oi_pin(df)
        # Equal weights at 5790 and 5810 => centroid = 5800
        assert result["oi_centroid"] == pytest.approx(5800.0)

    def test_oi_centroid_skewed(self):
        """Centroid pulls toward the heavier OI strike."""
        df = _oi_snapshot(
            strikes=[5790, 5800, 5810],
            call_oi=[300, 100, 0],
            put_oi=[0, 0, 0],
        )
        result = compute_oi_pin(df)
        # centroid = (5790*300 + 5800*100) / 400 = 5792.5
        assert result["oi_centroid"] == pytest.approx(5792.5)

    def test_put_call_ratio(self):
        """oi_put_call_ratio = total_puts / total_calls."""
        df = _oi_snapshot(
            strikes=[5790, 5800, 5810],
            call_oi=[100, 200, 100],
            put_oi=[200, 400, 200],
        )
        result = compute_oi_pin(df)
        # total_calls = 400, total_puts = 800 => ratio = 2.0
        assert result["oi_put_call_ratio"] == pytest.approx(2.0)

    def test_put_call_ratio_zero_calls(self):
        """When there are no calls, put_call_ratio should be 0.0."""
        df = _oi_snapshot(
            strikes=[5790, 5800],
            call_oi=[0, 0],
            put_oi=[100, 200],
        )
        result = compute_oi_pin(df)
        assert result["oi_put_call_ratio"] == pytest.approx(0.0)

    def test_oi_concentration_top3(self):
        """oi_concentration = sum of top 3 total_oi / overall total."""
        df = _oi_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_oi=[10, 20, 50, 30, 10],
            put_oi=[10, 20, 50, 30, 10],
        )
        result = compute_oi_pin(df)
        # total_oi per strike: 20, 40, 100, 60, 20 => total = 240
        # top 3: 100, 60, 40 = 200
        # concentration = 200 / 240
        assert result["oi_concentration"] == pytest.approx(200 / 240)

    def test_oi_concentration_with_fewer_than_3_strikes(self):
        """When there are <3 strikes, top3 is just all of them."""
        df = _oi_snapshot(
            strikes=[5800, 5810],
            call_oi=[100, 50],
            put_oi=[0, 0],
        )
        result = compute_oi_pin(df)
        # Only 2 strikes; concentration = (100 + 50) / 150 = 1.0
        assert result["oi_concentration"] == pytest.approx(1.0)

    def test_nan_oi_treated_as_zero(self):
        """NaN OI values should be filled to 0."""
        df = _oi_snapshot(
            strikes=[5790, 5800, 5810],
            call_oi=[np.nan, 100, np.nan],
            put_oi=[np.nan, 50, np.nan],
        )
        result = compute_oi_pin(df)
        assert result["oi_pin_strike"] == 5800
        assert result["oi_pin_total"] == 150

    def test_result_keys_complete(self):
        """All expected keys must be present."""
        df = _oi_snapshot(
            strikes=[5790, 5800, 5810],
            call_oi=[100, 200, 100],
            put_oi=[50, 100, 50],
        )
        result = compute_oi_pin(df)
        expected_keys = {
            "oi_pin_strike",
            "oi_pin_total",
            "oi_centroid",
            "oi_put_call_ratio",
            "oi_concentration",
        }
        assert set(result.keys()) == expected_keys

    def test_pin_total_is_int(self):
        """oi_pin_total should be an integer count."""
        df = _oi_snapshot(
            strikes=[5800],
            call_oi=[1000],
            put_oi=[500],
        )
        result = compute_oi_pin(df)
        assert isinstance(result["oi_pin_total"], int)
        assert result["oi_pin_total"] == 1500

    def test_single_strike(self):
        """A single-strike OI snapshot should produce valid results."""
        df = _oi_snapshot(
            strikes=[5800],
            call_oi=[500],
            put_oi=[300],
        )
        result = compute_oi_pin(df)
        assert result["oi_pin_strike"] == 5800.0
        assert result["oi_pin_total"] == 800
        assert result["oi_centroid"] == pytest.approx(5800.0)
        assert result["oi_concentration"] == pytest.approx(1.0)

    def test_tie_at_pin_strike(self):
        """When two strikes have equal total OI, idxmax picks the first."""
        df = _oi_snapshot(
            strikes=[5790, 5800],
            call_oi=[100, 100],
            put_oi=[100, 100],
        )
        result = compute_oi_pin(df)
        # idxmax returns first occurrence
        assert result["oi_pin_strike"] == 5790.0


# ── High-level analysis functions ────────────────────────────


from pin_analysis import (
    analyze_directional_bias,
    analyze_settlement_gravity,
    analyze_time_improvement,
)


def _make_strike_df(n_days=3, n_strikes=5):
    """Build a DataFrame matching load_strike_data output format."""
    rng = np.random.default_rng(42)
    rows = []
    for day_offset in range(n_days):
        date = pd.Timestamp("2026-03-01") + pd.Timedelta(days=day_offset)
        settlement = 5800 + int(rng.integers(-20, 20))
        day_open = settlement + int(rng.integers(-10, 10))
        for hour_min in ["16:00", "18:00", "19:00", "19:30", "20:00"]:
            ts = pd.Timestamp(f"{date.date()} {hour_min}", tz="UTC")
            price = 5800 + int(rng.integers(-15, 15))
            for i in range(n_strikes):
                strike = 5780 + i * 10
                rows.append(
                    {
                        "date": date.date(),
                        "timestamp": ts,
                        "strike": strike,
                        "price": price,
                        "call_gamma_oi": float(rng.integers(1, 50)),
                        "put_gamma_oi": float(rng.integers(-40, 0)),
                        "call_delta_oi": float(rng.integers(1, 100)),
                        "put_delta_oi": float(rng.integers(-100, 0)),
                        "settlement": settlement,
                        "day_open": day_open,
                    }
                )
    return pd.DataFrame(rows)


class TestAnalyzeSettlementGravity:
    """Tests for analyze_settlement_gravity(df)."""

    def test_analyze_settlement_gravity_runs(self, capsys):
        """Runs without error and output contains expected section header."""
        df = _make_strike_df(n_days=3, n_strikes=5)
        analyze_settlement_gravity(df)
        captured = capsys.readouterr()
        assert "SETTLEMENT vs GAMMA" in captured.out


class TestAnalyzeTimeImprovement:
    """Tests for analyze_time_improvement(df)."""

    def test_analyze_time_improvement_runs(self, capsys):
        """Runs without error and output contains expected section header."""
        df = _make_strike_df(n_days=3, n_strikes=5)
        analyze_time_improvement(df)
        captured = capsys.readouterr()
        assert "TIME HORIZON" in captured.out


class TestAnalyzeDirectionalBias:
    """Tests for analyze_directional_bias(df)."""

    def test_analyze_directional_bias_runs(self, capsys):
        """Runs without error and output contains expected section header."""
        df = _make_strike_df(n_days=3, n_strikes=5)
        analyze_directional_bias(df)
        captured = capsys.readouterr()
        assert "GAMMA ASYMMETRY" in captured.out
