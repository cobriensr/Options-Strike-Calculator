# ml/tests/test_takeit_drift_monitor.py
import pytest
import numpy as np
from takeit_drift_monitor import (
    rolling_auc,
    reliability_bins,
    per_segment_auc,
    feature_zscore,
)


def test_rolling_auc_perfect_separation():
    y_true = np.array([0, 0, 0, 1, 1, 1])
    y_pred = np.array([0.1, 0.2, 0.3, 0.7, 0.8, 0.9])
    assert rolling_auc(y_true, y_pred) == pytest.approx(1.0)


def test_rolling_auc_returns_nan_on_single_class():
    y_true = np.array([1, 1, 1])
    y_pred = np.array([0.4, 0.6, 0.8])
    assert np.isnan(rolling_auc(y_true, y_pred))


def test_reliability_bins_returns_10_bins_with_predicted_actual():
    y_true = np.array([0, 0, 1, 1, 0, 1, 1, 1, 1, 1])
    y_pred = np.array([0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95])
    bins = reliability_bins(y_true, y_pred, n_bins=10)
    assert len(bins) == 10
    for b in bins:
        assert len(b) == 3  # (predicted_mean, actual_rate, count)


def test_per_segment_auc_skips_segments_below_min_n():
    y_true = np.array([0, 1, 0, 1, 0, 1])
    y_pred = np.array([0.2, 0.7, 0.3, 0.8, 0.4, 0.9])
    segments = np.array(['A', 'A', 'A', 'A', 'B', 'B'])
    result = per_segment_auc(y_true, y_pred, segments, min_n=3)
    assert 'A' in result
    assert 'B' not in result  # below min_n
    assert result['A']['auc'] == pytest.approx(1.0)


def test_feature_zscore_against_baseline():
    today = np.array([1.0, 2.0, 3.0])
    z = feature_zscore(today, baseline_mean=0.0, baseline_std=1.0)
    # today's mean is 2.0; z = (2.0 - 0.0) / 1.0 = 2.0
    assert z == pytest.approx(2.0)


def test_feature_zscore_returns_nan_on_zero_baseline_std():
    today = np.array([1.0, 2.0, 3.0])
    z = feature_zscore(today, baseline_mean=0.0, baseline_std=0.0)
    assert np.isnan(z)
