"""Tests for `pac_backtest.cross_market` — cross-market gate bucketing."""

from __future__ import annotations

import numpy as np

from pac_backtest.acceptance import load_acceptance
from pac_backtest.cross_market import (
    MarketResult,
    _params_key,
    _passes_thresholds,
    apply_cross_market_gate,
)
from pac_backtest.sweep import FoldResult


def _fake_fold_result(
    fold_index: int,
    best_params: dict,
    trade_count: int = 250,
    pf: float = 1.5,
    dd_pct: float = -0.10,
    sharpe: float = 1.2,
) -> FoldResult:
    return FoldResult(
        fold_index=fold_index,
        n_train_bars=1000,
        n_test_bars=100,
        n_trials=5,
        best_is_sharpe=sharpe,
        best_params=best_params,
        oos_metrics={
            "trade_count": trade_count,
            "win_rate": 0.5,
            "total_pnl_dollars": 500.0,
            "sharpe_annualized": sharpe,
            "profit_factor": pf,
            "max_drawdown_dollars": -100.0,
            "max_drawdown_pct": dd_pct,
            "expectancy_dollars": 2.0,
        },
        trial_sharpes=[sharpe] * 5,
        trial_params_vectors=[[0.0] * 8] * 5,
    )


class TestParamsKey:
    def test_same_params_produce_same_key(self):
        p = {"entry_trigger": "choch_plus_reversal", "stop_atr_multiple": 1.5}
        assert _params_key(p) == _params_key(p)

    def test_none_values_serialize_as_string(self):
        p1 = {"iv_tercile_filter": None}
        p2 = {"iv_tercile_filter": "__none__"}
        # They should hash to the same key (None → '__none__' internally)
        assert _params_key(p1) == _params_key(p2)


class TestPassesThresholds:
    def test_all_thresholds_pass(self):
        acceptance = load_acceptance()
        metrics = {
            "trade_count": 500,
            "profit_factor": 2.0,
            "max_drawdown_pct": -0.05,
        }
        passed, reasons = _passes_thresholds(metrics, acceptance.thresholds)
        assert passed is True
        assert reasons == []

    def test_low_trade_count_fails(self):
        acceptance = load_acceptance()
        metrics = {
            "trade_count": 10,
            "profit_factor": 2.0,
            "max_drawdown_pct": -0.05,
        }
        passed, reasons = _passes_thresholds(metrics, acceptance.thresholds)
        assert passed is False
        assert any("trade_count" in r for r in reasons)

    def test_low_profit_factor_fails(self):
        acceptance = load_acceptance()
        metrics = {
            "trade_count": 500,
            "profit_factor": 1.1,  # below 1.4 min
            "max_drawdown_pct": -0.05,
        }
        passed, reasons = _passes_thresholds(metrics, acceptance.thresholds)
        assert passed is False
        assert any("profit_factor" in r for r in reasons)

    def test_excessive_drawdown_fails(self):
        acceptance = load_acceptance()
        metrics = {
            "trade_count": 500,
            "profit_factor": 2.0,
            "max_drawdown_pct": -0.30,  # worse than 20% cap
        }
        passed, reasons = _passes_thresholds(metrics, acceptance.thresholds)
        assert passed is False
        assert any("max_drawdown_pct" in r for r in reasons)


class TestApplyCrossMarketGate:
    def test_config_passing_both_markets_goes_to_cross_market_pass(self):
        acceptance = load_acceptance()
        winning_params = {"entry_trigger": "choch_plus_reversal"}

        nq_result = MarketResult(
            symbol="NQ",
            n_folds=1,
            fold_results=[_fake_fold_result(0, winning_params, pf=2.0, dd_pct=-0.10)],
            config_scenario_matrix=np.zeros((1, 1)),
            config_keys=[_params_key(winning_params)],
        )
        es_result = MarketResult(
            symbol="ES",
            n_folds=1,
            fold_results=[_fake_fold_result(0, winning_params, pf=2.0, dd_pct=-0.10)],
            config_scenario_matrix=np.zeros((1, 1)),
            config_keys=[_params_key(winning_params)],
        )

        gate = apply_cross_market_gate(
            {"NQ": nq_result, "ES": es_result}, acceptance
        )
        assert len(gate.cross_market_pass) == 1
        assert len(gate.non_promoted) == 0

    def test_config_failing_one_market_goes_to_partial_bucket(self):
        acceptance = load_acceptance()
        params = {"entry_trigger": "bos_breakout"}

        nq_result = MarketResult(
            symbol="NQ",
            n_folds=1,
            fold_results=[_fake_fold_result(0, params, pf=2.0, dd_pct=-0.05)],
            config_scenario_matrix=np.zeros((1, 1)),
            config_keys=[_params_key(params)],
        )
        es_result = MarketResult(
            symbol="ES",
            n_folds=1,
            fold_results=[
                _fake_fold_result(0, params, pf=1.1, dd_pct=-0.30)  # fails on ES
            ],
            config_scenario_matrix=np.zeros((1, 1)),
            config_keys=[_params_key(params)],
        )

        gate = apply_cross_market_gate(
            {"NQ": nq_result, "ES": es_result}, acceptance
        )
        # Passed only on NQ → nq_only bucket
        assert len(gate.cross_market_pass) == 0
        assert len(gate.nq_only) == 1
        assert len(gate.es_only) == 0

    def test_config_failing_both_markets_goes_to_non_promoted(self):
        acceptance = load_acceptance()
        params = {"entry_trigger": "choch_reversal"}

        nq_result = MarketResult(
            symbol="NQ",
            n_folds=1,
            fold_results=[
                _fake_fold_result(0, params, pf=1.1, trade_count=5)  # fails
            ],
            config_scenario_matrix=np.zeros((1, 1)),
            config_keys=[_params_key(params)],
        )
        es_result = MarketResult(
            symbol="ES",
            n_folds=1,
            fold_results=[
                _fake_fold_result(0, params, pf=0.9, dd_pct=-0.50)  # fails
            ],
            config_scenario_matrix=np.zeros((1, 1)),
            config_keys=[_params_key(params)],
        )

        gate = apply_cross_market_gate(
            {"NQ": nq_result, "ES": es_result}, acceptance
        )
        assert len(gate.cross_market_pass) == 0
        assert len(gate.nq_only) == 0
        assert len(gate.es_only) == 0
        assert len(gate.non_promoted) == 1
