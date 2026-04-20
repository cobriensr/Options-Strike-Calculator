"""Stationary bootstrap for time-series confidence intervals.

Politis & Romano (1994), "The Stationary Bootstrap," JASA 89(428).

The classic IID bootstrap assumes observations are exchangeable — breaks
on a time-series with autocorrelation. Block bootstraps preserve local
dependence by resampling contiguous chunks. The **stationary** bootstrap
uses RANDOM block lengths drawn from a geometric distribution. That
randomization makes the resampled series stationary even when the fixed-
block variant produces artifacts at block boundaries.

Used here for:
- Per-fold Sharpe confidence intervals. The Bailey-Lopez de Prado DSR
  formula gives a point estimate and a closed-form p-value, but for
  communicating a CI to downstream review (and for Phase-1 cross-market
  comparison) the bootstrap adds a direct empirical distribution.
- Max drawdown CIs. DD distribution has fat tails and isn't Gaussian;
  stationary bootstrap is standard practice.

Block-length default: geometric mean of trade durations in bars, clamped
to [10, 500]. Callers pass this; we don't pick a single value.

Politis & White (2004) "Automatic Block-Length Selection" proposes a
data-driven optimal block length estimator. We don't implement it here —
the geometric-mean heuristic is fine for our use case and cheaper.
"""

from __future__ import annotations

import numpy as np


def stationary_bootstrap_indices(
    n: int,
    mean_block_length: float,
    *,
    n_resamples: int = 1000,
    random_state: int | None = None,
) -> np.ndarray:
    """Generate stationary-bootstrap index sets.

    Parameters
    ----------
    n:
        Length of the original time-series.
    mean_block_length:
        Geometric-distribution mean L. Lower = more IID-like, higher =
        preserves more autocorrelation. Common rule: L ≈ mean trade
        duration in bars.
    n_resamples:
        Number of bootstrap replicates.
    random_state:
        Seed for reproducibility.

    Returns
    -------
    ndarray of shape (n_resamples, n) where each row is a resampled set
    of indices into the original series. Indices may repeat within and
    across rows — that's the point.
    """
    if n < 2:
        raise ValueError(f"n must be >= 2, got {n}")
    if mean_block_length <= 0:
        raise ValueError(
            f"mean_block_length must be > 0, got {mean_block_length}"
        )

    rng = np.random.default_rng(random_state)
    p = 1.0 / mean_block_length  # geometric-distribution parameter

    out = np.empty((n_resamples, n), dtype=np.int64)

    for r in range(n_resamples):
        # Algorithm:
        # 1. Pick random start index in [0, n)
        # 2. At each step, with probability p start a new block at random;
        #    otherwise advance by 1 (wrapping around).
        idx = rng.integers(0, n)
        for i in range(n):
            out[r, i] = idx
            if rng.random() < p:
                # Start new block at random position
                idx = rng.integers(0, n)
            else:
                idx = (idx + 1) % n

    return out


def bootstrap_sharpe_ci(
    returns: np.ndarray,
    *,
    mean_block_length: float,
    confidence: float = 0.95,
    n_resamples: int = 1000,
    periods_per_year: int = 252,
    random_state: int | None = None,
) -> dict:
    """Empirical Sharpe-ratio CI via stationary bootstrap.

    Returns {'sharpe', 'ci_low', 'ci_high', 'sharpe_samples'}. The point
    estimate is computed on the original series, CI bounds from bootstrap
    resamples.
    """
    returns = np.asarray(returns, dtype=np.float64)
    if returns.size < 2:
        raise ValueError(f"Need >= 2 returns, got {returns.size}")

    mean_r = returns.mean()
    std_r = returns.std(ddof=1)
    point_sharpe = (
        0.0 if std_r == 0 else (mean_r / std_r) * np.sqrt(periods_per_year)
    )

    idx_matrix = stationary_bootstrap_indices(
        n=returns.size,
        mean_block_length=mean_block_length,
        n_resamples=n_resamples,
        random_state=random_state,
    )

    sharpe_samples = np.empty(n_resamples, dtype=np.float64)
    for r in range(n_resamples):
        resample = returns[idx_matrix[r]]
        m = resample.mean()
        s = resample.std(ddof=1)
        sharpe_samples[r] = 0.0 if s == 0 else (m / s) * np.sqrt(periods_per_year)

    alpha = 1 - confidence
    lo_q = alpha / 2
    hi_q = 1 - alpha / 2

    return {
        "sharpe": float(point_sharpe),
        "ci_low": float(np.quantile(sharpe_samples, lo_q)),
        "ci_high": float(np.quantile(sharpe_samples, hi_q)),
        "sharpe_samples": sharpe_samples,
    }


def bootstrap_drawdown_ci(
    equity_curve: np.ndarray,
    *,
    mean_block_length: float,
    confidence: float = 0.95,
    n_resamples: int = 1000,
    random_state: int | None = None,
) -> dict:
    """Empirical max-drawdown CI via stationary bootstrap.

    Operates on the equity curve (cumulative P&L), not on returns. Each
    bootstrap resample reconstructs a synthetic curve, computes its max
    DD, and we return the distribution.
    """
    equity_curve = np.asarray(equity_curve, dtype=np.float64)
    if equity_curve.size < 2:
        raise ValueError(f"Need >= 2 equity points, got {equity_curve.size}")

    # Convert equity curve to period-over-period changes (returns),
    # resample those, then reintegrate.
    changes = np.diff(equity_curve)
    # We preserve the starting equity level for the resamples
    start = equity_curve[0]

    idx_matrix = stationary_bootstrap_indices(
        n=changes.size,
        mean_block_length=mean_block_length,
        n_resamples=n_resamples,
        random_state=random_state,
    )

    dd_samples = np.empty(n_resamples, dtype=np.float64)
    for r in range(n_resamples):
        resampled_changes = changes[idx_matrix[r]]
        curve = np.concatenate([[start], start + np.cumsum(resampled_changes)])
        peaks = np.maximum.accumulate(curve)
        dd = curve - peaks  # ≤ 0
        dd_samples[r] = float(dd.min())

    peaks = np.maximum.accumulate(equity_curve)
    dd = equity_curve - peaks
    point_dd = float(dd.min())

    alpha = 1 - confidence
    return {
        "max_drawdown": point_dd,
        "ci_low": float(np.quantile(dd_samples, alpha / 2)),
        "ci_high": float(np.quantile(dd_samples, 1 - alpha / 2)),
        "dd_samples": dd_samples,
    }
