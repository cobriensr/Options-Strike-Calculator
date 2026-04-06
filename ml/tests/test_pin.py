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
    call_charm_oi: list[float] | None = None,
    put_charm_oi: list[float] | None = None,
) -> pd.DataFrame:
    """Build a minimal DataFrame mimicking one timestamp's strike data."""
    n = len(strikes)
    data = {
        "strike": strikes,
        "price": [price] * n,
        "call_gamma_oi": call_gamma_oi,
        "put_gamma_oi": put_gamma_oi,
        "call_charm_oi": call_charm_oi if call_charm_oi is not None else [0.0] * n,
        "put_charm_oi": put_charm_oi if put_charm_oi is not None else [0.0] * n,
    }
    return pd.DataFrame(data)


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
            columns=[
                "strike",
                "price",
                "call_gamma_oi",
                "put_gamma_oi",
                "call_charm_oi",
                "put_charm_oi",
            ]
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
        assert result["pos_peak_mag"] == pytest.approx(0.0)

    def test_neg_peak_fallback_when_no_negative_gamma(self):
        """When all net_gamma >= 0, neg_peak defaults to the abs peak strike."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_gamma_oi=[10, 30, 5, 20, 2],
            put_gamma_oi=[0, 0, 0, 0, 0],
        )
        result = compute_gamma_profile(df)
        assert result["neg_peak_strike"] == result["peak_gamma_strike"]
        assert result["neg_peak_mag"] == pytest.approx(0.0)

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
            "charm_centroid",
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
                "call_charm_oi": [0.0, 0.0, 0.0],
                "put_charm_oi": [0.0, 0.0, 0.0],
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

    def test_charm_centroid_boosts_positive_gamma_positive_charm(self):
        """Charm centroid should weight +gamma +charm strikes 1.5x."""
        # Two strikes equidistant from price with equal gamma.
        # 5790: +gamma +charm → 1.5x boost
        # 5810: +gamma -charm → 0.75x boost
        # Charm centroid should pull toward 5790.
        df = _gamma_snapshot(
            strikes=[5790, 5810],
            call_gamma_oi=[10, 10],
            put_gamma_oi=[0, 0],
            price=5800.0,
            call_charm_oi=[5, -5],
            put_charm_oi=[0, 0],
        )
        result = compute_gamma_profile(df)
        # prox_centroid (no charm) → midpoint 5800
        assert result["prox_centroid"] == pytest.approx(5800.0, abs=0.1)
        # charm_centroid should be < 5800 (pulled toward 5790)
        assert result["charm_centroid"] < 5800.0

    def test_charm_centroid_zero_charm_equals_prox(self):
        """When all charm is zero, charm_centroid should equal prox_centroid."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[10, 20, 10],
            put_gamma_oi=[0, 0, 0],
            price=5800.0,
            call_charm_oi=[0, 0, 0],
            put_charm_oi=[0, 0, 0],
        )
        result = compute_gamma_profile(df)
        assert result["charm_centroid"] == pytest.approx(
            result["prox_centroid"], abs=0.01
        )

    def test_charm_centroid_negative_gamma_positive_charm_penalized(self):
        """Negative gamma + positive charm should get 0.5x (weakest boost)."""
        # 5790: -gamma +charm → 0.5x
        # 5810: -gamma -charm → 1.0x
        df = _gamma_snapshot(
            strikes=[5790, 5810],
            call_gamma_oi=[0, 0],
            put_gamma_oi=[-10, -10],
            price=5800.0,
            call_charm_oi=[5, -5],
            put_charm_oi=[0, 0],
        )
        result = compute_gamma_profile(df)
        # 5810 gets higher charm_boost (1.0 vs 0.5) → centroid pulls toward 5810
        assert result["charm_centroid"] > 5800.0

    def test_single_strike_snapshot(self):
        """A single-strike snapshot should still produce valid results."""
        df = _gamma_snapshot(
            strikes=[5800],
            call_gamma_oi=[25],
            put_gamma_oi=[-5],
            price=5800.0,
        )
        result = compute_gamma_profile(df)
        assert result["peak_gamma_strike"] == pytest.approx(5800.0)
        assert result["gamma_centroid"] == pytest.approx(5800.0)
        assert result["pos_centroid"] == pytest.approx(5800.0)
        assert result["prox_centroid"] == pytest.approx(5800.0)
        assert result["charm_centroid"] == pytest.approx(5800.0)
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
        assert result["oi_pin_strike"] == pytest.approx(5800.0)
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
        assert result["oi_pin_strike"] == pytest.approx(5790.0)


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
                        "call_charm_oi": float(rng.integers(-20, 20)),
                        "put_charm_oi": float(rng.integers(-20, 20)),
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

    def test_prints_all_checkpoint_headers(self, capsys):
        """Output should contain each checkpoint's subsection header."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        analyze_settlement_gravity(df)
        captured = capsys.readouterr()
        for cp_name in [
            "T-4hr",
            "T-2hr",
            "T-1hr",
            "T-30min",
            "Final snapshot",
        ]:
            assert cp_name in captured.out

    def test_prints_predictor_names(self, capsys):
        """All seven gamma predictors should appear in output."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        analyze_settlement_gravity(df)
        captured = capsys.readouterr()
        for pred in [
            "Pos γ peak",
            "Neg γ peak",
            "Abs γ peak",
            "All-γ centroid",
            "Pos-γ centroid",
            "Prox-wt centroid",
            "Charm-wt centroid",
        ]:
            assert pred in captured.out, f"Missing predictor: {pred}"

    def test_prints_best_label(self, capsys):
        """Output should contain a 'Best:' line."""
        df = _make_strike_df(n_days=3, n_strikes=5)
        analyze_settlement_gravity(df)
        captured = capsys.readouterr()
        assert "Best:" in captured.out

    def test_single_day(self, capsys):
        """With 1 day of data, should still run without error."""
        df = _make_strike_df(n_days=1, n_strikes=5)
        analyze_settlement_gravity(df)
        captured = capsys.readouterr()
        assert "SETTLEMENT vs GAMMA" in captured.out

    def test_no_data_at_checkpoint_handled(self, capsys):
        """When data has no timestamps near a checkpoint, print 'No data'."""
        # Build data with only 16:00 timestamps — other checkpoints miss
        rows = []
        date = pd.Timestamp("2026-03-01").date()
        ts = pd.Timestamp("2026-03-01 16:00", tz="UTC")
        for strike in [5790, 5800, 5810]:
            rows.append(
                {
                    "date": date,
                    "timestamp": ts,
                    "strike": strike,
                    "price": 5800,
                    "call_gamma_oi": 10.0,
                    "put_gamma_oi": -5.0,
                    "call_charm_oi": 0.0,
                    "put_charm_oi": 0.0,
                    "settlement": 5800,
                    "day_open": 5795,
                }
            )
        df = pd.DataFrame(rows)
        analyze_settlement_gravity(df)
        captured = capsys.readouterr()
        assert "No data available" in captured.out


class TestAnalyzeTimeImprovement:
    """Tests for analyze_time_improvement(df)."""

    def test_analyze_time_improvement_runs(self, capsys):
        """Runs without error and output contains expected section header."""
        df = _make_strike_df(n_days=3, n_strikes=5)
        analyze_time_improvement(df)
        captured = capsys.readouterr()
        assert "TIME HORIZON" in captured.out

    def test_prints_checkpoint_rows(self, capsys):
        """Output should contain avg/median/within stats per checkpoint."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        analyze_time_improvement(df)
        captured = capsys.readouterr()
        # Should have the column headers
        assert "Avg Dist" in captured.out
        assert "Med Dist" in captured.out

    def test_prints_takeaway(self, capsys):
        """With enough data, a TAKEAWAY line should be printed."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        analyze_time_improvement(df)
        captured = capsys.readouterr()
        assert "TAKEAWAY" in captured.out or "Gamma magnet" in captured.out

    def test_no_data_handled(self, capsys):
        """Empty matching data should print 'No data available'."""
        # Build data with timestamps far from all checkpoints
        rows = []
        date = pd.Timestamp("2026-03-01").date()
        ts = pd.Timestamp("2026-03-01 14:00", tz="UTC")
        for strike in [5790, 5800, 5810]:
            rows.append(
                {
                    "date": date,
                    "timestamp": ts,
                    "strike": strike,
                    "price": 5800,
                    "call_gamma_oi": 10.0,
                    "put_gamma_oi": -5.0,
                    "call_charm_oi": 0.0,
                    "put_charm_oi": 0.0,
                    "settlement": 5800,
                    "day_open": 5795,
                }
            )
        df = pd.DataFrame(rows)
        analyze_time_improvement(df)
        captured = capsys.readouterr()
        assert "No data available" in captured.out

    def test_single_checkpoint_no_crash(self, capsys):
        """With data only at one checkpoint, should run without crash."""
        rows = []
        date = pd.Timestamp("2026-03-01").date()
        ts = pd.Timestamp("2026-03-01 19:30", tz="UTC")
        for strike in [5790, 5800, 5810]:
            rows.append(
                {
                    "date": date,
                    "timestamp": ts,
                    "strike": strike,
                    "price": 5800,
                    "call_gamma_oi": 10.0,
                    "put_gamma_oi": -5.0,
                    "call_charm_oi": 0.0,
                    "put_charm_oi": 0.0,
                    "settlement": 5800,
                    "day_open": 5795,
                }
            )
        df = pd.DataFrame(rows)
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

    def test_prints_direction_accuracy(self, capsys):
        """Output should contain the directional prediction accuracy line."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        analyze_directional_bias(df)
        captured = capsys.readouterr()
        assert "predicts settlement direction" in captured.out

    def test_prints_gamma_above_below_breakdown(self, capsys):
        """Output should break down by gamma above/below ATM."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        analyze_directional_bias(df)
        captured = capsys.readouterr()
        # At least one of these substrings should appear
        assert "gamma ABOVE ATM" in captured.out or "gamma BELOW ATM" in captured.out

    def test_prints_takeaway(self, capsys):
        """A TAKEAWAY should always be printed with valid data."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        analyze_directional_bias(df)
        captured = capsys.readouterr()
        assert "TAKEAWAY" in captured.out

    def test_no_data_handled(self, capsys):
        """When no snapshots match 18:00 UTC, print 'No data available'."""
        rows = []
        date = pd.Timestamp("2026-03-01").date()
        ts = pd.Timestamp("2026-03-01 14:00", tz="UTC")
        for strike in [5790, 5800, 5810]:
            rows.append(
                {
                    "date": date,
                    "timestamp": ts,
                    "strike": strike,
                    "price": 5800,
                    "call_gamma_oi": 10.0,
                    "put_gamma_oi": -5.0,
                    "settlement": 5800,
                    "day_open": 5795,
                }
            )
        df = pd.DataFrame(rows)
        analyze_directional_bias(df)
        captured = capsys.readouterr()
        assert "No data available" in captured.out

    def test_forced_high_accuracy_prints_predictive_takeaway(self, capsys):
        """When gamma asymmetry consistently predicts direction, takeaway says so."""
        # Build data where more_gamma_above == settled_up always
        rows = []
        for day_offset in range(10):
            date = (pd.Timestamp("2026-03-01") + pd.Timedelta(days=day_offset)).date()
            # settlement > day_open => settled_up = True
            settlement = 5810.0
            day_open = 5790.0
            ts = pd.Timestamp(f"2026-03-{1 + day_offset:02d} 18:00", tz="UTC")
            # More positive gamma above price => more_gamma_above = True
            # Price = 5800, strikes above: 5810, 5820 (high call gamma)
            for strike, cg, pg in [
                (5780, 1.0, -1.0),
                (5790, 2.0, -1.0),
                (5800, 3.0, -1.0),
                (5810, 30.0, 0.0),
                (5820, 25.0, 0.0),
            ]:
                rows.append(
                    {
                        "date": date,
                        "timestamp": ts,
                        "strike": strike,
                        "price": 5800,
                        "call_gamma_oi": cg,
                        "put_gamma_oi": pg,
                        "settlement": settlement,
                        "day_open": day_open,
                    }
                )
        df = pd.DataFrame(rows)
        analyze_directional_bias(df)
        captured = capsys.readouterr()
        assert "predictive power" in captured.out

    def test_forced_anti_signal_prints_anti_takeaway(self, capsys):
        """When gamma asymmetry anti-predicts direction, takeaway says so."""
        rows = []
        for day_offset in range(10):
            date = (pd.Timestamp("2026-03-01") + pd.Timedelta(days=day_offset)).date()
            # settlement < day_open => settled_up = False
            settlement = 5790.0
            day_open = 5810.0
            ts = pd.Timestamp(f"2026-03-{1 + day_offset:02d} 18:00", tz="UTC")
            # More positive gamma above price => more_gamma_above = True
            # But settled DOWN, so anti-correlation
            for strike, cg, pg in [
                (5780, 1.0, -1.0),
                (5790, 2.0, -1.0),
                (5800, 3.0, -1.0),
                (5810, 30.0, 0.0),
                (5820, 25.0, 0.0),
            ]:
                rows.append(
                    {
                        "date": date,
                        "timestamp": ts,
                        "strike": strike,
                        "price": 5800,
                        "call_gamma_oi": cg,
                        "put_gamma_oi": pg,
                        "settlement": settlement,
                        "day_open": day_open,
                    }
                )
        df = pd.DataFrame(rows)
        analyze_directional_bias(df)
        captured = capsys.readouterr()
        assert "ANTI-SIGNAL" in captured.out


# ── analyze_all_predictors ──────────────────────────────────


from pin_analysis import analyze_all_predictors


def _make_max_pain_df(dates: list, strikes: list[float] | None = None):
    """Build a max_pain_df matching load_max_pain output format."""
    if strikes is None:
        strikes = [5800.0] * len(dates)
    rows = []
    for date, mp in zip(dates, strikes):
        rows.append(
            {
                "date": date,
                "max_pain_0dte": mp,
                "max_pain_dist": abs(5800 - mp),
                "spx_open": 5795.0,
            }
        )
    return pd.DataFrame(rows)


def _make_oi_df(dates: list):
    """Build an oi_df matching load_oi_per_strike output format."""
    rows = []
    for date in dates:
        for strike in [5780, 5790, 5800, 5810, 5820]:
            rows.append(
                {
                    "date": date,
                    "strike": float(strike),
                    "call_oi": 500.0,
                    "put_oi": 300.0,
                    "total_oi": 800.0,
                }
            )
    return pd.DataFrame(rows)


class TestAnalyzeAllPredictors:
    """Tests for analyze_all_predictors(df, max_pain_df, oi_df)."""

    def test_runs_with_all_data(self, capsys):
        """Runs without error when all three data sources present."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        dates = sorted(df["date"].unique())
        max_pain_df = _make_max_pain_df(dates)
        oi_df = _make_oi_df(dates)
        analyze_all_predictors(df, max_pain_df, oi_df)
        captured = capsys.readouterr()
        assert "ALL PREDICTORS HEAD-TO-HEAD" in captured.out

    def test_runs_with_empty_max_pain(self, capsys):
        """Runs without error when max_pain_df is empty."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        dates = sorted(df["date"].unique())
        oi_df = _make_oi_df(dates)
        analyze_all_predictors(df, pd.DataFrame(), oi_df)
        captured = capsys.readouterr()
        assert "ALL PREDICTORS HEAD-TO-HEAD" in captured.out

    def test_runs_with_empty_oi(self, capsys):
        """Runs without error when oi_df is empty."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        dates = sorted(df["date"].unique())
        max_pain_df = _make_max_pain_df(dates)
        analyze_all_predictors(df, max_pain_df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "ALL PREDICTORS HEAD-TO-HEAD" in captured.out

    def test_runs_with_both_empty(self, capsys):
        """Runs without error when both max_pain and OI are empty."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        analyze_all_predictors(df, pd.DataFrame(), pd.DataFrame())
        captured = capsys.readouterr()
        assert "ALL PREDICTORS HEAD-TO-HEAD" in captured.out

    def test_prints_best_line(self, capsys):
        """Output should contain a 'Best:' line."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        dates = sorted(df["date"].unique())
        max_pain_df = _make_max_pain_df(dates)
        oi_df = _make_oi_df(dates)
        analyze_all_predictors(df, max_pain_df, oi_df)
        captured = capsys.readouterr()
        assert "Best:" in captured.out

    def test_prints_per_day_winner(self, capsys):
        """Output should contain the per-day winner section."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        dates = sorted(df["date"].unique())
        max_pain_df = _make_max_pain_df(dates)
        oi_df = _make_oi_df(dates)
        analyze_all_predictors(df, max_pain_df, oi_df)
        captured = capsys.readouterr()
        assert "predictor won each day" in captured.out

    def test_prints_takeaway(self, capsys):
        """TAKEAWAY should be printed."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        dates = sorted(df["date"].unique())
        max_pain_df = _make_max_pain_df(dates)
        oi_df = _make_oi_df(dates)
        analyze_all_predictors(df, max_pain_df, oi_df)
        captured = capsys.readouterr()
        assert "TAKEAWAY" in captured.out

    def test_no_data_at_checkpoint_handled(self, capsys):
        """When no snapshots match T-30min or T-1hr, print no-data message."""
        rows = []
        date = pd.Timestamp("2026-03-01").date()
        ts = pd.Timestamp("2026-03-01 14:00", tz="UTC")
        for strike in [5790, 5800, 5810]:
            rows.append(
                {
                    "date": date,
                    "timestamp": ts,
                    "strike": strike,
                    "price": 5800,
                    "call_gamma_oi": 10.0,
                    "put_gamma_oi": -5.0,
                    "settlement": 5800,
                    "day_open": 5795,
                }
            )
        df = pd.DataFrame(rows)
        analyze_all_predictors(df, pd.DataFrame(), pd.DataFrame())
        captured = capsys.readouterr()
        assert "No days with strike data" in captured.out

    def test_gamma_predictors_present_in_output(self, capsys):
        """All gamma predictor names should appear in output."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        dates = sorted(df["date"].unique())
        max_pain_df = _make_max_pain_df(dates)
        oi_df = _make_oi_df(dates)
        analyze_all_predictors(df, max_pain_df, oi_df)
        captured = capsys.readouterr()
        for pred in [
            "Pos γ Peak",
            "Abs γ Peak",
            "All-γ Centroid",
            "Pos-γ Centroid",
            "Prox-wt Centroid",
        ]:
            assert pred in captured.out, f"Missing predictor: {pred}"


# ── analyze_per_day_detail ──────────────────────────────────


from pin_analysis import analyze_per_day_detail


class TestAnalyzePerDayDetail:
    """Tests for analyze_per_day_detail(df, max_pain_df)."""

    def test_runs_without_error(self, capsys):
        """Runs without error with valid data."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        dates = sorted(df["date"].unique())
        max_pain_df = _make_max_pain_df(dates)
        analyze_per_day_detail(df, max_pain_df)
        captured = capsys.readouterr()
        assert "RECENT DAY DETAIL" in captured.out

    def test_runs_with_empty_max_pain(self, capsys):
        """Runs without error when max_pain_df is empty."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        analyze_per_day_detail(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "RECENT DAY DETAIL" in captured.out

    def test_limits_to_10_days(self, capsys):
        """With >10 days, should only show last 10."""
        df = _make_strike_df(n_days=15, n_strikes=5)
        dates = sorted(df["date"].unique())
        max_pain_df = _make_max_pain_df(dates)
        analyze_per_day_detail(df, max_pain_df)
        captured = capsys.readouterr()
        # Count date lines in output (YYYY-MM-DD pattern)
        import re

        date_lines = re.findall(r"\d{4}-\d{2}-\d{2}", captured.out)
        # There should be at most 10 unique dates printed
        assert len(set(date_lines)) <= 10

    def test_prints_column_headers(self, capsys):
        """Output should contain column headers."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        analyze_per_day_detail(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "Settle" in captured.out
        assert "Dist" in captured.out

    def test_max_pain_dashes_when_missing(self, capsys):
        """When max pain data is missing, show dashes."""
        df = _make_strike_df(n_days=3, n_strikes=5)
        analyze_per_day_detail(df, pd.DataFrame())
        captured = capsys.readouterr()
        # The dash character should appear for missing max pain values
        lines = captured.out.split("\n")
        # Check that some data lines contain the em-dash
        data_lines = [line for line in lines if "2026-03" in line]
        assert any("—" in line for line in data_lines)


# ── key_findings ────────────────────────────────────────────


from pin_analysis import key_findings


class TestKeyFindings:
    """Tests for key_findings(df, max_pain_df)."""

    def test_runs_without_error(self, capsys):
        """Runs without error with valid data."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        dates = sorted(df["date"].unique())
        max_pain_df = _make_max_pain_df(dates)
        key_findings(df, max_pain_df)
        captured = capsys.readouterr()
        assert "KEY FINDINGS" in captured.out

    def test_runs_with_empty_max_pain(self, capsys):
        """Runs without error when max_pain_df is empty."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        key_findings(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "KEY FINDINGS" in captured.out

    def test_prints_prox_centroid_section(self, capsys):
        """Output should contain prox-weighted centroid section."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        key_findings(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "PROX-WEIGHTED CENTROID" in captured.out

    def test_prints_gamma_centroid_section(self, capsys):
        """Output should contain all-gamma centroid section."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        key_findings(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "ALL-GAMMA CENTROID" in captured.out

    def test_prints_max_pain_section(self, capsys):
        """Output should mention max pain."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        key_findings(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "MAX PAIN" in captured.out

    def test_prints_recommendation(self, capsys):
        """Output should contain a recommendation section."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        key_findings(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "RECOMMENDATION" in captured.out

    def test_prints_within_stats(self, capsys):
        """Output should show within +-10/+-20 stats."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        key_findings(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "Within" in captured.out

    def test_with_max_pain_data(self, capsys):
        """When max pain data is present, it should appear in the output."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        dates = sorted(df["date"].unique())
        max_pain_df = _make_max_pain_df(dates, [5800.0] * len(dates))
        key_findings(df, max_pain_df)
        captured = capsys.readouterr()
        assert "MAX PAIN" in captured.out
        # Should NOT say "No max pain data"
        assert "No max pain data" not in captured.out

    def test_no_data_at_checkpoint(self, capsys):
        """When no T-30min snapshots, prints appropriate message."""
        rows = []
        date = pd.Timestamp("2026-03-01").date()
        ts = pd.Timestamp("2026-03-01 14:00", tz="UTC")
        for strike in [5790, 5800, 5810]:
            rows.append(
                {
                    "date": date,
                    "timestamp": ts,
                    "strike": strike,
                    "price": 5800,
                    "call_gamma_oi": 10.0,
                    "put_gamma_oi": -5.0,
                    "settlement": 5800,
                    "day_open": 5795,
                }
            )
        df = pd.DataFrame(rows)
        key_findings(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "No data at T-30min" in captured.out


# ── gamma_concentration ─────────────────────────────────────


from pin_analysis import gamma_concentration


class TestGammaConcentration:
    """Tests for gamma_concentration(snapshot)."""

    def test_all_gamma_in_single_strike(self):
        """When all gamma is at one strike, concentration should be 1.0."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[0, 50, 0],
            put_gamma_oi=[0, 0, 0],
        )
        result = gamma_concentration(df)
        assert result == pytest.approx(1.0)

    def test_all_gamma_in_three_strikes(self):
        """When all gamma is in exactly 3 strikes, concentration is 1.0."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[10, 20, 30],
            put_gamma_oi=[0, 0, 0],
        )
        result = gamma_concentration(df)
        assert result == pytest.approx(1.0)

    def test_uniform_distribution_five_strikes(self):
        """With 5 equal-gamma strikes, concentration = 3/5 = 0.6."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_gamma_oi=[10, 10, 10, 10, 10],
            put_gamma_oi=[0, 0, 0, 0, 0],
        )
        result = gamma_concentration(df)
        assert result == pytest.approx(0.6)

    def test_uniform_distribution_ten_strikes(self):
        """With 10 equal-gamma strikes, concentration = 3/10 = 0.3."""
        strikes = list(range(5780, 5880, 10))
        n = len(strikes)
        df = _gamma_snapshot(
            strikes=strikes,
            call_gamma_oi=[10] * n,
            put_gamma_oi=[0] * n,
        )
        result = gamma_concentration(df)
        assert result == pytest.approx(0.3)

    def test_zero_gamma_returns_zero(self):
        """When all gamma is zero, return 0.0."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[0, 0, 0],
            put_gamma_oi=[0, 0, 0],
        )
        result = gamma_concentration(df)
        assert result == pytest.approx(0.0)

    def test_negative_gamma_uses_absolute_values(self):
        """Negative gamma should be counted by absolute value."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[0, 0, 0],
            put_gamma_oi=[-10, -20, -30],
        )
        result = gamma_concentration(df)
        # abs_g: [10, 20, 30], top3 = all = 60, total = 60
        assert result == pytest.approx(1.0)

    def test_mixed_positive_negative(self):
        """Mixed positive and negative gamma, concentration uses |net_gamma|."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_gamma_oi=[5, 10, 30, 8, 3],
            put_gamma_oi=[-3, -8, -5, -2, -1],
        )
        # net_gamma: [2, 2, 25, 6, 2], abs_g: [2, 2, 25, 6, 2]
        # total = 37, top3 = 25 + 6 + 2 = 33
        result = gamma_concentration(df)
        assert result == pytest.approx(33 / 37, abs=0.01)

    def test_returns_float(self):
        """Result should always be a float."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[10, 20, 30],
            put_gamma_oi=[0, 0, 0],
        )
        result = gamma_concentration(df)
        assert isinstance(result, float)

    def test_nan_treated_as_zero(self):
        """NaN gamma values should be treated as zero."""
        df = _gamma_snapshot(
            strikes=[5790, 5800, 5810],
            call_gamma_oi=[np.nan, 20, np.nan],
            put_gamma_oi=[np.nan, 0, np.nan],
        )
        result = gamma_concentration(df)
        # Only 5800 has gamma: top3 = 20, total = 20 => 1.0
        assert result == pytest.approx(1.0)

    def test_string_values_coerced(self):
        """String gamma values should be coerced via pd.to_numeric."""
        df = pd.DataFrame(
            {
                "strike": [5790, 5800, 5810],
                "price": [5800, 5800, 5800],
                "call_gamma_oi": ["bad", "20", "10"],
                "put_gamma_oi": ["0", "0", "0"],
            }
        )
        result = gamma_concentration(df)
        # "bad" becomes NaN -> 0; abs_g: [0, 20, 10], top3 = 30, total = 30
        assert result == pytest.approx(1.0)

    def test_single_strike(self):
        """A single-strike snapshot should have concentration 1.0."""
        df = _gamma_snapshot(
            strikes=[5800],
            call_gamma_oi=[50],
            put_gamma_oi=[-10],
        )
        result = gamma_concentration(df)
        assert result == pytest.approx(1.0)

    def test_two_strikes(self):
        """With 2 strikes, top 3 captures both => concentration = 1.0."""
        df = _gamma_snapshot(
            strikes=[5790, 5800],
            call_gamma_oi=[10, 20],
            put_gamma_oi=[0, 0],
        )
        result = gamma_concentration(df)
        assert result == pytest.approx(1.0)

    def test_skewed_distribution(self):
        """A heavily skewed distribution concentrates in top 3."""
        df = _gamma_snapshot(
            strikes=[5780, 5790, 5800, 5810, 5820],
            call_gamma_oi=[1, 1, 100, 1, 1],
            put_gamma_oi=[0, 0, 0, 0, 0],
        )
        # abs_g: [1, 1, 100, 1, 1], top3 = 100+1+1=102, total = 104
        result = gamma_concentration(df)
        assert result == pytest.approx(102 / 104, abs=0.01)


# ── DB loading functions (mocked) ───────────────────────────


from unittest.mock import MagicMock, patch

from pin_analysis import load_max_pain, load_oi_per_strike, load_strike_data


class TestLoadStrikeData:
    """Tests for load_strike_data (mocked DB)."""

    @patch("pin_analysis.load_env")
    def test_exits_without_database_url(self, mock_env):
        """Should exit when DATABASE_URL is missing."""
        mock_env.return_value = {}
        with pytest.raises(SystemExit):
            load_strike_data()

    @patch("pin_analysis.load_env")
    def test_invalid_dte_filter_raises(self, mock_env):
        """Invalid dte_filter should raise ValueError."""
        mock_env.return_value = {"DATABASE_URL": "postgresql://fake"}
        with pytest.raises(ValueError, match="Invalid dte_filter"):
            load_strike_data("invalid")

    @patch("pin_analysis.create_engine")
    @patch("pin_analysis.load_env")
    def test_returns_dataframe_with_correct_columns(self, mock_env, mock_engine):
        """Should return a DataFrame with expected columns."""
        mock_env.return_value = {"DATABASE_URL": "postgresql://fake"}

        # Create a mock engine that returns a known DataFrame
        fake_df = pd.DataFrame(
            {
                "date": ["2026-03-01", "2026-03-01"],
                "timestamp": [
                    "2026-03-01 16:00:00+00:00",
                    "2026-03-01 16:00:00+00:00",
                ],
                "strike": [5800.0, 5810.0],
                "price": [5800.0, 5800.0],
                "call_gamma_oi": [10.0, 20.0],
                "put_gamma_oi": [-5.0, -3.0],
                "call_delta_oi": [50.0, 60.0],
                "put_delta_oi": [-40.0, -30.0],
                "settlement": [5805.0, 5805.0],
                "day_open": [5795.0, 5795.0],
            }
        )

        engine_instance = MagicMock()
        mock_engine.return_value = engine_instance

        with patch("pin_analysis.pd.read_sql_query", return_value=fake_df):
            result = load_strike_data("0dte")

        assert "date" in result.columns
        assert "timestamp" in result.columns
        assert "settlement" in result.columns
        engine_instance.dispose.assert_called_once()


class TestLoadOiPerStrike:
    """Tests for load_oi_per_strike (mocked DB)."""

    @patch("pin_analysis.load_env")
    def test_returns_empty_without_database_url(self, mock_env):
        """Should return empty DataFrame when DATABASE_URL is missing."""
        mock_env.return_value = {}
        result = load_oi_per_strike()
        assert isinstance(result, pd.DataFrame)
        assert len(result) == 0

    @patch("pin_analysis.create_engine")
    @patch("pin_analysis.load_env")
    def test_returns_empty_when_table_missing(self, mock_env, mock_engine):
        """Should return empty DataFrame when oi_per_strike table doesn't exist."""
        mock_env.return_value = {"DATABASE_URL": "postgresql://fake"}

        engine_instance = MagicMock()
        mock_engine.return_value = engine_instance

        # First call: EXISTS check returns False
        check_df = pd.DataFrame({0: [False]})
        with patch("pin_analysis.pd.read_sql_query", return_value=check_df):
            result = load_oi_per_strike()

        assert len(result) == 0
        engine_instance.dispose.assert_called_once()

    @patch("pin_analysis.create_engine")
    @patch("pin_analysis.load_env")
    def test_returns_empty_on_exception(self, mock_env, mock_engine):
        """Should return empty DataFrame on SQL exception."""
        mock_env.return_value = {"DATABASE_URL": "postgresql://fake"}

        engine_instance = MagicMock()
        mock_engine.return_value = engine_instance

        with patch(
            "pin_analysis.pd.read_sql_query",
            side_effect=Exception("DB error"),
        ):
            result = load_oi_per_strike()

        assert len(result) == 0
        engine_instance.dispose.assert_called_once()


class TestLoadMaxPain:
    """Tests for load_max_pain (mocked DB)."""

    @patch("pin_analysis.load_env")
    def test_returns_empty_without_database_url(self, mock_env):
        """Should return empty DataFrame when DATABASE_URL is missing."""
        mock_env.return_value = {}
        result = load_max_pain()
        assert isinstance(result, pd.DataFrame)
        assert len(result) == 0

    @patch("pin_analysis.create_engine")
    @patch("pin_analysis.load_env")
    def test_returns_dataframe_on_success(self, mock_env, mock_engine):
        """Should return DataFrame with converted date column."""
        mock_env.return_value = {"DATABASE_URL": "postgresql://fake"}

        engine_instance = MagicMock()
        mock_engine.return_value = engine_instance

        fake_df = pd.DataFrame(
            {
                "date": ["2026-03-01", "2026-03-02"],
                "max_pain_0dte": [5800.0, 5810.0],
                "max_pain_dist": [5.0, 3.0],
                "spx_open": [5795.0, 5807.0],
            }
        )

        with patch("pin_analysis.pd.read_sql_query", return_value=fake_df):
            result = load_max_pain()

        assert len(result) == 2
        assert pd.api.types.is_datetime64_any_dtype(result["date"])
        engine_instance.dispose.assert_called_once()

    @patch("pin_analysis.create_engine")
    @patch("pin_analysis.load_env")
    def test_returns_empty_on_exception(self, mock_env, mock_engine):
        """Should return empty DataFrame on SQL exception."""
        mock_env.return_value = {"DATABASE_URL": "postgresql://fake"}

        engine_instance = MagicMock()
        mock_engine.return_value = engine_instance

        with patch(
            "pin_analysis.pd.read_sql_query",
            side_effect=Exception("DB error"),
        ):
            result = load_max_pain()

        assert len(result) == 0
        engine_instance.dispose.assert_called_once()

    @patch("pin_analysis.create_engine")
    @patch("pin_analysis.load_env")
    def test_returns_empty_when_no_rows(self, mock_env, mock_engine):
        """Should return empty DataFrame when query returns 0 rows."""
        mock_env.return_value = {"DATABASE_URL": "postgresql://fake"}

        engine_instance = MagicMock()
        mock_engine.return_value = engine_instance

        empty_df = pd.DataFrame(
            columns=["date", "max_pain_0dte", "max_pain_dist", "spx_open"]
        )

        with patch("pin_analysis.pd.read_sql_query", return_value=empty_df):
            result = load_max_pain()

        assert len(result) == 0


# ── Additional edge-case tests for uncovered branches ───────


class TestLoadOiPerStrikeSuccess:
    """Tests for the successful load path in load_oi_per_strike."""

    @patch("pin_analysis.create_engine")
    @patch("pin_analysis.load_env")
    def test_successful_load_returns_data(self, mock_env, mock_engine):
        """When table exists and has data, return converted DataFrame."""
        mock_env.return_value = {"DATABASE_URL": "postgresql://fake"}

        engine_instance = MagicMock()
        mock_engine.return_value = engine_instance

        # First call: EXISTS check returns True
        check_df = pd.DataFrame({0: [True]})
        # Second call: actual data
        data_df = pd.DataFrame(
            {
                "date": ["2026-03-01", "2026-03-01"],
                "strike": [5800.0, 5810.0],
                "call_oi": [500.0, 300.0],
                "put_oi": [200.0, 400.0],
                "total_oi": [700.0, 700.0],
            }
        )

        with patch(
            "pin_analysis.pd.read_sql_query",
            side_effect=[check_df, data_df],
        ):
            result = load_oi_per_strike()

        assert len(result) == 2
        assert pd.api.types.is_datetime64_any_dtype(result["date"])
        engine_instance.dispose.assert_called_once()

    @patch("pin_analysis.create_engine")
    @patch("pin_analysis.load_env")
    def test_empty_table_returns_empty(self, mock_env, mock_engine):
        """When table exists but has no rows, return empty DataFrame."""
        mock_env.return_value = {"DATABASE_URL": "postgresql://fake"}

        engine_instance = MagicMock()
        mock_engine.return_value = engine_instance

        check_df = pd.DataFrame({0: [True]})
        empty_df = pd.DataFrame(
            columns=["date", "strike", "call_oi", "put_oi", "total_oi"]
        )

        with patch(
            "pin_analysis.pd.read_sql_query",
            side_effect=[check_df, empty_df],
        ):
            result = load_oi_per_strike()

        assert len(result) == 0


class TestAnalyzeDirectionalBiasNonPredictive:
    """Test the 'not predictive' branch of analyze_directional_bias."""

    def test_neutral_accuracy_prints_not_predictive(self, capsys):
        """When accuracy is 45-55%, print non-predictive takeaway."""
        # Build data where gamma asymmetry is roughly 50/50 predictive
        # Half days: more_gamma_above AND settled_up (correct)
        # Half days: more_gamma_above AND settled_down (wrong)
        rows = []
        for day_offset in range(20):
            date = (pd.Timestamp("2026-03-01") + pd.Timedelta(days=day_offset)).date()
            # date string not needed — date object used directly below
            # Alternate: correct on even days, wrong on odd days
            if day_offset % 2 == 0:
                settlement = 5810.0  # settled up
                day_open = 5790.0
            else:
                settlement = 5790.0  # settled down
                day_open = 5810.0
            ts = pd.Timestamp(f"{date} 18:00", tz="UTC")
            # Always more gamma above (above 5800)
            for strike, cg, pg in [
                (5780, 1.0, -1.0),
                (5790, 2.0, -1.0),
                (5800, 3.0, -1.0),
                (5810, 30.0, 0.0),
                (5820, 25.0, 0.0),
            ]:
                rows.append(
                    {
                        "date": date,
                        "timestamp": ts,
                        "strike": strike,
                        "price": 5800,
                        "call_gamma_oi": cg,
                        "put_gamma_oi": pg,
                        "settlement": settlement,
                        "day_open": day_open,
                    }
                )
        df = pd.DataFrame(rows)
        analyze_directional_bias(df)
        captured = capsys.readouterr()
        assert "not directionally predictive" in captured.out


class TestAnalyzeSettlementGravityEmptyProfile:
    """Test the empty-profile branch in analyze_settlement_gravity."""

    def test_zero_gamma_snapshot_triggers_continue(self, capsys):
        """When a snapshot exists but has zero gamma, skip that day."""
        rows = []
        for day_offset in range(3):
            date = (pd.Timestamp("2026-03-01") + pd.Timedelta(days=day_offset)).date()
            for hour_min in ["16:00", "18:00", "19:00", "19:30", "20:00"]:
                ts = pd.Timestamp(f"{date} {hour_min}", tz="UTC")
                for strike in [5790, 5800, 5810]:
                    rows.append(
                        {
                            "date": date,
                            "timestamp": ts,
                            "strike": strike,
                            "price": 5800,
                            "call_gamma_oi": 0.0,
                            "put_gamma_oi": 0.0,
                            "settlement": 5800,
                            "day_open": 5795,
                        }
                    )
        df = pd.DataFrame(rows)
        analyze_settlement_gravity(df)
        captured = capsys.readouterr()
        # All profiles will be empty, so every checkpoint should say no data
        assert "No data available" in captured.out


class TestAnalyzeTimeImprovementEmptyProfile:
    """Test the empty-profile branch in analyze_time_improvement."""

    def test_zero_gamma_triggers_no_data(self, capsys):
        """When all snapshots have zero gamma, print no data."""
        rows = []
        for day_offset in range(3):
            date = (pd.Timestamp("2026-03-01") + pd.Timedelta(days=day_offset)).date()
            for hour_min in ["16:00", "18:00", "19:00", "19:30", "20:00"]:
                ts = pd.Timestamp(f"{date} {hour_min}", tz="UTC")
                for strike in [5790, 5800, 5810]:
                    rows.append(
                        {
                            "date": date,
                            "timestamp": ts,
                            "strike": strike,
                            "price": 5800,
                            "call_gamma_oi": 0.0,
                            "put_gamma_oi": 0.0,
                            "settlement": 5800,
                            "day_open": 5795,
                        }
                    )
        df = pd.DataFrame(rows)
        analyze_time_improvement(df)
        captured = capsys.readouterr()
        assert "No data available" in captured.out


class TestAnalyzeDirectionalBiasEmptyProfile:
    """Test the empty-profile branch in analyze_directional_bias."""

    def test_zero_gamma_triggers_no_data(self, capsys):
        """When all snapshots have zero gamma, print no data."""
        rows = []
        for day_offset in range(3):
            date = (pd.Timestamp("2026-03-01") + pd.Timedelta(days=day_offset)).date()
            ts = pd.Timestamp(f"{date} 18:00", tz="UTC")
            for strike in [5790, 5800, 5810]:
                rows.append(
                    {
                        "date": date,
                        "timestamp": ts,
                        "strike": strike,
                        "price": 5800,
                        "call_gamma_oi": 0.0,
                        "put_gamma_oi": 0.0,
                        "settlement": 5800,
                        "day_open": 5795,
                    }
                )
        df = pd.DataFrame(rows)
        analyze_directional_bias(df)
        captured = capsys.readouterr()
        assert "No data available" in captured.out


class TestAnalyzeAllPredictorsEmptyProfile:
    """Test the empty-profile branch in analyze_all_predictors."""

    def test_zero_gamma_at_t30_triggers_no_days(self, capsys):
        """When all snapshots have zero gamma, print no-days message."""
        rows = []
        for day_offset in range(3):
            date = (pd.Timestamp("2026-03-01") + pd.Timedelta(days=day_offset)).date()
            for hour_min in ["19:00", "19:30"]:
                ts = pd.Timestamp(f"{date} {hour_min}", tz="UTC")
                for strike in [5790, 5800, 5810]:
                    rows.append(
                        {
                            "date": date,
                            "timestamp": ts,
                            "strike": strike,
                            "price": 5800,
                            "call_gamma_oi": 0.0,
                            "put_gamma_oi": 0.0,
                            "settlement": 5800,
                            "day_open": 5795,
                        }
                    )
        df = pd.DataFrame(rows)
        analyze_all_predictors(df, pd.DataFrame(), pd.DataFrame())
        captured = capsys.readouterr()
        assert "No days with strike data" in captured.out

    def test_oi_with_zero_oi_at_dates(self, capsys):
        """When OI data exists but compute_oi_pin returns empty."""
        df = _make_strike_df(n_days=5, n_strikes=5)
        dates = sorted(df["date"].unique())
        # Build OI df with all zeros (so compute_oi_pin returns {})
        oi_rows = []
        for date in dates:
            for strike in [5780, 5790, 5800, 5810, 5820]:
                oi_rows.append(
                    {
                        "date": date,
                        "strike": float(strike),
                        "call_oi": 0.0,
                        "put_oi": 0.0,
                        "total_oi": 0.0,
                    }
                )
        oi_df = pd.DataFrame(oi_rows)
        analyze_all_predictors(df, pd.DataFrame(), oi_df)
        captured = capsys.readouterr()
        assert "ALL PREDICTORS HEAD-TO-HEAD" in captured.out


class TestAnalyzePerDayDetailFallback:
    """Test the snapshot fallback paths in analyze_per_day_detail."""

    def test_fallback_to_t30min_when_no_20(self, capsys):
        """When no 20:00 snapshot, should fall back to 19:30."""
        rows = []
        for day_offset in range(3):
            date = (pd.Timestamp("2026-03-01") + pd.Timedelta(days=day_offset)).date()
            # Only provide 19:30 timestamp, not 20:00
            ts = pd.Timestamp(f"{date} 19:30", tz="UTC")
            for strike in [5790, 5800, 5810]:
                rows.append(
                    {
                        "date": date,
                        "timestamp": ts,
                        "strike": strike,
                        "price": 5800,
                        "call_gamma_oi": 10.0,
                        "put_gamma_oi": -5.0,
                        "settlement": 5800,
                        "day_open": 5795,
                    }
                )
        df = pd.DataFrame(rows)
        analyze_per_day_detail(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "RECENT DAY DETAIL" in captured.out
        # Should still produce date lines
        assert "2026-03" in captured.out

    def test_no_snapshot_at_all_skips_day(self, capsys):
        """When no snapshot near 20:00 or 19:30, skip the day."""
        rows = []
        for day_offset in range(3):
            date = (pd.Timestamp("2026-03-01") + pd.Timedelta(days=day_offset)).date()
            ts = pd.Timestamp(f"{date} 14:00", tz="UTC")
            for strike in [5790, 5800, 5810]:
                rows.append(
                    {
                        "date": date,
                        "timestamp": ts,
                        "strike": strike,
                        "price": 5800,
                        "call_gamma_oi": 10.0,
                        "put_gamma_oi": -5.0,
                        "settlement": 5800,
                        "day_open": 5795,
                    }
                )
        df = pd.DataFrame(rows)
        analyze_per_day_detail(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "RECENT DAY DETAIL" in captured.out
        # No date lines in output since all days skipped
        import re

        date_lines = re.findall(r"2026-03-\d{2}\s+\d{4}", captured.out)
        assert len(date_lines) == 0

    def test_zero_gamma_skips_day(self, capsys):
        """When snapshot has zero gamma, skip the day."""
        rows = []
        for day_offset in range(3):
            date = (pd.Timestamp("2026-03-01") + pd.Timedelta(days=day_offset)).date()
            ts = pd.Timestamp(f"{date} 20:00", tz="UTC")
            for strike in [5790, 5800, 5810]:
                rows.append(
                    {
                        "date": date,
                        "timestamp": ts,
                        "strike": strike,
                        "price": 5800,
                        "call_gamma_oi": 0.0,
                        "put_gamma_oi": 0.0,
                        "settlement": 5800,
                        "day_open": 5795,
                    }
                )
        df = pd.DataFrame(rows)
        analyze_per_day_detail(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "RECENT DAY DETAIL" in captured.out


class TestKeyFindingsEmptyProfile:
    """Test the empty-profile branch in key_findings."""

    def test_zero_gamma_prints_no_data_message(self, capsys):
        """When all snapshots have zero gamma at T-30min."""
        rows = []
        for day_offset in range(3):
            date = (pd.Timestamp("2026-03-01") + pd.Timedelta(days=day_offset)).date()
            ts = pd.Timestamp(f"{date} 19:30", tz="UTC")
            for strike in [5790, 5800, 5810]:
                rows.append(
                    {
                        "date": date,
                        "timestamp": ts,
                        "strike": strike,
                        "price": 5800,
                        "call_gamma_oi": 0.0,
                        "put_gamma_oi": 0.0,
                        "settlement": 5800,
                        "day_open": 5795,
                    }
                )
        df = pd.DataFrame(rows)
        key_findings(df, pd.DataFrame())
        captured = capsys.readouterr()
        assert "No data at T-30min" in captured.out
