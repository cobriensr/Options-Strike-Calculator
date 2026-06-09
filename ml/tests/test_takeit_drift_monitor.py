# ml/tests/test_takeit_drift_monitor.py
import numpy as np
import pandas as pd
import pytest

from takeit_drift_monitor import (
    compute_feed_drift,
    feature_zscore,
    per_segment_auc,
    reliability_bins,
    render_markdown_report,
    rolling_auc,
)


def test_rolling_auc_perfect_separation():
    y_true = np.array([0, 0, 0, 1, 1, 1])
    y_pred = np.array([0.1, 0.2, 0.3, 0.7, 0.8, 0.9])
    assert rolling_auc(y_true, y_pred) == pytest.approx(1.0)


def test_rolling_auc_returns_nan_on_single_class():
    y_true = np.array([1, 1, 1])
    y_pred = np.array([0.4, 0.6, 0.8])
    assert np.isnan(rolling_auc(y_true, y_pred))


def test_rolling_auc_returns_nan_on_nan_in_y_pred():
    y_true = np.array([0, 0, 1, 1])
    y_pred = np.array([0.1, 0.2, float('nan'), 0.9])
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


def test_per_segment_auc_drops_nan_segments():
    # pandas 3.0 Categorical.astype(str) leaves missing values as float NaN,
    # producing an object array that mixes str labels with float NaN. np.unique
    # cannot sort across those types, so per_segment_auc must drop nulls first.
    y_true = np.array([0, 1, 0, 1, 0, 1])
    y_pred = np.array([0.2, 0.7, 0.3, 0.8, 0.4, 0.9])
    segments = np.array(['A', 'A', 'A', float('nan'), float('nan'), 'A'], dtype=object)
    result = per_segment_auc(y_true, y_pred, segments, min_n=3)
    assert 'A' in result
    assert 'nan' not in result
    assert not any(isinstance(k, float) for k in result)


def test_per_segment_auc_returns_empty_when_all_segments_null():
    # All-NaN segments (e.g. every row has a null/out-of-bin DTE): the label
    # set is empty after dropna, so the helper returns {} without raising and
    # without inventing a 'nan' bucket. Callers (render_markdown_report) iterate
    # an empty dict harmlessly.
    y_true = np.array([0, 1, 0, 1])
    y_pred = np.array([0.2, 0.7, 0.3, 0.8])
    segments = np.array([float('nan')] * 4, dtype=object)
    result = per_segment_auc(y_true, y_pred, segments, min_n=1)
    assert result == {}


def test_feature_zscore_against_baseline():
    today = np.array([1.0, 2.0, 3.0])
    z = feature_zscore(today, baseline_mean=0.0, baseline_std=1.0)
    # today's mean is 2.0; z = (2.0 - 0.0) / 1.0 = 2.0
    assert z == pytest.approx(2.0)


def test_feature_zscore_returns_nan_on_zero_baseline_std():
    today = np.array([1.0, 2.0, 3.0])
    z = feature_zscore(today, baseline_mean=0.0, baseline_std=0.0)
    assert np.isnan(z)


# --- reliability_bins: empty-bin branch (src ~71-72) -------------------------


def test_reliability_bins_empty_bin_yields_nan_and_zero_count():
    # All predictions cluster in the low bin [0, 0.5); with n_bins=2 the upper
    # bin [0.5, 1.0] gets no samples, so the function appends the
    # (bin_center, NaN, 0) sentinel for it.
    y_true = np.array([0, 1, 0, 1])
    y_pred = np.array([0.1, 0.2, 0.3, 0.4])
    bins = reliability_bins(y_true, y_pred, n_bins=2)
    assert len(bins) == 2

    low_pred, low_actual, low_n = bins[0]
    assert low_n == 4
    assert low_pred == pytest.approx(0.25)  # mean of [0.1,0.2,0.3,0.4]
    assert low_actual == pytest.approx(0.5)  # 2 of 4 positive

    # Upper bin [0.5, 1.0] is empty -> (bin_center=0.75, NaN, 0)
    hi_pred, hi_actual, hi_n = bins[1]
    assert hi_n == 0
    assert hi_pred == pytest.approx(0.75)  # (0.5 + 1.0) / 2
    assert np.isnan(hi_actual)


# --- feature_zscore: all-NaN today branch (src ~117-119) ---------------------


@pytest.mark.filterwarnings('ignore:Mean of empty slice:RuntimeWarning')
def test_feature_zscore_returns_nan_when_today_all_nan():
    # np.nanmean over an all-NaN array yields NaN (and emits a RuntimeWarning we
    # intentionally trigger), so the today_mean isnan guard returns NaN before
    # the division.
    today = np.array([float('nan'), float('nan'), float('nan')])
    z = feature_zscore(today, baseline_mean=5.0, baseline_std=2.0)
    assert np.isnan(z)


# --- render_markdown_report (src ~184-212) -----------------------------------


def test_render_markdown_report_header_and_metrics():
    lottery = {
        'feed': 'lottery',
        'n_rows_total': 123,
        'auc_7d_peak': 0.6789,
        'auc_30d_peak': 0.7012,
    }
    silent_boom = {'feed': 'silent_boom', 'n_rows_total': 0}
    report = render_markdown_report('2026-06-09', lottery, silent_boom)

    assert report.startswith('# TAKE-IT drift report — 2026-06-09')
    assert '## lottery' in report
    assert '## silent_boom' in report
    assert '- rows in 30d window: 123' in report
    # floats are formatted to 3 decimals
    assert '- auc_7d_peak: 0.679' in report
    assert '- auc_30d_peak: 0.701' in report


def test_render_markdown_report_nan_metric_renders_na():
    lottery = {
        'feed': 'lottery',
        'n_rows_total': 5,
        'auc_7d_peak': float('nan'),
    }
    silent_boom = {'feed': 'silent_boom', 'n_rows_total': 0}
    report = render_markdown_report('2026-06-09', lottery, silent_boom)
    assert '- auc_7d_peak: n/a' in report
    # absent metric keys are simply omitted, not rendered
    assert 'auc_30d_realized' not in report


def test_render_markdown_report_includes_per_segment_subsections():
    lottery = {
        'feed': 'lottery',
        'n_rows_total': 50,
        'by_dte': {
            '0DTE': {'auc': 0.61, 'n': 120},
            '1-3': {'auc': 0.58, 'n': 110},
        },
        'by_option_type': {
            'C': {'auc': 0.6, 'n': 200},
        },
    }
    silent_boom = {'feed': 'silent_boom', 'n_rows_total': 0}
    report = render_markdown_report('2026-06-09', lottery, silent_boom)

    assert '### per-DTE 30d AUC (peak target)' in report
    assert '- 0DTE: AUC=0.610  n=120' in report
    assert '- 1-3: AUC=0.580  n=110' in report
    assert '### per-option-type 30d AUC (peak target)' in report
    assert '- C: AUC=0.600  n=200' in report


# --- compute_feed_drift (src ~145-181) ---------------------------------------


def test_compute_feed_drift_empty_frame_returns_only_totals():
    out = compute_feed_drift(pd.DataFrame(), 'lottery')
    assert out == {'feed': 'lottery', 'n_rows_total': 0}


def _days_ago(n: int) -> pd.Timestamp:
    # Match the module's windowing reference: now (UTC) normalized, tz-stripped.
    today = pd.Timestamp.now('UTC').normalize().tz_localize(None)
    return today - pd.Timedelta(days=n)


def test_compute_feed_drift_windowing_and_auc():
    # Six in-window rows (within 7d) with perfectly separable takeit_prob vs the
    # peak>=20 label, plus one stale row at 40d that must be excluded from both
    # the 7d and 30d windows.
    rows = [
        # date, takeit_prob, peak_ceiling_pct, realized, dte, option_type
        (_days_ago(1), 0.10, 5.0, -5.0, 0, 'C'),
        (_days_ago(1), 0.20, 10.0, -3.0, 0, 'C'),
        (_days_ago(2), 0.30, 15.0, -1.0, 1, 'P'),
        (_days_ago(3), 0.70, 25.0, 4.0, 2, 'C'),
        (_days_ago(4), 0.80, 30.0, 6.0, 5, 'P'),
        (_days_ago(5), 0.90, 40.0, 8.0, 7, 'C'),
        (_days_ago(40), 0.50, 50.0, 9.0, 0, 'C'),  # stale, excluded
    ]
    df = pd.DataFrame(
        rows,
        columns=[
            'date',
            'takeit_prob',
            'peak_ceiling_pct',
            'realized_trail30_10_pct',
            'dte',
            'option_type',
        ],
    )

    out = compute_feed_drift(df, 'lottery')
    assert out['feed'] == 'lottery'
    assert out['n_rows_total'] == 7  # total rows, not windowed

    # In the 7d window the 6 fresh rows: peak>=20 label = [0,0,0,1,1,1] vs
    # takeit_prob ascending -> perfect separation -> AUC 1.0.
    assert out['auc_7d_peak'] == pytest.approx(1.0)
    assert out['auc_30d_peak'] == pytest.approx(1.0)

    # realized>=0 label = [0,0,0,1,1,1] -> also perfect separation.
    assert out['auc_7d_realized'] == pytest.approx(1.0)
    assert out['auc_30d_realized'] == pytest.approx(1.0)

    # Cross-check against rolling_auc computed by hand on the same labels.
    y_pred = np.array([0.10, 0.20, 0.30, 0.70, 0.80, 0.90])
    peak_label = np.array([0, 0, 0, 1, 1, 1])
    assert out['auc_7d_peak'] == pytest.approx(rolling_auc(peak_label, y_pred))


def test_compute_feed_drift_realized_label_binarizes_nan_as_negative():
    # realized_trail30_10_pct NaN is filled with -100 -> label 0 (< 0). Build a
    # window where the only positive takeit_prob rows have NaN realized: that
    # forces the high-prob rows to label 0, inverting separation so AUC = 0.0.
    rows = [
        (_days_ago(1), 0.10, 5.0, 5.0, 0, 'C'),  # realized>=0 -> 1
        (_days_ago(1), 0.20, 5.0, 5.0, 0, 'C'),  # realized>=0 -> 1
        (_days_ago(2), 0.80, 30.0, float('nan'), 1, 'P'),  # NaN -> 0
        (_days_ago(2), 0.90, 30.0, float('nan'), 1, 'P'),  # NaN -> 0
    ]
    df = pd.DataFrame(
        rows,
        columns=[
            'date',
            'takeit_prob',
            'peak_ceiling_pct',
            'realized_trail30_10_pct',
            'dte',
            'option_type',
        ],
    )
    out = compute_feed_drift(df, 'lottery')
    # realized label = [1, 1, 0, 0] vs ascending prob -> fully inverted -> 0.0
    assert out['auc_7d_realized'] == pytest.approx(0.0)


def test_compute_feed_drift_dte_segmentation_buckets():
    # >= PER_SEGMENT_MIN_N (100) rows per DTE bucket so per_segment_auc keeps
    # them. Bins: [-1,0]=0DTE, (0,3]=1-3, (3,100]=4+.
    n = 120
    base = _days_ago(2)
    frames = []
    for dte_val, bucket in [(0, '0DTE'), (2, '1-3'), (10, '4+')]:
        frames.append(
            pd.DataFrame(
                {
                    'date': [base] * n,
                    # alternate labels so each segment is two-class & separable
                    'takeit_prob': np.tile([0.2, 0.8], n // 2),
                    'peak_ceiling_pct': np.tile([5.0, 30.0], n // 2),
                    'realized_trail30_10_pct': [1.0] * n,
                    'dte': [dte_val] * n,
                    'option_type': ['C'] * n,
                }
            )
        )
    df = pd.concat(frames, ignore_index=True)

    out = compute_feed_drift(df, 'lottery')
    assert set(out['by_dte'].keys()) == {'0DTE', '1-3', '4+'}
    for seg in ('0DTE', '1-3', '4+'):
        assert out['by_dte'][seg]['n'] == n
        # takeit_prob 0.2/0.8 maps perfectly to peak label 0/1 -> AUC 1.0
        assert out['by_dte'][seg]['auc'] == pytest.approx(1.0)
    # option_type 'C' is the only label, with 3*n rows
    assert out['by_option_type']['C']['n'] == 3 * n


def test_compute_feed_drift_single_class_window_yields_nan_auc():
    # All rows have peak < 20 -> peak_label is single-class -> rolling_auc NaN.
    rows = [
        (_days_ago(1), 0.10, 5.0, 1.0, 0, 'C'),
        (_days_ago(2), 0.20, 10.0, 1.0, 1, 'P'),
        (_days_ago(3), 0.30, 15.0, 1.0, 2, 'C'),
    ]
    df = pd.DataFrame(
        rows,
        columns=[
            'date',
            'takeit_prob',
            'peak_ceiling_pct',
            'realized_trail30_10_pct',
            'dte',
            'option_type',
        ],
    )
    out = compute_feed_drift(df, 'lottery')
    assert np.isnan(out['auc_7d_peak'])
    assert np.isnan(out['auc_30d_peak'])
