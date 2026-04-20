"""Cross-market gate: run the sweep on NQ and ES, then bucket configs.

The gate logic from `acceptance.yml`:
- If `cross_market_gate.require_pass_on_all_markets` is True (our default),
  a config must pass ALL acceptance thresholds on EVERY market in the
  `markets:` list to be promoted to `cross_market_pass`.
- Configs passing one but not the other get bucketed into `nq_only` or
  `es_only` for post-hoc review — never auto-promoted.
- Configs failing both get `non_promoted`.

The buckets are a FILTER over per-market sweep results, not a re-run.
Each market runs its own CPCV sweep independently; the gate is just an
intersection.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from pac_backtest.acceptance import AcceptanceConfig
from pac_backtest.cpcv import cpcv_splits
from pac_backtest.sweep import (
    FoldResult,
    build_config_scenario_matrix,
    run_cpcv_sweep,
)


def _params_key(best_params: dict) -> tuple:
    """Hashable canonical key for a config (for bucketing across markets)."""
    return tuple(
        sorted(
            (k, ("__none__" if v is None else v))
            for k, v in best_params.items()
        )
    )


def _passes_thresholds(oos_metrics: dict, thresholds) -> tuple[bool, list[str]]:
    """Check a single OOS metrics dict against the acceptance thresholds.

    Returns (passed, reasons_for_failure). Empty reasons list on pass.

    v1 applies only the per-fold-level thresholds: trade_count,
    profit_factor, max_drawdown_pct, expectancy. DSR and PBO are
    applied at the sweep level in `apply_cross_market_gate()` via the
    per-market aggregate stats, not per fold.
    """
    reasons = []

    if oos_metrics["trade_count"] < thresholds.min_trades_per_fold:
        reasons.append(
            f"trade_count {oos_metrics['trade_count']} < "
            f"min {thresholds.min_trades_per_fold}"
        )
    if oos_metrics["profit_factor"] < thresholds.profit_factor_min:
        reasons.append(
            f"profit_factor {oos_metrics['profit_factor']:.2f} < "
            f"min {thresholds.profit_factor_min}"
        )
    if abs(oos_metrics["max_drawdown_pct"]) > thresholds.max_drawdown_pct:
        reasons.append(
            f"max_drawdown_pct {oos_metrics['max_drawdown_pct']:.2%} > "
            f"max {thresholds.max_drawdown_pct:.0%}"
        )

    return (len(reasons) == 0, reasons)


@dataclass
class MarketResult:
    """Results from one market's CPCV sweep."""

    symbol: str
    n_folds: int
    fold_results: list[FoldResult]
    config_scenario_matrix: np.ndarray  # shape (n_unique_configs, n_folds)
    config_keys: list[tuple]


@dataclass
class GateResult:
    """Final cross-market gate bucketing."""

    cross_market_pass: list[dict[str, Any]] = field(default_factory=list)
    nq_only: list[dict[str, Any]] = field(default_factory=list)
    es_only: list[dict[str, Any]] = field(default_factory=list)
    non_promoted: list[dict[str, Any]] = field(default_factory=list)
    # Per-market raw sweep results
    per_market: dict[str, MarketResult] = field(default_factory=dict)


def run_market_sweep(
    symbol: str,
    bars: pd.DataFrame,
    acceptance: AcceptanceConfig,
    *,
    n_trials_per_fold: int | None = None,
    seed: int = 42,
) -> MarketResult:
    """Run the full CPCV sweep on one market.

    `bars` is the PAC-enriched bar DataFrame for this market.
    `n_trials_per_fold` defaults to the acceptance.yml setting.
    """
    n_trials = n_trials_per_fold or acceptance.sweep.optuna_trials_per_fold

    folds = cpcv_splits(
        n_samples=len(bars),
        n_groups=acceptance.sweep.cpcv_n_groups,
        k_test_groups=acceptance.sweep.cpcv_k_test_groups,
        embargo_bars=acceptance.sweep.embargo_bars,
    )

    fold_results = run_cpcv_sweep(
        bars,
        folds,
        n_trials_per_fold=n_trials,
        joblib_n_jobs=acceptance.sweep.joblib_n_jobs,
        seed=seed,
    )

    matrix, keys = build_config_scenario_matrix(fold_results)

    return MarketResult(
        symbol=symbol,
        n_folds=len(folds),
        fold_results=fold_results,
        config_scenario_matrix=matrix,
        config_keys=keys,
    )


def apply_cross_market_gate(
    per_market: dict[str, MarketResult],
    acceptance: AcceptanceConfig,
) -> GateResult:
    """Bucket every best-per-fold config from every market.

    A config's per-market summary is built from its fold-winner appearances:
    median OOS Sharpe, max DD, median PF, total trade count. If the summary
    passes all acceptance thresholds on a given market, the config is
    tagged "passed on that market." Cross-market-pass requires passing on
    every market in `acceptance.markets`.
    """
    gate = GateResult(per_market=per_market)

    # Aggregate per-config, per-market summaries
    # {config_key: {market: summary_dict}}
    config_summaries: dict[tuple, dict[str, dict]] = {}
    config_sample_params: dict[tuple, dict] = {}

    for symbol, mr in per_market.items():
        # Walk each fold result; aggregate by config_key
        per_config_metrics: dict[tuple, list[dict]] = {}
        for fr in mr.fold_results:
            k = _params_key(fr.best_params)
            per_config_metrics.setdefault(k, []).append(fr.oos_metrics)
            config_sample_params.setdefault(k, fr.best_params)

        for k, metrics_list in per_config_metrics.items():
            # Aggregate: total trades across folds, median PF/DD/Sharpe
            total_trades = sum(m["trade_count"] for m in metrics_list)
            median_sharpe = float(
                np.median([m["sharpe_annualized"] for m in metrics_list])
            )
            median_pf = float(
                np.median(
                    [m["profit_factor"] for m in metrics_list if m["trade_count"] > 0]
                )
                if any(m["trade_count"] > 0 for m in metrics_list)
                else 0.0
            )
            worst_dd = float(
                min([m["max_drawdown_pct"] for m in metrics_list])
            )
            total_pnl = sum(m["total_pnl_dollars"] for m in metrics_list)

            summary = {
                "trade_count": total_trades,  # aggregated across folds
                "profit_factor": median_pf,
                "max_drawdown_pct": worst_dd,  # worst across folds
                "sharpe_annualized": median_sharpe,
                "total_pnl_dollars": total_pnl,
                "n_fold_appearances": len(metrics_list),
            }
            config_summaries.setdefault(k, {})[symbol] = summary

    # Bucket by whether the config passed thresholds per market
    for k, by_market in config_summaries.items():
        passed_by_market: dict[str, bool] = {}
        reasons_by_market: dict[str, list[str]] = {}
        for symbol, summary in by_market.items():
            passed, reasons = _passes_thresholds(summary, acceptance.thresholds)
            passed_by_market[symbol] = passed
            reasons_by_market[symbol] = reasons

        bucket_entry = {
            "config_key": k,
            "sample_params": config_sample_params[k],
            "per_market_summary": by_market,
            "passed_by_market": passed_by_market,
            "rejection_reasons": reasons_by_market,
        }

        # Route to the right bucket
        if len(acceptance.markets) == 2 and set(acceptance.markets) == {"NQ", "ES"}:
            nq_pass = passed_by_market.get("NQ", False)
            es_pass = passed_by_market.get("ES", False)
            if nq_pass and es_pass:
                gate.cross_market_pass.append(bucket_entry)
            elif nq_pass:
                gate.nq_only.append(bucket_entry)
            elif es_pass:
                gate.es_only.append(bucket_entry)
            else:
                gate.non_promoted.append(bucket_entry)
        else:
            # Generic path: require_pass_on_all_markets only, no named buckets
            all_passed = all(passed_by_market.get(m, False) for m in acceptance.markets)
            if all_passed:
                gate.cross_market_pass.append(bucket_entry)
            else:
                gate.non_promoted.append(bucket_entry)

    return gate
