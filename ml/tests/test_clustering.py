"""
Unit tests for ML preprocessing, validation, and clustering utilities.

Run:
    cd ml && .venv/bin/python -m pytest test_ml.py -v
"""

import numpy as np
import pandas as pd
import pytest

from utils import section, subsection, takeaway, validate_dataframe, verdict

# ── validate_dataframe tests ────────────────────────────────


def _make_df(n: int = 20) -> pd.DataFrame:
    """Create a minimal test DataFrame indexed by date."""
    dates = pd.date_range("2026-01-01", periods=n, freq="B")
    rng = np.random.default_rng(42)
    return pd.DataFrame(
        {
            "vix": rng.uniform(12, 30, n),
            "day_of_week": [d.weekday() for d in dates],
            "day_range_pts": rng.uniform(10, 80, n),
            "gex_oi_t1": rng.uniform(-50e9, 50e9, n),
        },
        index=dates,
    )


def test_validate_passes_valid_data():
    """No SystemExit for valid data."""
    df = _make_df(20)
    # Should not raise
    validate_dataframe(
        df,
        min_rows=5,
        required_columns=["vix", "day_of_week"],
        range_checks={"vix": (9, 90)},
    )


def test_validate_fails_too_few_rows():
    """Should exit when row count is below minimum."""
    df = _make_df(3)
    with pytest.raises(SystemExit):
        validate_dataframe(df, min_rows=10)


def test_validate_fails_missing_columns():
    """Should exit when required columns are missing."""
    df = _make_df(20)
    with pytest.raises(SystemExit):
        validate_dataframe(df, required_columns=["nonexistent_column"])


def test_validate_warns_out_of_range(capsys):
    """Should print warning for out-of-range values."""
    df = _make_df(20)
    df.loc[df.index[0], "vix"] = 100  # out of range
    validate_dataframe(df, range_checks={"vix": (9, 90)})
    captured = capsys.readouterr()
    assert "Warning" in captured.out
    assert "vix" in captured.out


def test_validate_warns_duplicate_dates(capsys):
    """Should warn about duplicate index values."""
    df = _make_df(20)
    # Create a duplicate date
    df2 = pd.concat([df, df.iloc[[0]]])
    validate_dataframe(df2, min_rows=5)
    captured = capsys.readouterr()
    assert "duplicate" in captured.out.lower()


def test_validate_warns_high_null_columns(capsys):
    """Should warn about columns with >50% null values."""
    df = _make_df(20)
    df["sparse_col"] = np.nan  # 100% null
    validate_dataframe(df, min_rows=5)
    captured = capsys.readouterr()
    assert "sparse_col" in captured.out


# ── Formatting helpers tests ────────────────────────────────


def test_section_prints_header(capsys):
    section("TEST SECTION")
    captured = capsys.readouterr()
    assert "TEST SECTION" in captured.out
    assert "=" in captured.out


def test_subsection_prints_header(capsys):
    subsection("Test Subsection")
    captured = capsys.readouterr()
    assert "Test Subsection" in captured.out
    assert "---" in captured.out


def test_verdict_confirmed():
    result = verdict(True, "some caveat")
    assert "CONFIRMED" in result
    assert "some caveat" in result


def test_verdict_not_confirmed():
    result = verdict(False)
    assert "NOT CONFIRMED" in result


def test_takeaway_prints(capsys):
    takeaway("important finding")
    captured = capsys.readouterr()
    assert "TAKEAWAY" in captured.out
    assert "important finding" in captured.out


# ── Preprocessing tests (clustering.py) ─────────────────────

# Import after utils to ensure path resolution works
from clustering import (
    ALL_NUMERIC_FEATURES,
    CHARM_PATTERN_COL,
    preprocess,
    run_clustering,
)


def _make_clustering_df(n: int = 30) -> pd.DataFrame:
    """Create a DataFrame with enough features for clustering tests."""
    dates = pd.date_range("2026-01-01", periods=n, freq="B")
    rng = np.random.default_rng(42)

    data: dict[str, object] = {}
    # Add a subset of numeric features
    for feat in ALL_NUMERIC_FEATURES[:15]:
        data[feat] = rng.standard_normal(n)

    # Add charm_pattern categorical
    patterns = [
        "all_negative",
        "all_positive",
        "mixed",
        "pcs_confirming",
        "ccs_confirming",
    ]
    data[CHARM_PATTERN_COL] = rng.choice(patterns, n)

    # Add regime_zone categorical
    data["regime_zone"] = rng.choice(["low", "normal", "elevated", "high"], n)

    return pd.DataFrame(data, index=dates)


def test_preprocess_returns_correct_shape():
    """Preprocess should return PCA-reduced array with correct dimensions."""
    df = _make_clustering_df(30)
    X_pca, labels, df_feat = preprocess(df)

    assert X_pca.shape[0] == 30, "Should have same number of samples"
    assert X_pca.shape[1] > 0, "Should have at least 1 PCA component"
    assert X_pca.shape[1] <= df_feat.shape[1], "PCA should reduce dimensions"
    assert len(labels) == X_pca.shape[1], "Labels should match component count"


def test_preprocess_no_nans():
    """Preprocess should eliminate all NaNs via imputation."""
    df = _make_clustering_df(30)
    # Introduce some NaNs
    df.iloc[0, 0] = np.nan
    df.iloc[5, 2] = np.nan
    X_pca, _, _ = preprocess(df)
    assert not np.any(np.isnan(X_pca)), "PCA output should have no NaNs"


def test_preprocess_drops_sparse_columns():
    """Columns with >50% null should be dropped."""
    df = _make_clustering_df(30)
    # Make a column mostly null
    col = ALL_NUMERIC_FEATURES[0]
    df.loc[df.index[:20], col] = np.nan  # 20/30 = 67% null
    _, _, df_feat = preprocess(df)
    assert col not in df_feat.columns, "Sparse column should be dropped"


def test_preprocess_one_hot_encodes_categoricals():
    """Categorical columns should be one-hot encoded."""
    df = _make_clustering_df(30)
    _, _, df_feat = preprocess(df)
    # Check that one-hot columns exist for charm_pattern
    charm_cols = [c for c in df_feat.columns if c.startswith("charm_")]
    assert len(charm_cols) > 0, "Should have one-hot encoded charm columns"


def test_preprocess_caps_pca_for_small_samples():
    """PCA must enforce ~8 samples/dim to avoid curse-of-dimensionality.

    Regression test for a CI failure where 41 samples with 120 features
    produced 19 PCA components (2.16 samples/dim), which collapsed
    clustering silhouettes and caused best_k=2 to isolate a single outlier.
    """
    # 40 samples should yield at most 5 components (40 // 8 = 5)
    df = _make_clustering_df(40)
    X_pca, labels, _ = preprocess(df)
    assert X_pca.shape[1] <= 5, (
        f"Expected ≤5 components for 40 samples, got {X_pca.shape[1]}"
    )
    assert X_pca.shape[1] >= 3, (
        f"Expected ≥3 components (floor), got {X_pca.shape[1]}"
    )
    assert len(labels) == X_pca.shape[1]


def test_preprocess_pca_scales_with_sample_count():
    """Larger datasets should get proportionally more components (up to 15)."""
    # 80 samples → 80 // 8 = 10 components (still under cap of 15)
    df = _make_clustering_df(80)
    X_pca, _, _ = preprocess(df)
    assert X_pca.shape[1] == 10, (
        f"Expected exactly 10 components for 80 samples, got {X_pca.shape[1]}"
    )


def test_filter_by_completeness_drops_holiday_day():
    """Days with feature_completeness < 0.80 should be filtered out.

    Regression test for a CI failure where 2026-04-03 (Good Friday) was
    written to training_features by a cron that didn't check the NYSE
    calendar. The day had 26% feature completeness and was imputed into
    a phantom PCA position that KMeans isolated as a singleton cluster.
    """
    dates = pd.date_range("2026-01-01", periods=10, freq="B")
    df = pd.DataFrame(
        {
            "vix": np.linspace(15, 25, 10),
            "feature_completeness": [
                0.95, 0.92, 0.88, 0.26, 0.91, 0.93, 0.80, 0.75, 0.99, 0.90,
            ],
        },
        index=dates,
    )
    filtered = filter_by_completeness(df)
    # Two rows should be dropped: 0.26 and 0.75 (both below 0.80)
    assert len(filtered) == 8
    assert 0.26 not in filtered["feature_completeness"].values
    assert 0.75 not in filtered["feature_completeness"].values
    # 0.80 is inclusive — it must survive
    assert 0.80 in filtered["feature_completeness"].values


def test_filter_by_completeness_no_op_when_column_missing(capsys):
    """If the column is absent, return the frame unchanged with a warning."""
    df = pd.DataFrame(
        {"vix": [15.0, 16.0, 17.0]},
        index=pd.date_range("2026-01-01", periods=3, freq="B"),
    )
    filtered = filter_by_completeness(df)
    assert len(filtered) == 3
    assert filtered.equals(df)
    captured = capsys.readouterr()
    assert "feature_completeness column missing" in captured.out


def test_filter_by_completeness_all_pass():
    """If every day is above threshold, no rows are dropped."""
    dates = pd.date_range("2026-01-01", periods=5, freq="B")
    df = pd.DataFrame(
        {
            "vix": [15.0, 16.0, 17.0, 18.0, 19.0],
            "feature_completeness": [0.95, 0.98, 1.00, 0.90, 0.85],
        },
        index=dates,
    )
    filtered = filter_by_completeness(df)
    assert len(filtered) == 5


def test_run_clustering_returns_all_ks():
    """run_clustering should return results for every k in range."""
    rng = np.random.default_rng(42)
    X = rng.standard_normal((30, 5))
    k_range = range(2, 5)
    results = run_clustering(X, k_range)

    assert set(results.keys()) == {2, 3, 4}
    for k, row in results.items():
        assert "kmeans_sil" in row
        assert "kmeans_ch" in row
        assert "kmeans_db" in row
        assert "gmm_sil" in row
        assert "hier_sil" in row
        assert len(row["kmeans_labels"]) == 30
        assert len(row["kmeans_sizes"]) == k


def test_run_clustering_metrics_are_numeric():
    """All metric values should be finite numbers."""
    rng = np.random.default_rng(42)
    X = rng.standard_normal((30, 5))
    results = run_clustering(X, range(2, 4))

    for _k, row in results.items():
        assert np.isfinite(row["kmeans_sil"])
        assert np.isfinite(row["kmeans_ch"])
        assert np.isfinite(row["kmeans_db"])
        assert np.isfinite(row["gmm_sil"])
        assert np.isfinite(row["hier_sil"])
        assert np.isfinite(row["gmm_bic"])


# ── Additional clustering function tests ──────────────────────

from clustering import (
    characterize_clusters,
    filter_by_completeness,
    outcome_association_test,
    permutation_test,
    print_results,
    split_half_validation,
    stability_check,
)


def _make_clustering_results() -> dict:
    """Build a results dict matching the shape returned by run_clustering."""
    rng = np.random.default_rng(99)
    results = {}
    # k=2 has the best average silhouette by design
    results[2] = {
        "kmeans_sil": 0.60,
        "gmm_sil": 0.55,
        "hier_sil": 0.58,
        "kmeans_ch": 120.0,
        "kmeans_db": 0.8,
        "gmm_bic": -200.0,
        "kmeans_sizes": [15, 15],
        "kmeans_labels": rng.choice([0, 1], size=30),
    }
    results[3] = {
        "kmeans_sil": 0.40,
        "gmm_sil": 0.38,
        "hier_sil": 0.42,
        "kmeans_ch": 90.0,
        "kmeans_db": 1.1,
        "gmm_bic": -180.0,
        "kmeans_sizes": [10, 10, 10],
        "kmeans_labels": rng.choice([0, 1, 2], size=30),
    }
    results[4] = {
        "kmeans_sil": 0.30,
        "gmm_sil": 0.28,
        "hier_sil": 0.32,
        "kmeans_ch": 70.0,
        "kmeans_db": 1.5,
        "gmm_bic": -160.0,
        "kmeans_sizes": [8, 8, 7, 7],
        "kmeans_labels": rng.choice([0, 1, 2, 3], size=30),
    }
    return results


def test_print_results_returns_best_k():
    """print_results should return the k with the highest avg silhouette."""
    results = _make_clustering_results()
    best_k = print_results(results)
    # k=2 has avg sil (0.60 + 0.55 + 0.58) / 3 = 0.577, highest by design
    assert best_k == 2


def test_print_results_prints_table(capsys):
    """print_results should print the results table header and k values."""
    results = _make_clustering_results()
    print_results(results)
    captured = capsys.readouterr()
    assert "CLUSTERING RESULTS" in captured.out
    assert "2" in captured.out
    assert "3" in captured.out
    assert "4" in captured.out


def test_characterize_clusters_prints_profiles(capsys):
    """characterize_clusters should print a profile for each cluster."""
    rng = np.random.default_rng(42)
    n = 15
    dates = pd.date_range("2026-01-01", periods=n, freq="B")
    df = pd.DataFrame(
        {
            "vix": rng.uniform(12, 30, n),
            "vix1d_vix_ratio": rng.uniform(0.8, 1.2, n),
            "gex_oi_t1": rng.uniform(-50e9, 50e9, n),
            "flow_agreement_t1": rng.uniform(-1, 1, n),
            "charm_pattern": rng.choice(["all_negative", "all_positive", "mixed"], n),
            "day_of_week": [d.weekday() for d in dates],
            "range_category": rng.choice(["narrow", "normal", "wide"], n),
            "recommended_structure": rng.choice(["IC", "PCS", "CCS"], n),
            "structure_correct": rng.choice([0, 1], n).astype(float),
            "settlement_direction": rng.choice(["up", "down", "flat"], n),
        },
        index=dates,
    )
    labels = np.array([0] * 5 + [1] * 5 + [2] * 5)

    characterize_clusters(df, labels, 3, "K-Means")
    captured = capsys.readouterr()
    assert "Cluster 0" in captured.out
    assert "Cluster 1" in captured.out
    assert "Cluster 2" in captured.out


def test_stability_check_returns_float():
    """stability_check should return a float between 0.0 and 1.0."""
    rng = np.random.default_rng(42)
    X = rng.standard_normal((20, 3))
    result = stability_check(X, k=2)
    assert isinstance(result, float)
    assert 0.0 <= result <= 1.0


def test_stability_check_perfect_clusters():
    """Well-separated clusters should yield stability close to 1.0."""
    X = np.array([[-5, -5, -5]] * 10 + [[5, 5, 5]] * 10, dtype=float)
    result = stability_check(X, k=2)
    assert result >= 0.9, f"Expected stability >= 0.9, got {result}"


def test_permutation_test_returns_p_value():
    """permutation_test should return a p-value between 0.0 and 1.0."""
    rng = np.random.default_rng(42)
    X = rng.standard_normal((30, 5))
    p = permutation_test(X, k=2, n_permutations=20)
    assert isinstance(p, (float, np.floating))
    assert 0.0 <= p <= 1.0


def test_permutation_test_random_data_high_p():
    """Fully random data should generally have a high p-value (not significant)."""
    rng = np.random.default_rng(123)
    X = rng.standard_normal((30, 5))
    p = permutation_test(X, k=2, n_permutations=50)
    assert 0.0 <= p <= 1.0
    # Random data usually has p > 0.05; allow some tolerance
    assert p > 0.01, f"Expected p > 0.01 for random data, got {p}"


def test_split_half_validation_well_separated_clusters():
    """Clean two-cluster data should yield finite, similar train/test sils."""
    X = np.array([[-5, -5, -5]] * 20 + [[5, 5, 5]] * 20, dtype=float)
    result = split_half_validation(X, k=2)
    assert np.isfinite(result["train_silhouette"])
    assert np.isfinite(result["holdout_silhouette"])
    assert result["train_silhouette"] > 0.5
    assert result["holdout_silhouette"] > 0.5


def test_split_half_validation_singleton_cluster_returns_nan():
    """1-vs-N outlier cluster must not crash silhouette_score.

    Regression test for a CI failure where best_k=2 produced a 1/40
    split. A random 50/50 split left the minority cluster entirely in
    one half, collapsing the other half's predictions to a single label
    and raising ``ValueError: Number of labels is 1``.
    """
    # 40 tightly packed points + 1 distant outlier → forces a 1/40 split
    X = np.vstack(
        [
            np.zeros((40, 3)) + np.random.default_rng(0).normal(0, 0.01, (40, 3)),
            np.array([[100.0, 100.0, 100.0]]),
        ]
    )
    # Should not raise — degenerate splits return NaN
    result = split_half_validation(X, k=2)
    assert "train_silhouette" in result
    assert "holdout_silhouette" in result
    assert "optimism" in result
    # At least one silhouette should be NaN because a random half misses the outlier
    assert np.isnan(result["train_silhouette"]) or np.isnan(
        result["holdout_silhouette"]
    )


def test_outcome_association_prints(capsys):
    """outcome_association_test should print chi-squared results."""
    rng = np.random.default_rng(42)
    n = 30
    labels = np.array([0] * 10 + [1] * 10 + [2] * 10)
    df = pd.DataFrame(
        {
            "range_category": rng.choice(["narrow", "normal", "wide"], n),
            "settlement_direction": rng.choice(["up", "down", "flat"], n),
            "recommended_structure": rng.choice(["IC", "PCS", "CCS"], n),
            "structure_correct": rng.choice([0, 1], n).astype(float),
            "cluster": labels,
        },
    )

    outcome_association_test(df, labels, 3)
    captured = capsys.readouterr()
    # Should contain either chi-squared output or structure correctness
    has_chi2 = "chi2" in captured.out.lower()
    has_structure = "Structure correctness" in captured.out
    assert has_chi2 or has_structure, (
        f"Expected chi-squared or structure correctness output, got:\n{captured.out}"
    )
