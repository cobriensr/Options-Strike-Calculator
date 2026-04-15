"""
Tests for ml/src/nope_eda.py.

Because most EDA functions produce plots and require a DB-shaped
DataFrame, tests use seeded synthetic data and check that functions
run end-to-end without crashing, and that they return findings dicts
with the expected shape.

Run:
    cd ml && .venv/bin/python -m pytest tests/test_nope_eda.py -v
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from nope_eda import (  # type: ignore[import-not-found]
    _has_nope_data,
    q1_direction_by_sign,
    q2_mt_agreement,
    q3_flips_vs_range,
    q4_cumdelta_vs_move,
    q5_magnitude_vs_move,
)

# ── Helpers ─────────────────────────────────────────────────


def _make_nope_df(n: int = 40, seed: int = 42) -> pd.DataFrame:
    """Seeded synthetic DataFrame mirroring load_data_nope() output."""
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2026-01-15", periods=n, freq="B")

    nope_t1 = rng.normal(0, 0.0004, n)
    day_open = 5000 + rng.normal(0, 20, n)
    # Settlement weakly correlated with nope_t1 so Q1 has some signal.
    settlement = day_open + np.sign(nope_t1) * rng.uniform(0, 40, n)
    close_vs_open = settlement - day_open
    day_range_pts = np.abs(close_vs_open) + rng.uniform(10, 50, n)

    return pd.DataFrame(
        {
            "nope_t1": nope_t1,
            "nope_t2": rng.normal(0, 0.0004, n),
            "nope_t3": rng.normal(0, 0.0004, n),
            "nope_t4": rng.normal(0, 0.0004, n),
            "nope_am_mean": rng.normal(0, 0.0003, n),
            "nope_am_sign_flips": rng.integers(0, 5, n),
            "nope_am_cum_delta": rng.normal(0, 5000, n),
            "mt_ncp_t1": rng.normal(0, 100_000_000, n),
            "mt_npp_t1": rng.normal(0, 100_000_000, n),
            "day_open": day_open,
            "settlement": settlement,
            "day_range_pts": day_range_pts,
            "close_vs_open": close_vs_open,
        },
        index=dates,
    )


def _make_empty_nope_df() -> pd.DataFrame:
    """DataFrame with NOPE columns but all null — simulates pre-backfill."""
    dates = pd.date_range("2026-01-15", periods=5, freq="B")
    return pd.DataFrame(
        {
            "nope_t1": [np.nan] * 5,
            "nope_t2": [np.nan] * 5,
            "nope_t3": [np.nan] * 5,
            "nope_t4": [np.nan] * 5,
            "nope_am_mean": [np.nan] * 5,
            "nope_am_sign_flips": [np.nan] * 5,
            "nope_am_cum_delta": [np.nan] * 5,
            "mt_ncp_t1": [1.0, 2.0, 3.0, 4.0, 5.0],
            "mt_npp_t1": [1.0, 2.0, 3.0, 4.0, 5.0],
            "day_open": [5000.0] * 5,
            "settlement": [5010.0] * 5,
            "day_range_pts": [40.0] * 5,
            "close_vs_open": [10.0] * 5,
        },
        index=dates,
    )


# ── _has_nope_data ──────────────────────────────────────────


def test_has_nope_data_subsets_populated_rows() -> None:
    df = _make_nope_df(20)
    result = _has_nope_data(df)
    assert len(result) == 20


def test_has_nope_data_returns_empty_for_all_null() -> None:
    df = _make_empty_nope_df()
    result = _has_nope_data(df)
    assert result.empty


# ── Insufficient-data paths ─────────────────────────────────


@pytest.mark.parametrize(
    "func",
    [
        q1_direction_by_sign,
        q2_mt_agreement,
        q3_flips_vs_range,
        q4_cumdelta_vs_move,
        q5_magnitude_vs_move,
    ],
)
def test_question_returns_insufficient_when_empty(func) -> None:
    df = _make_empty_nope_df()
    result = func(df)
    assert result.get("status") == "insufficient_data"
    assert result.get("n") == 0


# ── Successful runs ─────────────────────────────────────────


def test_q1_returns_expected_keys_on_sufficient_data() -> None:
    df = _make_nope_df(40)
    result = q1_direction_by_sign(df)
    assert "baseline_up_rate" in result
    assert "positive_nope_up_rate" in result
    assert "negative_nope_up_rate" in result
    assert 0 <= result["baseline_up_rate"] <= 1


def test_q2_returns_expected_counts() -> None:
    df = _make_nope_df(40)
    result = q2_mt_agreement(df)
    assert result["n"] > 0
    assert (
        result["agree_bull_n"] + result["agree_bear_n"] + result["disagree_n"]
        == result["n"]
    )


def test_q3_returns_spearman_correlation() -> None:
    df = _make_nope_df(40)
    result = q3_flips_vs_range(df)
    assert "spearman_rho" in result
    assert -1.0 <= result["spearman_rho"] <= 1.0
    assert 0.0 <= result["p_value"] <= 1.0


def test_q4_returns_pearson_correlation() -> None:
    df = _make_nope_df(40)
    result = q4_cumdelta_vs_move(df)
    assert "pearson_r" in result
    assert -1.0 <= result["pearson_r"] <= 1.0


def test_q5_returns_bucket_means() -> None:
    df = _make_nope_df(40)
    result = q5_magnitude_vs_move(df)
    assert "bucket_means" in result
    assert len(result["bucket_means"]) > 0
    for bucket in result["bucket_means"].values():
        assert bucket["mean_abs_move"] >= 0
        assert bucket["n"] >= 0
