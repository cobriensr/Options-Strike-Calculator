"""
Tests for the PURE compute functions in ml/src/lottery_scoring.py.

This is the nightly `make refit` script that trains the rescore-v1 lottery
score model. The weight math here feeds the live TypeScript scoring path, so
these functions are worth locking down with hand-computed expectations.

I/O functions (`fetch_training_data`, `main`) require a live Postgres + the
filesystem and are intentionally NOT covered here — they are smoke-tested
elsewhere / in production. We target the six pure functions:

  quintile_boundaries, assign_quintile, compute_categorical_weights,
  compute_quintile_weights, compute_ticker_weights, apply_weights

All frames are synthetic and built inline so every assertion is computable
by hand.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from lottery_scoring import (
    MIN_OBS_BUCKET,
    TICKER_CLAMP_MAX,
    TICKER_CLAMP_MIN,
    apply_weights,
    assign_quintile,
    compute_categorical_weights,
    compute_quintile_weights,
    compute_ticker_weights,
    quintile_boundaries,
)

# ---------------------------------------------------------------------------
# quintile_boundaries
# ---------------------------------------------------------------------------


def test_quintile_boundaries_matches_numpy_percentile():
    """Returns exactly the [20,40,60,80] percentiles of the clean series."""
    series = pd.Series(list(range(1, 11)))  # 1..10
    expected = [float(np.percentile(series, p)) for p in (20, 40, 60, 80)]
    assert quintile_boundaries(series) == expected
    # Sanity: linear interpolation on 1..10 -> 2.8, 4.6, 6.4, 8.2
    assert quintile_boundaries(series) == pytest.approx([2.8, 4.6, 6.4, 8.2])


def test_quintile_boundaries_drops_nans():
    """NaNs are dropped before computing percentiles (NaNs would poison them)."""
    with_nan = pd.Series([1.0, 2.0, np.nan, 3.0, np.nan, 4.0, 5.0])
    clean = pd.Series([1.0, 2.0, 3.0, 4.0, 5.0])
    assert quintile_boundaries(with_nan) == quintile_boundaries(clean)


def test_quintile_boundaries_constant_series_collapses():
    """A constant series yields four identical boundaries (degenerate but valid)."""
    series = pd.Series([7.0] * 20)
    assert quintile_boundaries(series) == [7.0, 7.0, 7.0, 7.0]


def test_quintile_boundaries_all_nan_raises():
    """An all-NaN series has nothing to percentile and the code raises."""
    all_nan = pd.Series([np.nan, np.nan, np.nan])
    with pytest.raises((IndexError, ValueError)):
        quintile_boundaries(all_nan)


# ---------------------------------------------------------------------------
# assign_quintile
# ---------------------------------------------------------------------------


def test_assign_quintile_buckets_with_right_closed_bins():
    """
    bins = [-inf, b0, b1, b2, b3, inf], right=True (upper bound inclusive).

    With boundaries [2, 4, 6, 8]:
      v <= 2      -> Q1 (0)
      2 < v <= 4  -> Q2 (1)
      4 < v <= 6  -> Q3 (2)
      6 < v <= 8  -> Q4 (3)
      v > 8       -> Q5 (4)
    """
    boundaries = [2.0, 4.0, 6.0, 8.0]
    series = pd.Series([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])
    result = assign_quintile(series, boundaries)
    expected = pd.Series([0, 0, 1, 1, 2, 2, 3, 3, 4, 4], dtype=float)
    pd.testing.assert_series_equal(result, expected, check_names=False)


def test_assign_quintile_at_and_below_lowest_boundary():
    """Values at or below the lowest boundary land in Q1 (0)."""
    boundaries = [10.0, 20.0, 30.0, 40.0]
    series = pd.Series([-100.0, 0.0, 10.0])  # all <= 10
    result = assign_quintile(series, boundaries)
    assert list(result) == [0.0, 0.0, 0.0]


def test_assign_quintile_at_and_above_highest_boundary():
    """Value == highest boundary lands in Q4 (right-inclusive); above it Q5."""
    boundaries = [10.0, 20.0, 30.0, 40.0]
    series = pd.Series([40.0, 40.0001, 1000.0])
    result = assign_quintile(series, boundaries)
    # 40.0 is the upper edge of the Q4 bin (right=True) -> 3; anything above -> 4
    assert list(result) == [3.0, 4.0, 4.0]


def test_assign_quintile_nan_value_stays_nan():
    """A NaN input value yields NaN (pd.cut passes NaN through)."""
    boundaries = [2.0, 4.0, 6.0, 8.0]
    result = assign_quintile(pd.Series([np.nan, 5.0]), boundaries)
    assert np.isnan(result.iloc[0])
    assert result.iloc[1] == 2.0


# ---------------------------------------------------------------------------
# compute_categorical_weights
# ---------------------------------------------------------------------------


def _categorical_frame() -> pd.DataFrame:
    """
    Two categories, each well above MIN_OBS_BUCKET, with known means:
      cat 'A': outcome_pct = 10 on every row  -> mean 10
      cat 'B': outcome_pct = 0  on every row  -> mean 0
    global_mean passed in by the test.
    """
    n = MIN_OBS_BUCKET + 10  # 40 rows each, comfortably over the floor
    rows = [{"feat": "A", "outcome_pct": 10.0} for _ in range(n)]
    rows += [{"feat": "B", "outcome_pct": 0.0} for _ in range(n)]
    return pd.DataFrame(rows)


def test_compute_categorical_weights_hand_computed():
    """
    weight = round(scale * (mean_bucket - global_mean) / spread)
    spread = max_mean - min_mean = 10 - 0 = 10.
    global_mean = 5, scale = 8.

      A: round(8 * (10 - 5) / 10) = round(4.0) = 4
      B: round(8 * (0  - 5) / 10) = round(-4.0) = -4
    """
    df = _categorical_frame()
    weights = compute_categorical_weights(
        df, "feat", ["A", "B"], scale=8.0, global_mean=5.0
    )
    assert weights == {"A": 4, "B": -4}


def test_compute_categorical_weights_keys_are_strings():
    """Integer categories are stringified in the returned dict keys."""
    n = MIN_OBS_BUCKET + 5
    rows = [{"feat": 0, "outcome_pct": 2.0} for _ in range(n)]
    rows += [{"feat": 1, "outcome_pct": 8.0} for _ in range(n)]
    df = pd.DataFrame(rows)
    weights = compute_categorical_weights(
        df, "feat", [0, 1], scale=6.0, global_mean=5.0
    )
    assert set(weights.keys()) == {"0", "1"}
    # spread = 8-2 = 6; "0": round(6*(2-5)/6)=-3 ; "1": round(6*(8-5)/6)=3
    assert weights == {"0": -3, "1": 3}


def test_compute_categorical_weights_below_floor_falls_back_to_global():
    """
    A bucket with < MIN_OBS_BUCKET rows gets the global mean, so its uplift
    is zero. Here B is under-populated, so the only real spread comes from A.
    """
    big = [{"feat": "A", "outcome_pct": 10.0} for _ in range(MIN_OBS_BUCKET + 5)]
    tiny = [{"feat": "B", "outcome_pct": -50.0} for _ in range(3)]  # under floor
    df = pd.DataFrame(big + tiny)
    weights = compute_categorical_weights(
        df, "feat", ["A", "B"], scale=8.0, global_mean=5.0
    )
    # B falls back to global_mean (5) -> bucket_means {A:10, B:5}; spread=5
    #   A: round(8*(10-5)/5) = round(8.0) = 8
    #   B: round(8*(5-5)/5)  = 0
    assert weights == {"A": 8, "B": 0}


def test_compute_categorical_weights_zero_spread_returns_zeros():
    """When all buckets share one mean (spread < 1e-6) every weight is 0."""
    n = MIN_OBS_BUCKET + 5
    rows = [{"feat": "A", "outcome_pct": 4.0} for _ in range(n)]
    rows += [{"feat": "B", "outcome_pct": 4.0} for _ in range(n)]
    df = pd.DataFrame(rows)
    weights = compute_categorical_weights(
        df, "feat", ["A", "B"], scale=8.0, global_mean=4.0
    )
    assert weights == {"A": 0, "B": 0}


# ---------------------------------------------------------------------------
# compute_quintile_weights
# ---------------------------------------------------------------------------


def _quintile_frame(means: list[float]) -> pd.DataFrame:
    """Build a frame with quintile labels 0..4 stored as float, each with a
    given per-quintile constant outcome_pct and >= MIN_OBS_BUCKET rows."""
    n = MIN_OBS_BUCKET + 5
    rows = []
    for q, m in enumerate(means):
        rows += [{"q": float(q), "outcome_pct": m} for _ in range(n)]
    return pd.DataFrame(rows)


def test_compute_quintile_weights_inverted_u_gradient():
    """
    Inverted-U intent (Q3 sweet spot): feed an outcome gradient peaking at Q3.
    means = [0, 5, 10, 5, 0], global_mean = 4, scale = 5, spread = 10-0 = 10.

      Q1: round(5*(0-4)/10)  = round(-2.0) = -2
      Q2: round(5*(5-4)/10)  = round(0.5)  = 0   (banker's rounding: 0.5 -> 0)
      Q3: round(5*(10-4)/10) = round(3.0)  = 3   (highest)
      Q4: round(5*(5-4)/10)  = 0
      Q5: round(5*(0-4)/10)  = -2
    """
    df = _quintile_frame([0.0, 5.0, 10.0, 5.0, 0.0])
    weights = compute_quintile_weights(df, "q", scale=5.0, global_mean=4.0)
    assert weights == [-2, 0, 3, 0, -2]
    # The documented inverted-U intent: Q3 is the unique maximum.
    assert weights[2] == max(weights)


def test_compute_quintile_weights_monotonic_decreasing():
    """
    Monotonic-decreasing gradient (ask_pct intent): Q1 highest, Q5 lowest.
    means = [10, 8, 6, 4, 2], global_mean = 6, scale = 6, spread = 8.

      Q1: round(6*(10-6)/8) = round(3.0)  = 3
      Q2: round(6*(8-6)/8)  = round(1.5)  = 2   (0.5-up at 1.5 -> 2)
      Q3: round(6*(6-6)/8)  = 0
      Q4: round(6*(4-6)/8)  = round(-1.5) = -2  (banker's: -1.5 -> -2)
      Q5: round(6*(2-6)/8)  = round(-3.0) = -3
    """
    df = _quintile_frame([10.0, 8.0, 6.0, 4.0, 2.0])
    weights = compute_quintile_weights(df, "q", scale=6.0, global_mean=6.0)
    assert weights == [3, 2, 0, -2, -3]
    assert weights[0] == max(weights)
    assert weights == sorted(weights, reverse=True)


def test_compute_quintile_weights_returns_five_ints():
    df = _quintile_frame([1.0, 2.0, 3.0, 4.0, 5.0])
    weights = compute_quintile_weights(df, "q", scale=5.0, global_mean=3.0)
    assert len(weights) == 5
    assert all(isinstance(w, int) for w in weights)


def test_compute_quintile_weights_zero_spread_returns_zeros():
    df = _quintile_frame([3.0, 3.0, 3.0, 3.0, 3.0])
    assert compute_quintile_weights(df, "q", scale=5.0, global_mean=3.0) == [
        0,
        0,
        0,
        0,
        0,
    ]


def test_compute_quintile_weights_underpopulated_quintile_falls_back():
    """
    Quintiles with < MIN_OBS_BUCKET rows fall back to global_mean (zero uplift).
    Q1 and Q5 are well-populated (means 0 and 10); Q2/Q3/Q4 have only a few
    rows each, so they collapse to global_mean = 5.
    spread = 10 - 0 = 10, scale = 5.
      Q1: round(5*(0-5)/10)  = round(-2.5) = -2  (banker's: -2.5 -> -2)
      Q2: round(5*(5-5)/10)  = 0
      Q3: 0
      Q4: 0
      Q5: round(5*(10-5)/10) = round(2.5)  = 2   (banker's: 2.5 -> 2)
    """
    big = MIN_OBS_BUCKET + 5
    rows = [{"q": 0.0, "outcome_pct": 0.0} for _ in range(big)]
    rows += [{"q": 4.0, "outcome_pct": 10.0} for _ in range(big)]
    rows += [{"q": float(q), "outcome_pct": -999.0} for q in (1, 2, 3) for _ in range(3)]
    df = pd.DataFrame(rows)
    assert compute_quintile_weights(df, "q", scale=5.0, global_mean=5.0) == [
        -2,
        0,
        0,
        0,
        2,
    ]


# ---------------------------------------------------------------------------
# compute_ticker_weights
# ---------------------------------------------------------------------------


def _ticker_frame(specs: dict[str, tuple[float, int]]) -> pd.DataFrame:
    """specs: {ticker: (per-row outcome_pct, row count)}."""
    rows = []
    for ticker, (outcome, count) in specs.items():
        rows += [
            {"underlying_symbol": ticker, "outcome_pct": outcome}
            for _ in range(count)
        ]
    return pd.DataFrame(rows)


def test_compute_ticker_weights_hand_computed():
    """
    Two reliable tickers (>= min_obs). scale = ASK_PCT_SCALE = 6.
      LOW : mean 0,  n 120
      HIGH: mean 12, n 120
    global_mean = 6. spread = max-min over reliable = 12 - 0 = 12.

      LOW : round(6*(0-6)/12)  = round(-3.0) = -3
      HIGH: round(6*(12-6)/12) = round(3.0)  = 3
    """
    df = _ticker_frame({"LOW": (0.0, 120), "HIGH": (12.0, 120)})
    weights = compute_ticker_weights(df, global_mean=6.0, min_obs=100)
    assert weights == {"LOW": -3, "HIGH": 3}


def test_compute_ticker_weights_below_min_obs_is_zero():
    """A ticker under min_obs gets weight 0 regardless of its mean."""
    df = _ticker_frame(
        {
            "BIG_A": (0.0, 120),
            "BIG_B": (12.0, 120),
            "THIN": (999.0, 5),  # under min_obs -> 0
        }
    )
    weights = compute_ticker_weights(df, global_mean=6.0, min_obs=100)
    assert weights["THIN"] == 0


def test_compute_ticker_weights_clamps_high_end():
    """
    An extreme positive ticker is clamped to TICKER_CLAMP_MAX (+10).

    spread = max_reliable_mean - min_reliable_mean. Since the outlier IS a
    reliable ticker it always defines the max, so to blow past the clamp we
    push global_mean FAR below the cluster: the (mean - global_mean) numerator
    grows much faster than the spread.
      A: mean 100, n 200
      B: mean 110, n 200   -> spread = 110 - 100 = 10
    global_mean = 5.
      B raw = 6 * (110 - 5) / 10 = 63.0  -> clamp to TICKER_CLAMP_MAX (+10)
      A raw = 6 * (100 - 5) / 10 = 57.0  -> clamp to TICKER_CLAMP_MAX (+10)
    """
    df = _ticker_frame({"A": (100.0, 200), "B": (110.0, 200)})
    weights = compute_ticker_weights(df, global_mean=5.0, min_obs=100)
    assert weights["B"] == TICKER_CLAMP_MAX
    assert weights["A"] == TICKER_CLAMP_MAX


def test_compute_ticker_weights_clamps_low_end():
    """
    An extreme negative ticker is clamped to TICKER_CLAMP_MIN (-5).
    Mirror of the high-end test: push global_mean FAR above the cluster.
      A: mean -100, n 200
      B: mean -110, n 200   -> spread = -100 - (-110) = 10
    global_mean = 5.
      B raw = 6 * (-110 - 5) / 10 = -69.0 -> clamp to TICKER_CLAMP_MIN (-5)
      A raw = 6 * (-100 - 5) / 10 = -63.0 -> clamp to TICKER_CLAMP_MIN (-5)
    """
    df = _ticker_frame({"A": (-100.0, 200), "B": (-110.0, 200)})
    weights = compute_ticker_weights(df, global_mean=5.0, min_obs=100)
    assert weights["B"] == TICKER_CLAMP_MIN
    assert weights["A"] == TICKER_CLAMP_MIN


def test_compute_ticker_weights_identical_reliable_means_use_fallback_spread():
    """
    Two reliable tickers with identical means give spread ~ 0, so the code
    falls back to spread = max(global_mean, 10). With both means == global_mean
    the numerator is 0 -> every weight is 0 (no clamp triggered).
    """
    df = _ticker_frame({"A": (8.0, 200), "B": (8.0, 200)})
    weights = compute_ticker_weights(df, global_mean=8.0, min_obs=100)
    assert weights == {"A": 0, "B": 0}


def test_compute_ticker_weights_fewer_than_two_reliable_uses_fallback_spread():
    """
    With < 2 reliable tickers the code uses spread = max(global_mean, 10).
    One reliable ticker (mean 30, n 200); global_mean = 5 -> spread = max(5,10)=10.
      raw = 6*(30-5)/10 = 15.0 -> clamped to TICKER_CLAMP_MAX (+10).
    """
    df = _ticker_frame({"SOLO": (30.0, 200), "THIN": (0.0, 5)})
    weights = compute_ticker_weights(df, global_mean=5.0, min_obs=100)
    assert weights["SOLO"] == TICKER_CLAMP_MAX
    assert weights["THIN"] == 0


# ---------------------------------------------------------------------------
# apply_weights
# ---------------------------------------------------------------------------


def _full_weights() -> dict:
    """Minimal weights dict with the feature blocks apply_weights reads."""
    return {
        "features": {
            "tod_weights": {"AM_open": 4, "MID": 0, "LUNCH": -4, "PM": -4},
            "dte_weights": {"0": -2, "1": 4, "2": 0, "3": 1},
            "vol_oi_quintile_weights": [1, 0, 2, 0, -3],
            "gamma_quintile_weights": [3, -2, -2, -2, 0],
            "ask_pct_quintile_weights": [-1, 1, 1, 2, -4],
            "option_type_weights": {"C": 2, "P": -2},
            "ticker_weights": {"AMD": 5, "QQQ": -3},
        }
    }


# Quintile boundaries used for the apply_weights tests (chosen so the test
# rows fall in known quintiles).
_VOL_OI_B = [0.06, 0.10, 0.15, 0.38]
_GAMMA_B = [0.012, 0.025, 0.042, 0.068]
_ASK_B = [0.53, 0.57, 0.625, 0.75]


def test_apply_weights_sums_all_feature_contributions():
    """
    One row, hand-computed total. With the boundaries above:
      trigger_vol_to_oi_window = 0.20 -> 0.15 < 0.20 <= 0.38 -> Q4 (idx 3) -> 0
      gamma_at_trigger        = 0.05 -> 0.042 < 0.05 <= 0.068 -> Q4 (idx 3) -> -2
      trigger_ask_pct         = 0.55 -> 0.53 < 0.55 <= 0.57 -> Q2 (idx 1) -> 1
      tod = AM_open -> 4
      dte = 1       -> 4
      option_type = C -> 2
      underlying_symbol = AMD -> 5
    total = 4 + 4 + 0 + (-2) + 1 + 2 + 5 = 14
    """
    df = pd.DataFrame(
        [
            {
                "tod": "AM_open",
                "dte": 1,
                "trigger_vol_to_oi_window": 0.20,
                "gamma_at_trigger": 0.05,
                "trigger_ask_pct": 0.55,
                "option_type": "C",
                "underlying_symbol": "AMD",
            }
        ]
    )
    score = apply_weights(df, _full_weights(), _VOL_OI_B, _GAMMA_B, _ASK_B)
    assert score.iloc[0] == pytest.approx(14.0)


def test_apply_weights_dte_clipped_at_three():
    """dte values above 3 are clipped to '3' before the dte_weights lookup."""
    df = pd.DataFrame(
        [
            {
                "tod": "MID",
                "dte": 7,  # clipped to 3 -> weight 1
                "trigger_vol_to_oi_window": 0.01,  # <= 0.06 -> Q1 -> 1
                "gamma_at_trigger": 0.005,  # <= 0.012 -> Q1 -> 3
                "trigger_ask_pct": 0.50,  # <= 0.53 -> Q1 -> -1
                "option_type": "P",  # -2
                "underlying_symbol": "QQQ",  # -3
            }
        ]
    )
    # MID(0) + dte3(1) + volQ1(1) + gammaQ1(3) + askQ1(-1) + P(-2) + QQQ(-3) = -1
    score = apply_weights(df, _full_weights(), _VOL_OI_B, _GAMMA_B, _ASK_B)
    assert score.iloc[0] == pytest.approx(-1.0)


def test_apply_weights_null_gamma_contributes_zero():
    """A NULL gamma_at_trigger yields a NaN quintile -> 0 contribution."""
    df = pd.DataFrame(
        [
            {
                "tod": "MID",  # 0
                "dte": 0,  # -2
                "trigger_vol_to_oi_window": 0.01,  # Q1 -> 1
                "gamma_at_trigger": np.nan,  # NaN -> 0
                "trigger_ask_pct": 0.50,  # Q1 -> -1
                "option_type": "C",  # 2
                "underlying_symbol": "AMD",  # 5
            }
        ]
    )
    # 0 + (-2) + 1 + 0(gamma) + (-1) + 2 + 5 = 5
    score = apply_weights(df, _full_weights(), _VOL_OI_B, _GAMMA_B, _ASK_B)
    assert score.iloc[0] == pytest.approx(5.0)


def test_apply_weights_unseen_ticker_and_tod_default_to_zero():
    """
    Features whose value is absent from the weights dict contribute 0
    (the .map(...).fillna(0) path). Here ticker 'NEVERSEEN' and tod 'WEIRD'
    are unknown, so only the quintile/dte/option contributions remain.
    """
    df = pd.DataFrame(
        [
            {
                "tod": "WEIRD",  # unseen -> 0
                "dte": 1,  # 4
                "trigger_vol_to_oi_window": 0.01,  # Q1 -> 1
                "gamma_at_trigger": 0.005,  # Q1 -> 3
                "trigger_ask_pct": 0.50,  # Q1 -> -1
                "option_type": "C",  # 2
                "underlying_symbol": "NEVERSEEN",  # unseen -> 0
            }
        ]
    )
    # 0(tod) + 4(dte) + 1(vol) + 3(gamma) + (-1)(ask) + 2(opt) + 0(ticker) = 9
    score = apply_weights(df, _full_weights(), _VOL_OI_B, _GAMMA_B, _ASK_B)
    assert score.iloc[0] == pytest.approx(9.0)


def test_apply_weights_returns_series_indexed_like_input():
    """The returned Series shares the input frame's (non-default) index."""
    df = pd.DataFrame(
        [
            {
                "tod": "AM_open",
                "dte": 1,
                "trigger_vol_to_oi_window": 0.20,
                "gamma_at_trigger": 0.05,
                "trigger_ask_pct": 0.55,
                "option_type": "C",
                "underlying_symbol": "AMD",
            },
            {
                "tod": "PM",
                "dte": 0,
                "trigger_vol_to_oi_window": 0.50,
                "gamma_at_trigger": 0.10,
                "trigger_ask_pct": 0.90,
                "option_type": "P",
                "underlying_symbol": "QQQ",
            },
        ],
        index=[10, 20],
    )
    score = apply_weights(df, _full_weights(), _VOL_OI_B, _GAMMA_B, _ASK_B)
    assert list(score.index) == [10, 20]
    assert len(score) == 2
