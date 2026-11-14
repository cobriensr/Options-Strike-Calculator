"""The refit gates' Spearman against scipy's.

lottery_refit_gates.spearman is hand-rolled (average ranks, then Pearson)
because the nightly image has no scipy. This file is the only place scipy
meets it. It imports scipy with a plain ``import``, not ``importorskip``: the
``ml`` CI job installs scipy from ml/requirements.txt, so the comparison runs
there and cannot skip without notice. The nightly CI job does not list this
file. The scipy-free known answers are in test_lottery_refit_gates.py.
"""

import math
import warnings

import numpy as np
import pandas as pd
import pytest
from scipy import stats

import lottery_refit_gates as g


def _scipy_rho(x: np.ndarray, y: np.ndarray) -> float:
    """scipy's value on the pairs where both sides are present."""
    keep = ~(np.isnan(x) | np.isnan(y))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # a constant input warns, then gives nan
        return float(stats.spearmanr(x[keep], y[keep]).statistic)


@pytest.mark.parametrize("seed", range(60))
def test_spearman_matches_scipy(seed):
    rng = np.random.default_rng(seed)
    n = int(rng.integers(30, 400))  # enough that a few NaNs leave 3+ pairs
    # Integer draws from a small range, so ties are everywhere.
    ties = int(rng.integers(2, 12))
    x = rng.integers(0, ties, n).astype("float64")
    y = rng.integers(0, ties, n).astype("float64") + 0.5 * x * rng.integers(0, 2)
    # Heavy tails on a third of the cases.
    if seed % 3 == 0:
        y = y + rng.standard_cauchy(n)
    # NaNs on either side, in different rows.
    x[rng.random(n) < 0.1] = np.nan
    y[rng.random(n) < 0.1] = np.nan
    want = _scipy_rho(x, y)
    got = g.spearman(pd.Series(x), pd.Series(y))
    if math.isnan(want):
        assert math.isnan(got)
    else:
        assert got == pytest.approx(want, abs=1e-12)


def test_spearman_agrees_with_scipys_own_nan_handling():
    # nan_policy="omit" is scipy's spelling of "pairwise non-null".
    rng = np.random.default_rng(99)
    x = rng.normal(size=500)
    y = x + rng.normal(size=500)
    x[rng.random(500) < 0.2] = np.nan
    y[rng.random(500) < 0.2] = np.nan
    want = float(stats.spearmanr(x, y, nan_policy="omit").statistic)
    assert g.spearman(pd.Series(x), pd.Series(y)) == pytest.approx(want, abs=1e-12)


def test_spearman_is_nan_exactly_where_scipy_is():
    # Constant on either side: scipy warns and returns nan, so does the gate.
    ramp = np.arange(10.0)
    flat = np.full(10, 3.0)
    for x, y in ((flat, ramp), (ramp, flat), (flat, flat)):
        assert math.isnan(_scipy_rho(x, y))
        assert math.isnan(g.spearman(pd.Series(x), pd.Series(y)))
