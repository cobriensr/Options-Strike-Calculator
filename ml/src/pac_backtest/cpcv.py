"""Combinatorially Purged Cross-Validation (CPCV).

Per Lopez de Prado, *Advances in Financial Machine Learning* (2018), Ch. 7.
Classic time-series walk-forward validation gives you N-1 folds for N
groups. CPCV generalizes to testing on k out of N groups at a time,
producing C(N, k) distinct test combinations. With N=6 and k=2 that's
15 OOS paths — enough to estimate out-of-sample Sharpe stability and
feed into PBO (Probability of Backtest Overfitting).

Two concepts need careful handling for financial time-series:

- **Purge**: training samples whose label horizon (trade exit) falls
  inside a test window must be dropped. Otherwise the model trains on
  information that leaks into the test set (the training sample's
  label-realization-time overlapped with the OOS period).

- **Embargo**: bars immediately before/after a test window may be
  correlated with the test window via the strategy's trade-holding
  horizon. Drop `embargo_bars` on each boundary.

Implementation notes:

- We split on *bar indices*, not dates. Callers can convert as needed.
- Purge is handled externally (caller must know each sample's trade
  exit time). This module returns the raw train/test index sets; the
  sweep orchestrator applies per-config purge when trades are known.
- Embargo is applied here because it's a fixed-bar window that doesn't
  depend on trade-level info.

The output is a list of `(train_idx, test_idx)` pairs, one per CPCV
path. Each pair is a pair of numpy int arrays.
"""

from __future__ import annotations

from itertools import combinations

import numpy as np


def _split_into_groups(n_samples: int, n_groups: int) -> list[np.ndarray]:
    """Split bar indices [0, n_samples) into `n_groups` contiguous groups.

    The last group absorbs the remainder if n_samples isn't divisible.
    """
    if n_groups < 2:
        raise ValueError(f"n_groups must be >= 2, got {n_groups}")
    if n_groups > n_samples:
        raise ValueError(
            f"n_groups={n_groups} exceeds n_samples={n_samples}; "
            f"cannot split into more groups than samples"
        )
    base = n_samples // n_groups
    boundaries = [i * base for i in range(n_groups)] + [n_samples]
    return [np.arange(boundaries[i], boundaries[i + 1]) for i in range(n_groups)]


def _apply_embargo(
    indices: np.ndarray, embargo: int, n_samples: int
) -> np.ndarray:
    """Extend `indices` by `embargo` bars on each side, clamped to [0, n)."""
    if embargo <= 0 or len(indices) == 0:
        return indices
    lo = max(0, int(indices[0]) - embargo)
    hi = min(n_samples, int(indices[-1]) + 1 + embargo)
    return np.arange(lo, hi)


def cpcv_splits(
    n_samples: int,
    *,
    n_groups: int = 6,
    k_test_groups: int = 2,
    embargo_bars: int = 0,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Generate CPCV train/test index splits.

    Parameters
    ----------
    n_samples:
        Total number of bars in the backtest window.
    n_groups:
        How many contiguous groups to carve the bar range into. Default
        6 per Lopez de Prado's practical-floor recommendation.
    k_test_groups:
        How many groups form the test set per split. With (6, 2) we get
        C(6, 2) = 15 splits.
    embargo_bars:
        Bars to exclude from the training set on each side of the test
        window. Prevents strategy-horizon leakage.

    Returns
    -------
    List of (train_indices, test_indices) pairs, one per CPCV path.
    Both arrays are sorted numpy int arrays.
    """
    groups = _split_into_groups(n_samples, n_groups)
    all_splits: list[tuple[np.ndarray, np.ndarray]] = []

    for test_group_combo in combinations(range(n_groups), k_test_groups):
        test_groups = [groups[g] for g in test_group_combo]
        test_idx = np.sort(np.concatenate(test_groups))

        # Compute the embargoed test zone (test window + embargo on each
        # contiguous test-group block). We build this as a set of indices
        # to exclude from training.
        excluded = set()
        for group_indices in test_groups:
            embargoed = _apply_embargo(group_indices, embargo_bars, n_samples)
            excluded.update(embargoed.tolist())

        # Also exclude the raw test indices themselves
        excluded.update(test_idx.tolist())

        train_idx = np.array(
            sorted(set(range(n_samples)) - excluded), dtype=np.int64
        )
        all_splits.append((train_idx, test_idx))

    return all_splits


def n_cpcv_paths(n_groups: int, k_test_groups: int) -> int:
    """Return the number of CPCV paths for given (n_groups, k_test)."""
    from math import comb

    return comb(n_groups, k_test_groups)


def apply_trade_purge(
    train_idx: np.ndarray,
    test_idx: np.ndarray,
    trade_entry_idx: np.ndarray,
    trade_exit_idx: np.ndarray,
) -> np.ndarray:
    """Return training indices with trade-overlap samples purged.

    A training sample at bar i must be removed if any trade starting
    at bar i has its exit bar inside the test window. This prevents
    label-horizon leakage — the training sample's outcome was determined
    by bars that the test set also sees.

    Parameters
    ----------
    train_idx, test_idx:
        From `cpcv_splits()`.
    trade_entry_idx, trade_exit_idx:
        Entry/exit bar indices for every trade produced by the backtest
        on the full sample. Same length arrays.

    Returns
    -------
    Purged training indices (subset of `train_idx`).
    """
    if len(trade_entry_idx) != len(trade_exit_idx):
        raise ValueError(
            f"trade_entry_idx length {len(trade_entry_idx)} != "
            f"trade_exit_idx length {len(trade_exit_idx)}"
        )

    test_set = set(test_idx.tolist())
    leaky_entry_bars = set()

    for entry_bar, exit_bar in zip(trade_entry_idx, trade_exit_idx):
        # If the trade's exit falls inside the test window, the entry
        # bar leaks.
        if exit_bar in test_set:
            leaky_entry_bars.add(int(entry_bar))

    if not leaky_entry_bars:
        return train_idx

    return np.array(
        [i for i in train_idx if i not in leaky_entry_bars], dtype=np.int64
    )
