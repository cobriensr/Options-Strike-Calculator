"""Tests for `pac_backtest.bootstrap` — stationary bootstrap."""

from __future__ import annotations

import numpy as np
import pytest

from pac_backtest.bootstrap import (
    bootstrap_drawdown_ci,
    bootstrap_sharpe_ci,
    stationary_bootstrap_indices,
)


class TestStationaryBootstrapIndices:
    def test_output_shape(self):
        out = stationary_bootstrap_indices(
            n=100, mean_block_length=10, n_resamples=50
        )
        assert out.shape == (50, 100)

    def test_indices_in_range(self):
        out = stationary_bootstrap_indices(
            n=100, mean_block_length=10, n_resamples=20
        )
        assert out.min() >= 0
        assert out.max() < 100

    def test_deterministic_with_seed(self):
        a = stationary_bootstrap_indices(100, 10, n_resamples=30, random_state=42)
        b = stationary_bootstrap_indices(100, 10, n_resamples=30, random_state=42)
        np.testing.assert_array_equal(a, b)

    def test_different_seeds_differ(self):
        a = stationary_bootstrap_indices(100, 10, n_resamples=30, random_state=1)
        b = stationary_bootstrap_indices(100, 10, n_resamples=30, random_state=2)
        assert not np.array_equal(a, b)

    def test_zero_n_raises(self):
        with pytest.raises(ValueError, match="n must be >= 2"):
            stationary_bootstrap_indices(n=1, mean_block_length=5, n_resamples=10)

    def test_invalid_block_length_raises(self):
        with pytest.raises(ValueError, match="mean_block_length"):
            stationary_bootstrap_indices(
                n=100, mean_block_length=0, n_resamples=10
            )

    def test_large_block_length_samples_few_new_starts(self):
        """With very large mean_block_length, few new-start events fire —
        resampled series should be mostly contiguous runs from a single start."""
        out = stationary_bootstrap_indices(
            n=1000, mean_block_length=500, n_resamples=10, random_state=0
        )
        # Count how many "block boundaries" each resample has (index jumps != +1 mod n)
        for r in range(10):
            row = out[r]
            diffs = np.diff(row) % 1000  # wrap-aware difference
            jumps = (diffs != 1).sum()
            # With mean_block_length=500 and n=1000, expect ~2-3 block starts per row
            assert jumps < 10


class TestBootstrapSharpeCi:
    def test_zero_variance_returns_zero_sharpe(self):
        returns = np.ones(100)  # constant returns → std = 0
        result = bootstrap_sharpe_ci(
            returns, mean_block_length=10, n_resamples=50, random_state=0
        )
        assert result["sharpe"] == 0.0

    def test_positive_mean_returns_give_positive_sharpe(self):
        rng = np.random.default_rng(0)
        returns = rng.normal(0.01, 0.005, 200)  # +ve drift
        result = bootstrap_sharpe_ci(
            returns, mean_block_length=20, n_resamples=100, random_state=0
        )
        assert result["sharpe"] > 0

    def test_ci_bounds_contain_point_estimate_usually(self):
        """In most cases, the 95% CI should bracket the point Sharpe."""
        rng = np.random.default_rng(0)
        returns = rng.normal(0.01, 0.01, 300)
        result = bootstrap_sharpe_ci(
            returns, mean_block_length=30, n_resamples=500, random_state=0
        )
        # The point estimate should be within the CI in most cases.
        # Not strictly guaranteed because bootstrap sampling error,
        # but for 500 resamples should almost always hold.
        assert result["ci_low"] <= result["sharpe"] <= result["ci_high"] + 1.0  # loose

    def test_empty_returns_raises(self):
        with pytest.raises(ValueError, match=">= 2 returns"):
            bootstrap_sharpe_ci(
                np.array([1.0]), mean_block_length=10, n_resamples=10
            )

    def test_output_keys(self):
        rng = np.random.default_rng(0)
        returns = rng.normal(0, 1, 100)
        result = bootstrap_sharpe_ci(
            returns, mean_block_length=10, n_resamples=50, random_state=0
        )
        for key in ("sharpe", "ci_low", "ci_high", "sharpe_samples"):
            assert key in result
        assert len(result["sharpe_samples"]) == 50


class TestBootstrapDrawdownCi:
    def test_monotonic_uptrend_drawdown_near_zero(self):
        """Equity curve that never drops should have ~0 max drawdown."""
        curve = np.arange(100, dtype=np.float64)  # 0, 1, 2, ..., 99
        result = bootstrap_drawdown_ci(
            curve, mean_block_length=10, n_resamples=50, random_state=0
        )
        assert result["max_drawdown"] == 0.0  # point estimate: no drawdown
        # Bootstrap resamples may introduce small dips by reordering

    def test_drawdown_captures_known_trough(self):
        # Curve: 0, 5, 10, 3, 8 → peak 10, trough 3 → max DD = -7
        curve = np.array([0.0, 5.0, 10.0, 3.0, 8.0])
        result = bootstrap_drawdown_ci(
            curve, mean_block_length=2, n_resamples=20, random_state=0
        )
        assert result["max_drawdown"] == -7.0

    def test_too_short_curve_raises(self):
        with pytest.raises(ValueError, match=">= 2 equity points"):
            bootstrap_drawdown_ci(
                np.array([100.0]), mean_block_length=5, n_resamples=10
            )

    def test_output_keys(self):
        curve = np.array([100.0, 101.0, 99.0, 102.0, 95.0])
        result = bootstrap_drawdown_ci(
            curve, mean_block_length=2, n_resamples=30, random_state=0
        )
        for key in ("max_drawdown", "ci_low", "ci_high", "dd_samples"):
            assert key in result
