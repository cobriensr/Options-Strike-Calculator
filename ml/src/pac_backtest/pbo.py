"""Probability of Backtest Overfitting (PBO).

Bailey, Borwein, Lopez de Prado, Zhu (2017), "The Probability of Backtest
Overfitting," *Journal of Computational Finance*. SSRN: 2326253.

The intuition: you have N candidate strategy configurations and S evaluation
scenarios (for us: CPCV folds). Split S randomly into two halves — an
in-sample (IS) set J and an out-of-sample (OOS) set J_c. Find the config
that performs best on J. Then check where that config ranks on J_c.

If the best-IS config is truly edge-having, it should also rank high on
OOS. If it was just lucky on IS noise, its OOS rank will be near the
median. Repeat over many J/J_c splits and PBO is the fraction where the
best-IS config ranked BELOW median on OOS.

    PBO = P(OOS_rank_of_best_IS_config < 0.5)

- PBO = 0 means the best IS always does well OOS (no overfitting)
- PBO = 0.5 means best IS is a coin-flip on OOS (pure overfitting)
- PBO > 0.5 means best IS does WORSE than median on OOS (pathological)

Project threshold (per acceptance.yml): reject if PBO > 0.3. Rigorous
quant shops use 0.2.

Input: a matrix M of shape (N_configs, S_scenarios) where M[i, s] is
config i's performance metric on scenario s. Typically Sharpe ratios or
raw returns.

Note: PBO is a metric of the FAMILY of configs, not a single one. You
report one PBO per entire sweep.
"""

from __future__ import annotations

from itertools import combinations

import numpy as np


def _logit_rank(x: np.ndarray) -> np.ndarray:
    """Rank `x` to [0, 1] then logit-transform. Used in Bailey et al.'s
    original paper — produces symmetric tails for the PBO distribution.
    """
    order = np.argsort(x)
    ranks = np.empty_like(order, dtype=np.float64)
    ranks[order] = np.arange(len(x))
    # Convert to (0, 1) open interval (avoid log(0) and log(inf))
    ranks_01 = (ranks + 1) / (len(x) + 1)
    return np.log(ranks_01 / (1 - ranks_01))


def probability_of_backtest_overfit(
    config_scenario_matrix: np.ndarray,
    *,
    n_splits: int | None = None,
    random_state: int | None = None,
) -> dict:
    """Compute PBO from a config × scenario performance matrix.

    Parameters
    ----------
    config_scenario_matrix:
        Shape (N, S) with one performance metric per (config, scenario).
        Typically Sharpe ratios per CPCV fold.
    n_splits:
        Number of J/J_c splits to draw. Default: all C(S, S/2) combinations
        if S ≤ 12, otherwise 500 random splits. Combinatorial-all for small
        S matches the original paper; random sampling for large S keeps
        runtime bounded.
    random_state:
        For deterministic test repeatability when using random splits.

    Returns
    -------
    dict with keys:
        `pbo`             : the PBO value in [0, 1]
        `n_configs`       : N
        `n_scenarios`     : S
        `n_splits_used`   : how many J/J_c draws were evaluated
        `logit_mean`      : mean of the logit-transformed OOS ranks
        `logit_std`       : std of the logit-transformed OOS ranks
    """
    M = np.asarray(config_scenario_matrix, dtype=np.float64)
    if M.ndim != 2:
        raise ValueError(f"config_scenario_matrix must be 2D, got shape {M.shape}")
    n_configs, n_scenarios = M.shape

    if n_configs < 2:
        raise ValueError(
            f"Need at least 2 configs for PBO, got {n_configs}"
        )
    if n_scenarios < 2:
        raise ValueError(
            f"Need at least 2 scenarios for PBO, got {n_scenarios}"
        )
    if n_scenarios % 2 != 0:
        raise ValueError(
            f"n_scenarios must be even (split into equal halves), got {n_scenarios}. "
            f"Drop one scenario or add one to get an even count."
        )

    half = n_scenarios // 2
    scenario_indices = np.arange(n_scenarios)

    # Enumerate all C(S, S/2) splits if S ≤ 12 (manageable), else sample
    if n_splits is None:
        if n_scenarios <= 12:
            all_splits = list(combinations(scenario_indices, half))
            n_splits = len(all_splits)
            rng_samples = None
        else:
            n_splits = 500
            rng_samples = np.random.default_rng(random_state)
            all_splits = None
    else:
        if n_scenarios <= 12 and n_splits >= len(
            list(combinations(scenario_indices, half))
        ):
            all_splits = list(combinations(scenario_indices, half))
            n_splits = len(all_splits)
            rng_samples = None
        else:
            rng_samples = np.random.default_rng(random_state)
            all_splits = None

    logit_oos_ranks = []
    below_median_count = 0

    for i in range(n_splits):
        if all_splits is not None:
            j_indices = np.array(all_splits[i])
        else:
            j_indices = rng_samples.choice(
                scenario_indices, size=half, replace=False
            )

        jc_indices = np.setdiff1d(scenario_indices, j_indices, assume_unique=True)

        # Average performance per config in each half
        j_performance = M[:, j_indices].mean(axis=1)
        jc_performance = M[:, jc_indices].mean(axis=1)

        # Best config by IS performance
        best_config_idx = int(np.argmax(j_performance))

        # Rank that config on OOS, normalized to [0, 1]
        jc_ranks_raw = _logit_rank(jc_performance)
        # Re-derive percentile ranks for below-median check
        order = np.argsort(jc_performance)
        jc_percentile_ranks = np.empty(n_configs, dtype=np.float64)
        jc_percentile_ranks[order] = np.arange(n_configs) / (n_configs - 1)

        oos_percentile = jc_percentile_ranks[best_config_idx]
        logit_oos_ranks.append(jc_ranks_raw[best_config_idx])

        if oos_percentile < 0.5:
            below_median_count += 1

    logits = np.array(logit_oos_ranks)

    return {
        "pbo": below_median_count / n_splits,
        "n_configs": n_configs,
        "n_scenarios": n_scenarios,
        "n_splits_used": n_splits,
        "logit_mean": float(logits.mean()),
        "logit_std": float(logits.std(ddof=1)) if len(logits) > 1 else 0.0,
    }
