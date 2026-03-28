"""
Unit tests for ML preprocessing, validation, and clustering utilities.

Run:
    cd ml && .venv/bin/python -m pytest test_ml.py -v
"""

import numpy as np
import pandas as pd
import pytest

from utils import validate_dataframe, section, subsection, verdict, takeaway


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
    preprocess,
    run_clustering,
    ALL_NUMERIC_FEATURES,
    CATEGORICAL_FEATURES,
    CHARM_PATTERN_COL,
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
    patterns = ["all_negative", "all_positive", "mixed", "pcs_confirming", "ccs_confirming"]
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
    X_pca, _, df_feat = preprocess(df)
    assert col not in df_feat.columns, "Sparse column should be dropped"


def test_preprocess_one_hot_encodes_categoricals():
    """Categorical columns should be one-hot encoded."""
    df = _make_clustering_df(30)
    _, _, df_feat = preprocess(df)
    # Check that one-hot columns exist for charm_pattern
    charm_cols = [c for c in df_feat.columns if c.startswith("charm_")]
    assert len(charm_cols) > 0, "Should have one-hot encoded charm columns"


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

    for k, row in results.items():
        assert np.isfinite(row["kmeans_sil"])
        assert np.isfinite(row["kmeans_ch"])
        assert np.isfinite(row["kmeans_db"])
        assert np.isfinite(row["gmm_sil"])
        assert np.isfinite(row["hier_sil"])
        assert np.isfinite(row["gmm_bic"])
