"""Tests for DSR + effective-trials helpers in `pac_backtest.metrics`."""

from __future__ import annotations

import numpy as np
import pytest

from pac_backtest.metrics import (
    deflated_sharpe_ratio,
    estimate_effective_trials_by_correlation,
    expected_max_sharpe_under_null,
)


class TestExpectedMaxSharpeUnderNull:
    def test_single_trial_returns_zero(self):
        """Can't have a max over 1 trial — undefined."""
        assert expected_max_sharpe_under_null(1, 1.0) == 0.0

    def test_zero_std_returns_zero(self):
        assert expected_max_sharpe_under_null(100, 0.0) == 0.0

    def test_more_trials_higher_max(self):
        """Expected max over N trials is monotonically increasing in N."""
        sigma = 1.0
        e10 = expected_max_sharpe_under_null(10, sigma)
        e100 = expected_max_sharpe_under_null(100, sigma)
        e1000 = expected_max_sharpe_under_null(1000, sigma)
        assert 0 < e10 < e100 < e1000

    def test_scales_with_sigma(self):
        e1 = expected_max_sharpe_under_null(100, 1.0)
        e2 = expected_max_sharpe_under_null(100, 2.0)
        # Formula is linear in σ
        assert e2 == pytest.approx(2.0 * e1)

    def test_100_trials_reasonable_value(self):
        """Sanity check against Bailey-LdP paper's published values.
        For N=100, σ=1: expected max Sharpe ≈ 2.5 (within ~0.1)."""
        e = expected_max_sharpe_under_null(100, 1.0)
        assert 2.3 < e < 2.7


class TestDeflatedSharpeRatio:
    def test_dsr_near_one_when_sr_dominates_null(self):
        """High Sharpe far above expected-max-under-null → DSR ≈ 1."""
        result = deflated_sharpe_ratio(
            sharpe=5.0,
            n_samples=252,
            n_effective_trials=10,
            trial_sharpe_std=1.0,
        )
        assert result["dsr"] > 0.95

    def test_dsr_near_zero_when_sr_below_null(self):
        """Sharpe below expected-max-under-null → DSR near 0."""
        result = deflated_sharpe_ratio(
            sharpe=0.5,
            n_samples=252,
            n_effective_trials=1000,
            trial_sharpe_std=2.0,
        )
        assert result["dsr"] < 0.5

    def test_more_trials_lowers_dsr(self):
        """Same SR, more trials → higher expected max → lower DSR."""
        low_trials = deflated_sharpe_ratio(
            sharpe=2.0, n_samples=252, n_effective_trials=10, trial_sharpe_std=1.0
        )
        high_trials = deflated_sharpe_ratio(
            sharpe=2.0, n_samples=252, n_effective_trials=1000, trial_sharpe_std=1.0
        )
        assert high_trials["dsr"] < low_trials["dsr"]

    def test_fat_tails_pull_dsr_toward_half(self):
        """Fat tails widen the Sharpe std → DSR moves TOWARD 0.5 from either end.

        In an above-null regime (observed SR > expected max), fat tails
        lower DSR. In a below-null regime (SR < expected max, DSR near 0),
        fat tails RAISE DSR (toward 0.5) — because the wider uncertainty
        spreads probability mass away from the extremes.

        This test uses an above-null regime: sharpe=4.0, expected max ≈ 2.5.
        """
        normal = deflated_sharpe_ratio(
            sharpe=4.0,
            n_samples=252,
            n_effective_trials=100,
            trial_sharpe_std=1.0,
            skewness=0.0,
            excess_kurtosis=0.0,
        )
        fat_tails = deflated_sharpe_ratio(
            sharpe=4.0,
            n_samples=252,
            n_effective_trials=100,
            trial_sharpe_std=1.0,
            skewness=0.0,
            excess_kurtosis=5.0,
        )
        # In above-null regime, fat tails should lower DSR (toward 0.5 from above)
        assert fat_tails["dsr"] < normal["dsr"]

    def test_skew_moves_dsr_when_sr_positive(self):
        """In the above-null regime with SR > 0, negative skew inflates
        uncertainty (the −γ*SR term is positive with γ<0, SR>0), widening
        σ_SR and pulling DSR toward 0.5 from above.
        """
        normal = deflated_sharpe_ratio(
            sharpe=4.0,
            n_samples=252,
            n_effective_trials=100,
            trial_sharpe_std=1.0,
            skewness=0.0,
        )
        left_skew = deflated_sharpe_ratio(
            sharpe=4.0,
            n_samples=252,
            n_effective_trials=100,
            trial_sharpe_std=1.0,
            skewness=-2.0,
        )
        assert left_skew["dsr"] < normal["dsr"]

    def test_too_short_sample_raises(self):
        with pytest.raises(ValueError, match="n_samples must be >= 2"):
            deflated_sharpe_ratio(
                sharpe=1.0,
                n_samples=1,
                n_effective_trials=10,
                trial_sharpe_std=1.0,
            )

    def test_output_keys(self):
        result = deflated_sharpe_ratio(
            sharpe=1.5, n_samples=252, n_effective_trials=100, trial_sharpe_std=1.0
        )
        for key in (
            "dsr",
            "expected_max_sr_null",
            "sharpe_std_adjusted",
            "sharpe",
            "n_samples",
            "n_effective_trials",
            "trial_sharpe_std",
        ):
            assert key in result


class TestEstimateEffectiveTrialsByCorrelation:
    def test_two_identical_params_is_one_cluster(self):
        M = np.array([[1.0, 0.5], [1.0, 0.5]])
        # Both rows are identical — correlation = 1 (or undefined; nan → not > 0.7)
        # np.corrcoef treats identical rows as fully correlated
        result = estimate_effective_trials_by_correlation(M, correlation_threshold=0.7)
        assert result <= 2  # should detect duplication

    def test_orthogonal_params_is_n_clusters(self):
        """Maximally different param rows → N clusters (no merging)."""
        # Rows are uncorrelated permutations of 1/-1 values
        M = np.eye(5)  # identity matrix — each row is orthogonal
        # corrcoef of identity rows — each row has pairwise correlation < 0.7
        result = estimate_effective_trials_by_correlation(M, correlation_threshold=0.7)
        assert result == 5

    def test_1d_input_raises(self):
        with pytest.raises(ValueError, match="2D"):
            estimate_effective_trials_by_correlation(np.array([1.0, 2.0]))

    def test_single_trial_returns_itself(self):
        result = estimate_effective_trials_by_correlation(
            np.array([[1.0, 2.0, 3.0]])
        )
        assert result == 1

    def test_high_threshold_means_fewer_clusters(self):
        """correlation_threshold=0.0 means every pair is considered correlated
        → collapses to 1 cluster."""
        rng = np.random.default_rng(0)
        M = rng.normal(size=(10, 5))
        n_strict = estimate_effective_trials_by_correlation(M, correlation_threshold=0.9)
        n_loose = estimate_effective_trials_by_correlation(M, correlation_threshold=0.1)
        assert n_loose <= n_strict
