"""Tests for `pac_backtest.pbo` — Probability of Backtest Overfitting."""

from __future__ import annotations

import numpy as np
import pytest

from pac_backtest.pbo import probability_of_backtest_overfit


class TestPboInputValidation:
    def test_1d_input_raises(self):
        with pytest.raises(ValueError, match="2D"):
            probability_of_backtest_overfit(np.array([1.0, 2.0, 3.0]))

    def test_too_few_configs_raises(self):
        M = np.array([[1.0, 2.0]])  # 1 config × 2 scenarios
        with pytest.raises(ValueError, match="at least 2 configs"):
            probability_of_backtest_overfit(M)

    def test_too_few_scenarios_raises(self):
        M = np.array([[1.0], [2.0]])  # 2 configs × 1 scenario
        with pytest.raises(ValueError, match="at least 2 scenarios"):
            probability_of_backtest_overfit(M)

    def test_odd_scenarios_raises(self):
        M = np.random.default_rng(0).normal(size=(4, 5))
        with pytest.raises(ValueError, match="even"):
            probability_of_backtest_overfit(M)


class TestPboExpectedBehavior:
    def test_perfect_edge_gives_zero_pbo(self):
        """If one config dominates every scenario, PBO = 0."""
        # Config 0 is +10 on every scenario; others are noise.
        rng = np.random.default_rng(42)
        n_configs, n_scenarios = 10, 6
        M = rng.normal(0, 0.5, (n_configs, n_scenarios))
        M[0, :] += 10.0  # config 0 always wins
        result = probability_of_backtest_overfit(M, random_state=42)
        assert result["pbo"] < 1e-9  # effectively zero

    def test_random_data_gives_pbo_in_mid_range(self):
        """Under pure noise, PBO should be far from 0 and 1.

        Exact value depends on seed — small samples can swing widely. We
        just assert the result isn't pathologically close to either
        extreme (which would indicate a real signal where we expected none).
        """
        rng = np.random.default_rng(42)
        n_configs, n_scenarios = 20, 10
        M = rng.normal(0, 1.0, (n_configs, n_scenarios))
        result = probability_of_backtest_overfit(M, random_state=42)
        assert 0.2 <= result["pbo"] <= 0.85

    def test_pbo_one_for_antiedge_config(self):
        """Construct a case where the best-IS is provably the worst-OOS."""
        # Pathological case: a config that's +10 on half the scenarios
        # and -10 on the other half. With split (J=first half, Jc=second half),
        # it's the best on J but the worst on Jc.
        # Two halves that are perfectly anti-correlated.
        n_configs, n_scenarios = 5, 4  # scenarios split into 2 and 2
        M = np.random.default_rng(42).normal(0, 0.1, (n_configs, n_scenarios))
        # Config 0: +10 on scenarios 0, 1; -10 on scenarios 2, 3
        M[0, 0] = 10.0
        M[0, 1] = 10.0
        M[0, 2] = -10.0
        M[0, 3] = -10.0

        result = probability_of_backtest_overfit(M)
        # For THIS specific split, config 0 is best on J={0,1} but worst on Jc={2,3}.
        # PBO should be elevated (not guaranteed 1.0 because other splits mix the
        # scenarios differently).
        assert result["pbo"] > 0.2

    def test_output_shape(self):
        rng = np.random.default_rng(0)
        M = rng.normal(size=(10, 6))
        result = probability_of_backtest_overfit(M, random_state=0)
        expected_keys = {
            "pbo",
            "n_configs",
            "n_scenarios",
            "n_splits_used",
            "logit_mean",
            "logit_std",
        }
        assert expected_keys.issubset(set(result.keys()))
        assert 0 <= result["pbo"] <= 1
        assert result["n_configs"] == 10
        assert result["n_scenarios"] == 6

    def test_small_scenarios_enumerates_all_splits(self):
        """With S=4, C(4, 2)=6 splits. Result should use all of them."""
        rng = np.random.default_rng(0)
        M = rng.normal(size=(5, 4))
        result = probability_of_backtest_overfit(M)
        assert result["n_splits_used"] == 6

    def test_large_scenarios_uses_random_sampling(self):
        """With S=14, C(14, 7)=3432 > 500 default; falls to sampled mode."""
        rng = np.random.default_rng(0)
        M = rng.normal(size=(5, 14))
        result = probability_of_backtest_overfit(M, random_state=0)
        assert result["n_splits_used"] == 500

    def test_deterministic_with_random_state(self):
        """Same random_state → same PBO on sampled-splits mode."""
        rng = np.random.default_rng(0)
        M = rng.normal(size=(8, 14))
        a = probability_of_backtest_overfit(M, random_state=42)
        b = probability_of_backtest_overfit(M, random_state=42)
        assert a["pbo"] == b["pbo"]
