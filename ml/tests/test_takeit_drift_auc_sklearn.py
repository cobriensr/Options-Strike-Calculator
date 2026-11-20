# ml/tests/test_takeit_drift_auc_sklearn.py
#
# Pins takeit_drift_monitor.rolling_auc, a rank-based AUC that needs no
# scikit-learn, against sklearn's roc_auc_score.
#
# This file is its own so the nightly image, which carries no scikit-learn,
# never collects it, while the `ml` CI job (scikit-learn 1.8.0 in
# requirements.txt) always does. The import below is a plain one on purpose: a
# missing scikit-learn must fail the job, not skip the test (review N17).
import numpy as np
import pytest
from sklearn.metrics import roc_auc_score

from takeit_drift_monitor import rolling_auc


def _case(seed: int) -> tuple[np.ndarray, np.ndarray]:
    """One seeded case: both classes present, scores rounded to one decimal so
    ties are common, a signal that runs from inverted to strong across seeds."""
    rng = np.random.default_rng(seed)
    n = int(rng.integers(20, 400))
    y_true = (rng.random(n) < rng.uniform(0.1, 0.9)).astype(int)
    y_true[:2] = [0, 1]  # both classes, whatever the draw
    signal = rng.uniform(-1.0, 1.5)
    noise = rng.normal(0.0, 1.0, n)
    score = 1.0 / (1.0 + np.exp(-(signal * y_true + noise)))
    return y_true, np.round(score, 1)


@pytest.mark.parametrize("seed", range(25))
def test_rank_auc_matches_sklearn(seed):
    y_true, y_pred = _case(seed)
    # The cases must have ties, or the test would not exercise the average rank.
    assert len(np.unique(y_pred)) < len(y_pred)

    assert abs(rolling_auc(y_true, y_pred) - roc_auc_score(y_true, y_pred)) < 1e-12
