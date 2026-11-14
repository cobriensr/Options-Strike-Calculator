"""
Tests for ml/src/lottery_scoring.py, the training half of the nightly refit.

The module trains the lottery score weights. Its weight math feeds the live
TypeScript scorer, so the pure functions (quintile_boundaries, assign_quintile,
compute_categorical_weights, compute_quintile_weights, compute_ticker_weights)
are locked down with hand-computed expectations, and the refit's entry points
are tested on synthetic frames:

  TRAINING_FILTER_SQL / TRAINING_COLUMNS   the one definition of the training
                                           population (plan D7)
  fetch_frame / drop_bug_rows              the explicit-window read, through a
                                           fake cursor
  train_weights                            a validated weights object, no side
                                           effects
  main                                     a dry run that writes nothing

Every frame is synthetic. Nothing reaches a database: the connection is a fake.
The import test and the main tests need scipy and ``utils``, which the nightly
image does not have; the rest of this file needs only numpy and pandas.
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import lottery_scoring as ls
from lottery_scoring import (
    MIN_OBS_BUCKET,
    SINGLE_LEG_FILTER,
    TICKER_CLAMP_MAX,
    TICKER_CLAMP_MIN,
    TRAINING_COLUMNS,
    TRAINING_FILTER_SQL,
    assign_quintile,
    compute_categorical_weights,
    compute_quintile_weights,
    compute_ticker_weights,
    drop_bug_rows,
    fetch_frame,
    quintile_boundaries,
    train_weights,
)
from lottery_weights import WeightsInvalid, score_frame, validate_weights

ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT / "ml" / "src"
OUTPUT_DIR = ROOT / "ml" / "output"

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
    rows += [
        {"q": float(q), "outcome_pct": -999.0} for q in (1, 2, 3) for _ in range(3)
    ]
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
            {"underlying_symbol": ticker, "outcome_pct": outcome} for _ in range(count)
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
# Synthetic training data and a fake connection
# ---------------------------------------------------------------------------

TODS = ("AM_open", "MID", "LUNCH", "PM")
THROUGH = date(2026, 6, 1)
OUTCOME_COLUMNS = (
    "realized_flow_inversion_pct",
    "realized_eod_pct",
    "peak_ceiling_pct",
)
TEXT_COLUMNS = ("underlying_symbol", "option_type", "tod")
NUMERIC_COLUMNS = tuple(c for c in TRAINING_COLUMNS if c not in (*TEXT_COLUMNS, "date"))
SEED_FIXTURE = json.loads(
    (ROOT / "api" / "__tests__" / "fixtures" / "lottery-score-parity.json").read_text(
        encoding="utf-8"
    )
)


def _base() -> dict:
    """The seed weights, with one composite the synthetic fires match and feed
    cutoffs that differ from the seed's, so a copy shows."""
    w = copy.deepcopy(SEED_FIXTURE["weights"])
    w["features"]["composite_bonuses"] = [
        {
            "match": {"ticker": "AAA", "tod": "AM_open"},
            "bonus": 10,
            "support": 50,
            "win_rate": 0.9,
            "note": "synthetic composite",
        }
    ]
    w["feed_cutoffs"] = {"tier1_min_score": 17, "tier2_min_score": 11}
    return w


def _training_frame(sessions: int = 60, per_session: int = 20) -> pd.DataFrame:
    """Aligned single-leg fires as ``fetch_frame`` returns them, outcome included.

    Sixty sessions from Monday 2026-03-02, so 12 Mondays of 20 fires: enough for
    the Monday override. Three tickers of 400 fires each. The outcome carries a
    signal on tod, option type, DTE 3 and vol/OI, and Mondays invert the LUNCH
    effect, so the Monday override differs from the global table. The EOD
    outcome is not a monotone function of the inversion one: a rank correlation
    against the wrong column would differ.
    """
    rng = np.random.default_rng(7)
    days = [d.date() for d in pd.bdate_range("2026-03-02", periods=sessions)]
    n = sessions * per_session
    i = np.arange(n)
    option_type = np.where(i % 2 == 0, "C", "P")
    tod = np.array(TODS)[(i // 2) % 4]
    ticker = np.array(["AAA", "BBB", "CCC"])[i % 3]
    dte = (i // 5) % 4
    session_dates = np.repeat(np.array(days, dtype=object), per_session)
    is_monday = np.array([d.weekday() == 0 for d in session_dates])
    vol_oi = rng.uniform(0.01, 1.0, n)
    flow_inversion = (
        20.0 * (tod == "AM_open")
        - 10.0 * (option_type == "P")
        + 10.0 * (dte == 3)
        + 30.0 * vol_oi
        + 40.0 * (is_monday & (tod == "LUNCH"))
        + rng.normal(0.0, 15.0, n)
    )
    df = pd.DataFrame(
        {
            "underlying_symbol": ticker,
            "option_type": option_type,
            "tod": tod,
            "dte": dte,
            "trigger_vol_to_oi_window": vol_oi,
            "gamma_at_trigger": rng.uniform(0.001, 0.1, n),
            "trigger_ask_pct": rng.uniform(0.3, 1.0, n),
            "cum_ncp_at_fire": np.where(option_type == "C", 2e6, 1e6),
            "cum_npp_at_fire": np.where(option_type == "C", 1e6, 2e6),
            "date": session_dates,
            "realized_flow_inversion_pct": flow_inversion,
            "realized_eod_pct": 0.5 * flow_inversion + rng.normal(0.0, 20.0, n),
            "peak_ceiling_pct": np.maximum(flow_inversion, 0.0) + 50.0,
        }
    )
    df["outcome_pct"] = flow_inversion
    return df[[*TRAINING_COLUMNS, "outcome_pct"]]


def _db_value(column: str, value: object) -> object:
    """A cell as psycopg2 returns it: NUMERIC as Decimal, NULL as None."""
    if column not in NUMERIC_COLUMNS:
        return value
    if pd.isna(value):
        return None
    return int(value) if column == "dte" else Decimal(repr(float(value)))


def _db_rows(df: pd.DataFrame) -> list[tuple]:
    return [
        tuple(_db_value(c, rec[c]) for c in TRAINING_COLUMNS)
        for rec in df[list(TRAINING_COLUMNS)].to_dict("records")
    ]


class _FakeCursor:
    def __init__(self, conn: _FakeConnection) -> None:
        self._conn = conn

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def execute(self, sql: str, params: object = None) -> None:
        self._conn.executed.append((sql, params))

    def fetchall(self) -> list[tuple]:
        return list(self._conn.rows)

    def fetchone(self) -> tuple | None:
        return self._conn.pointer_row


class _FakeConnection:
    """What the refit's reads touch: ``cursor``, ``set_session`` and ``close``."""

    def __init__(self, rows: list[tuple], pointer_row: tuple | None = None) -> None:
        self.rows = rows
        self.pointer_row = pointer_row
        self.executed: list[tuple[str, object]] = []
        self.session: dict = {}
        self.closed = False

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    def set_session(self, **kwargs: object) -> None:
        self.session = kwargs

    def close(self) -> None:
        self.closed = True


def _percentile_cutoffs(scores: pd.Series) -> dict[str, int]:
    """round(p95), round(p85) of the scored (non-NA) rows, as the plan words it."""
    values = scores.dropna().to_numpy(dtype="float64")
    return {
        "t1": int(round(np.percentile(values, 95))),
        "t2": int(round(np.percentile(values, 85))),
    }


# ---------------------------------------------------------------------------
# The training population (plan D7)
# ---------------------------------------------------------------------------


def test_single_leg_filter_is_the_exchange_derived_kind() -> None:
    assert SINGLE_LEG_FILTER == "anchor_leg_kind = 'single'"


def test_training_filter_sql_is_aligned_single_leg_with_an_outcome() -> None:
    sql = " ".join(TRAINING_FILTER_SQL.split())
    assert "cum_ncp_at_fire IS NOT NULL" in sql
    assert "cum_npp_at_fire IS NOT NULL" in sql
    assert "option_type = 'C' AND cum_ncp_at_fire > cum_npp_at_fire" in sql
    assert "option_type = 'P' AND cum_npp_at_fire > cum_ncp_at_fire" in sql
    assert SINGLE_LEG_FILTER in sql
    assert "COALESCE(realized_flow_inversion_pct, realized_eod_pct) IS NOT NULL" in sql
    # No filter on how the inversion was sourced (D7): a row still waiting for
    # its tape inversion falls back to realized_eod_pct.
    assert "inversion_source" not in sql
    assert "inferred_structure" not in sql


def test_training_columns_are_the_score_columns_and_the_outcome_columns() -> None:
    from lottery_weights import SCORE_COLUMNS

    assert set(SCORE_COLUMNS) <= set(TRAINING_COLUMNS)
    assert set(OUTCOME_COLUMNS) <= set(TRAINING_COLUMNS)
    assert "date" in TRAINING_COLUMNS
    # A name listed twice would be selected twice and give a duplicate column.
    assert len(set(TRAINING_COLUMNS)) == len(TRAINING_COLUMNS)


def test_fetch_frame_binds_an_explicit_window() -> None:
    conn = _FakeConnection(rows=[])
    fetch_frame(conn, date(2026, 3, 3), date(2026, 6, 1))

    [(sql, params)] = conn.executed
    assert params == (date(2026, 3, 3), date(2026, 6, 1))
    assert all(type(p) is date for p in params)
    flat = " ".join(sql.split())
    assert flat.startswith("SELECT ")
    assert "FROM lottery_finder_fires" in flat
    assert ", ".join(TRAINING_COLUMNS) in flat
    # The window is open at the start and closed at the end (D7).
    assert "date > %s AND date <= %s" in flat
    assert " ".join(TRAINING_FILTER_SQL.split()) in flat
    assert flat.endswith("ORDER BY date")


def test_module_never_reads_a_clock_for_its_window() -> None:
    text = Path(ls.__file__).read_text(encoding="utf-8")
    for token in ("CURRENT_DATE", "NOW()", "today()"):
        assert token not in text


def test_fetch_frame_with_no_rows_returns_an_empty_frame_with_the_columns() -> None:
    df = fetch_frame(_FakeConnection(rows=[]), date(2026, 3, 3), date(2026, 6, 1))
    assert len(df) == 0
    assert list(df.columns) == [*TRAINING_COLUMNS, "outcome_pct"]


def test_fetch_frame_builds_float_columns_and_the_outcome() -> None:
    src = _training_frame(sessions=3, per_session=4)
    # Row 0 has no inversion yet: its outcome is the held-to-EOD fallback.
    src.loc[0, "realized_flow_inversion_pct"] = np.nan
    conn = _FakeConnection(_db_rows(src))

    df = fetch_frame(conn, date(2026, 1, 1), date(2026, 12, 31))

    assert list(df.columns) == [*TRAINING_COLUMNS, "outcome_pct"]
    for column in (*NUMERIC_COLUMNS, "outcome_pct"):
        assert df[column].dtype == "float64", column
    assert df.loc[0, "outcome_pct"] == pytest.approx(src.loc[0, "realized_eod_pct"])
    assert df.loc[1, "outcome_pct"] == pytest.approx(
        src.loc[1, "realized_flow_inversion_pct"]
    )
    assert df["date"].tolist() == src["date"].tolist()
    assert df["underlying_symbol"].tolist() == src["underlying_symbol"].tolist()


def test_fetch_frame_drops_the_enrichment_bug_signature() -> None:
    src = _training_frame(sessions=3, per_session=4)
    src.loc[2, "realized_flow_inversion_pct"] = src.loc[2, "peak_ceiling_pct"] * 1.5
    conn = _FakeConnection(_db_rows(src))

    df = fetch_frame(conn, date(2026, 1, 1), date(2026, 12, 31))

    assert len(df) == len(src) - 1
    assert (df["realized_flow_inversion_pct"] <= df["peak_ceiling_pct"] * 1.05).all()


@pytest.mark.parametrize(
    ("flow_inversion", "peak", "dropped"),
    [
        (106.0, 100.0, True),  # above peak * 1.05: impossible for clean data
        (105.0, 100.0, False),  # exactly peak * 1.05 stays
        (104.0, 100.0, False),
        (-30.0, 100.0, False),
        (500.0, np.nan, False),  # no peak to compare with
        (np.nan, 100.0, False),  # no inversion yet: the EOD fallback row
    ],
)
def test_drop_bug_rows(flow_inversion: float, peak: float, dropped: bool) -> None:
    df = pd.DataFrame(
        {
            "realized_flow_inversion_pct": [flow_inversion],
            "peak_ceiling_pct": [peak],
            "marker": [1],
        }
    )
    assert len(drop_bug_rows(df)) == (0 if dropped else 1)


def test_drop_bug_rows_keeps_the_other_rows_and_leaves_the_input_alone() -> None:
    df = pd.DataFrame(
        {
            "realized_flow_inversion_pct": [10.0, 200.0, np.nan, 50.0],
            "peak_ceiling_pct": [100.0, 100.0, 100.0, 100.0],
            "marker": ["a", "b", "c", "d"],
        },
        index=[10, 11, 12, 13],
    )
    before = df.copy(deep=True)

    kept = drop_bug_rows(df)

    assert list(kept["marker"]) == ["a", "c", "d"]
    assert list(kept.index) == [10, 12, 13]
    pd.testing.assert_frame_equal(df, before)
    kept.loc[10, "marker"] = "changed"  # a copy, not a view of the input
    assert df.loc[10, "marker"] == "a"


# ---------------------------------------------------------------------------
# train_weights
# ---------------------------------------------------------------------------


def test_train_weights_output_validates() -> None:
    w = train_weights(_training_frame(), base=_base(), trained_through=THROUGH)

    validate_weights(w)
    assert set(w) == {
        "schema_version",
        "model_version",
        "trained_through",
        "features",
        "cutoffs",
        "feed_cutoffs",
    }
    assert w["model_version"] == "rescore-v1-2026-05-22"
    assert w["trained_through"] == "2026-06-01"
    assert w["cutoffs"]["t1"] > w["cutoffs"]["t2"]
    # Trained from the frame, not carried over from the base.
    assert set(w["features"]["ticker_weights"]) == {"AAA", "BBB", "CCC"}
    # The object goes into a JSONB column: plain ints and floats only.
    assert json.loads(json.dumps(w)) == w


def test_train_weights_preserves_base_composites_and_feed_cutoffs() -> None:
    base = _base()
    w = train_weights(_training_frame(), base=base, trained_through=THROUGH)

    assert w["features"]["composite_bonuses"] == base["features"]["composite_bonuses"]
    assert w["feed_cutoffs"] == {"tier1_min_score": 17, "tier2_min_score": 11}
    # Copies: editing the candidate must not edit the live version it came from.
    w["features"]["composite_bonuses"][0]["bonus"] = -10
    w["feed_cutoffs"]["tier1_min_score"] = 99
    assert base["features"]["composite_bonuses"][0]["bonus"] == 10
    assert base["feed_cutoffs"]["tier1_min_score"] == 17


def test_cutoffs_use_the_full_scorer() -> None:
    df = _training_frame()
    w = train_weights(df, base=_base(), trained_through=THROUGH)

    assert "Monday" in w["features"]["tod_weights_dow_overrides"]
    cutoffs = _percentile_cutoffs(score_frame(w, df))
    assert w["cutoffs"] == cutoffs

    # The composite and the Monday table both move the percentiles: a scorer
    # without them would give other cutoffs.
    no_composites = copy.deepcopy(w)
    no_composites["features"]["composite_bonuses"] = []
    assert _percentile_cutoffs(score_frame(no_composites, df)) != cutoffs
    no_override = copy.deepcopy(w)
    no_override["features"]["tod_weights_dow_overrides"] = {}
    assert _percentile_cutoffs(score_frame(no_override, df)) != cutoffs


def test_train_weights_wires_each_feature_to_its_own_column_and_scale() -> None:
    df = _training_frame()
    f = train_weights(df, base=_base(), trained_through=THROUGH)["features"]
    mean = float(df["outcome_pct"].mean())

    # The scales are written out, not imported: a swapped scale must fail here.
    assert f["tod_weights"] == compute_categorical_weights(
        df, "tod", list(TODS), 8.0, mean
    )
    dte = df.assign(dte_str=df["dte"].clip(upper=3).astype(int).astype(str))
    assert f["dte_weights"] == compute_categorical_weights(
        dte, "dte_str", ["0", "1", "2", "3"], 6.0, mean
    )
    assert f["option_type_weights"] == compute_categorical_weights(
        df, "option_type", ["C", "P"], 4.0, mean
    )
    assert f["ticker_weights"] == compute_ticker_weights(df, mean, min_obs=100)
    for column, stem, scale in (
        ("trigger_vol_to_oi_window", "vol_oi", 5.0),
        ("gamma_at_trigger", "gamma", 5.0),
        ("trigger_ask_pct", "ask_pct", 6.0),
    ):
        bounds = quintile_boundaries(df[column])
        assert f[f"{stem}_quintile_boundaries"] == bounds
        quintiles = df.assign(q=assign_quintile(df[column], bounds))
        assert f[f"{stem}_quintile_weights"] == compute_quintile_weights(
            quintiles, "q", scale, mean
        )
    monday = df[pd.to_datetime(df["date"]).dt.day_name() == "Monday"]
    assert f["tod_weights_dow_overrides"] == {
        "Monday": compute_categorical_weights(
            monday, "tod", list(TODS), 8.0, float(monday["outcome_pct"].mean())
        )
    }
    # The synthetic signal comes out the right way round.
    assert f["tod_weights"]["AM_open"] == max(f["tod_weights"].values())
    assert f["option_type_weights"]["C"] > f["option_type_weights"]["P"]
    assert f["tod_weights_dow_overrides"]["Monday"]["LUNCH"] > f["tod_weights"]["LUNCH"]


def test_train_weights_pools_dte_above_three_into_the_last_bucket() -> None:
    df = _training_frame()
    base_weights = train_weights(df, base=_base(), trained_through=THROUGH)
    relabelled = df.assign(dte=df["dte"].replace(3, 5))  # the scorer gates these out

    w = train_weights(relabelled, base=_base(), trained_through=THROUGH)

    # The DTE 3 effect is large, so the "3" weight is not 0 and is not the
    # empty-bucket fallback; DTE 5 rows land in that same bucket.
    assert base_weights["features"]["dte_weights"]["3"] != 0
    assert w["features"]["dte_weights"] == base_weights["features"]["dte_weights"]


@pytest.mark.parametrize(
    ("monday_rows", "has_override"),
    [(0, False), (MIN_OBS_BUCKET * 2 - 1, False), (MIN_OBS_BUCKET * 2, True)],
)
def test_monday_override_needs_two_buckets_of_rows(
    monday_rows: int, has_override: bool
) -> None:
    df = _training_frame()
    is_monday = pd.to_datetime(df["date"]).dt.dayofweek == 0
    kept = df[~is_monday | (is_monday.cumsum() <= monday_rows)].reset_index(drop=True)

    w = train_weights(kept, base=_base(), trained_through=THROUGH)

    assert ("Monday" in w["features"]["tod_weights_dow_overrides"]) is has_override


def test_train_weights_leaves_its_inputs_alone() -> None:
    df = _training_frame()
    base = _base()
    df_before, base_before = df.copy(deep=True), copy.deepcopy(base)

    train_weights(df, base=base, trained_through=THROUGH)

    pd.testing.assert_frame_equal(df, df_before)
    assert base == base_before


def test_train_weights_refuses_an_empty_frame() -> None:
    with pytest.raises(ValueError, match="no training rows"):
        train_weights(
            _training_frame().iloc[0:0], base=_base(), trained_through=THROUGH
        )


def test_train_weights_refuses_a_frame_the_scorer_gates_out() -> None:
    df = _training_frame()
    df["dte"] = 7  # the scorer takes DTE 0-3 only, so no fire scores
    with pytest.raises(ValueError, match="no scorable rows"):
        train_weights(df, base=_base(), trained_through=THROUGH)


def test_train_weights_validates_the_cutoffs_before_returning() -> None:
    base = _base()
    base["features"]["composite_bonuses"] = []
    df = _training_frame()
    df["outcome_pct"] = 5.0  # no spread: every weight is 0, so every score is 0

    with pytest.raises(WeightsInvalid, match=r"^cutoffs: order$"):
        train_weights(df, base=base, trained_through=THROUGH)


def test_train_weights_rejects_a_feature_with_no_spread() -> None:
    df = _training_frame()
    df["trigger_ask_pct"] = 0.5  # four equal boundaries

    with pytest.raises(
        WeightsInvalid, match=r"^features\.ask_pct_quintile_boundaries: increasing$"
    ):
        train_weights(df, base=_base(), trained_through=THROUGH)


def test_train_weights_rejects_a_malformed_base() -> None:
    base = _base()
    del base["feed_cutoffs"]

    with pytest.raises(WeightsInvalid, match=r"^feed_cutoffs: missing$"):
        train_weights(_training_frame(), base=base, trained_through=THROUGH)


# ---------------------------------------------------------------------------
# main: a dry run
# ---------------------------------------------------------------------------


def _read_all(directory: Path) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in sorted(directory.iterdir()) if p.is_file()}


@pytest.fixture
def dry_run(monkeypatch: pytest.MonkeyPatch) -> _FakeConnection:
    """A fake connection that serves the synthetic frame and the base weights,
    patched in as ``utils.get_connection``; ``sys.argv`` carries ``--through``."""
    utils = pytest.importorskip("utils")
    pytest.importorskip("scipy")
    conn = _FakeConnection(
        _db_rows(_training_frame()), pointer_row=("seed-2026-06-17", _base())
    )
    monkeypatch.setattr(utils, "get_connection", lambda: conn)
    monkeypatch.setattr(
        sys, "argv", ["lottery_scoring.py", "--through", THROUGH.isoformat()]
    )
    return conn


def test_main_writes_nothing(
    dry_run: _FakeConnection,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.chdir(tmp_path)  # a stray relative write would land here
    before = _read_all(OUTPUT_DIR)

    ls.main()

    assert _read_all(OUTPUT_DIR) == before
    assert list(tmp_path.iterdir()) == []
    # Two reads (the training frame, the active weights), both SELECTs, on a
    # session the database itself holds read-only.
    assert len(dry_run.executed) == 2
    assert all(sql.lstrip().upper().startswith("SELECT") for sql, _ in dry_run.executed)
    assert dry_run.session == {"readonly": True}
    assert dry_run.closed


def test_main_reads_the_ninety_day_window_ending_at_through(
    dry_run: _FakeConnection,
) -> None:
    ls.main()

    [(_, params)] = [e for e in dry_run.executed if "lottery_finder_fires" in e[0]]
    assert params == (date(2026, 3, 3), THROUGH)


def test_main_prints_the_dry_run_summary(
    dry_run: _FakeConnection, capsys: pytest.CaptureFixture[str]
) -> None:
    from scipy import stats

    df = _training_frame()
    w = train_weights(df, base=_base(), trained_through=THROUGH)
    r, _ = stats.spearmanr(score_frame(w, df).astype("float64"), df["outcome_pct"])

    ls.main()

    out = capsys.readouterr().out
    assert "1,200 rows" in out
    assert "60 sessions" in out
    assert f"t1={w['cutoffs']['t1']}" in out
    assert f"r={r:.4f}" in out
    assert "nothing was written" in out.lower()


def test_main_requires_through(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["lottery_scoring.py"])
    with pytest.raises(SystemExit) as exc:
        ls.main()
    assert exc.value.code == 2


# ---------------------------------------------------------------------------
# Imports: the nightly image has no scipy and no utils
# ---------------------------------------------------------------------------


def test_import_does_not_load_scipy_or_utils() -> None:
    # The nightly image gets this file and its two siblings, plus numpy and
    # pandas. A subprocess in isolated mode (-I: no PYTHONPATH, no cwd on
    # sys.path) shows what the import itself pulls in and whether it edits
    # sys.path.
    probe = (
        "import json, os, sys\n"
        "src = sys.argv[1]\n"
        "sys.path.insert(0, src)\n"
        "before = list(sys.path)\n"
        "import lottery_scoring\n"
        "own = sorted(\n"
        "    name for name, mod in sys.modules.items()\n"
        "    if name != 'lottery_scoring'\n"
        "    and getattr(mod, '__file__', None)\n"
        "    and os.path.abspath(mod.__file__).startswith(os.path.abspath(src))\n"
        ")\n"
        "print(json.dumps({\n"
        "    'scipy': 'scipy' in sys.modules,\n"
        "    'utils': 'utils' in sys.modules,\n"
        "    'siblings': own,\n"
        "    'path_changed': sys.path != before,\n"
        "}))\n"
    )
    out = subprocess.run(
        [sys.executable, "-I", "-c", probe, str(SRC_DIR)],
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    assert json.loads(out.stdout.strip().splitlines()[-1]) == {
        "scipy": False,
        "utils": False,
        "siblings": ["lottery_refit_gates", "lottery_weights"],
        "path_changed": False,
    }
