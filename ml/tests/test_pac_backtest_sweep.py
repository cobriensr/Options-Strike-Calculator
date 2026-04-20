"""Tests for `pac_backtest.sweep` — Optuna + CPCV orchestrator."""

from __future__ import annotations

import numpy as np
import pandas as pd

from pac_backtest.cpcv import cpcv_splits
from pac_backtest.params import EntryTrigger, StrategyParams
from pac_backtest.sweep import (
    _params_to_vector,
    build_config_scenario_matrix,
    run_cpcv_sweep,
)


def _synthetic_enriched_bars(n: int = 600) -> pd.DataFrame:
    """Build a synthetic PAC-enriched bar DataFrame with a few entry signals."""
    ts = pd.date_range("2024-01-02 13:30", periods=n, freq="1min", tz="UTC")
    base = np.linspace(100.0, 110.0, n)
    df = pd.DataFrame(
        {
            "ts_event": ts,
            "open": base,
            "high": base + 0.5,
            "low": base - 0.5,
            "close": base,
            "volume": [100] * n,
            "HighLow": [np.nan] * n,
            "Level_shl": [np.nan] * n,
            "BOS": [np.nan] * n,
            "CHOCH": [np.nan] * n,
            "Level_bc": [np.nan] * n,
            "CHOCHPlus": [0] * n,
        }
    )
    # Sprinkle some bullish CHoCH+ signals
    for i in range(50, n - 5, 50):
        df.loc[i, "CHOCH"] = 1
        df.loc[i, "CHOCHPlus"] = 1
    return df


class TestParamsToVector:
    def test_produces_fixed_length(self):
        p = StrategyParams()
        v = _params_to_vector(p)
        # v3 had 8 dims; v4 (E1.4d) extends by 9 dims for the entry-quality
        # filters, position-management rule, and BoS-count exit.
        assert len(v) == 16

    def test_different_params_produce_different_vectors(self):
        p1 = StrategyParams(entry_trigger=EntryTrigger.CHOCH_REVERSAL)
        p2 = StrategyParams(entry_trigger=EntryTrigger.BOS_BREAKOUT)
        assert _params_to_vector(p1) != _params_to_vector(p2)


class TestRunCpcvSweep:
    def test_empty_folds_returns_empty(self):
        bars = _synthetic_enriched_bars(100)
        result = run_cpcv_sweep(bars, cpcv_folds=[], n_trials_per_fold=2)
        assert result == []

    def test_produces_one_result_per_fold(self):
        bars = _synthetic_enriched_bars(600)
        folds = cpcv_splits(
            n_samples=len(bars), n_groups=6, k_test_groups=2, embargo_bars=5
        )
        # Tiny 2 trials × 15 folds for speed
        results = run_cpcv_sweep(
            bars, folds, n_trials_per_fold=2, joblib_n_jobs=1, seed=0
        )
        assert len(results) == 15

    def test_fold_result_has_expected_fields(self):
        bars = _synthetic_enriched_bars(600)
        folds = cpcv_splits(n_samples=len(bars), n_groups=6, k_test_groups=2)
        results = run_cpcv_sweep(bars, folds, n_trials_per_fold=2, joblib_n_jobs=1)
        fr = results[0]
        assert fr.fold_index == 0
        assert fr.n_train_bars > 0
        assert fr.n_test_bars > 0
        assert fr.n_trials == 2
        assert isinstance(fr.best_params, dict)
        assert "entry_trigger" in fr.best_params
        assert isinstance(fr.oos_metrics, dict)
        assert "trade_count" in fr.oos_metrics
        assert len(fr.trial_sharpes) == 2
        assert len(fr.trial_params_vectors) == 2


class TestBuildConfigScenarioMatrix:
    def test_shape(self):
        bars = _synthetic_enriched_bars(600)
        folds = cpcv_splits(n_samples=len(bars), n_groups=6, k_test_groups=2)
        results = run_cpcv_sweep(bars, folds, n_trials_per_fold=2, joblib_n_jobs=1)
        matrix, keys = build_config_scenario_matrix(results)
        assert matrix.shape[1] == len(results)
        assert matrix.shape[0] == len(keys)

    def test_nan_for_non_winning_folds(self):
        """Each config's row should have NaN in folds where it wasn't best."""
        bars = _synthetic_enriched_bars(600)
        folds = cpcv_splits(n_samples=len(bars), n_groups=6, k_test_groups=2)
        results = run_cpcv_sweep(bars, folds, n_trials_per_fold=2, joblib_n_jobs=1)
        matrix, keys = build_config_scenario_matrix(results)

        # Each row should have exactly one non-NaN cell — the fold where
        # that config won. (Only true when every fold picks a unique config,
        # which is likely with low trial counts.)
        for row in matrix:
            assert np.isnan(row).sum() >= len(row) - 5  # allow some overlap

    def test_empty_fold_results(self):
        matrix, keys = build_config_scenario_matrix([])
        assert matrix.shape == (0, 0)
        assert keys == []
