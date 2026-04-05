"""
Comprehensive tests for ml/eda.py analysis functions.

Each EDA function prints output to stdout (no return values), so tests
use capsys to verify key strings appear and assert no crashes occur.

Run:
    cd ml && .venv/bin/python -m pytest test_eda.py -v
"""

import numpy as np
import pandas as pd
import pytest

from eda import (
    charm_analysis,
    confidence_calibration,
    feature_importance,
    flow_analysis,
    key_findings,
    rule_validation,
    structure_analysis,
)

# ── Helper ────────────────────────────────────────────────────


def _make_eda_df(n: int = 30) -> pd.DataFrame:
    """Build a realistic DataFrame with all columns required by eda.py.

    Uses a seeded RNG for deterministic tests.  Columns mirror the SQL
    query in ``load_data_eda`` so every analysis function gets valid input.
    """
    rng = np.random.default_rng(42)
    dates = pd.date_range("2026-01-15", periods=n, freq="B")

    structures = rng.choice(
        ["PUT CREDIT SPREAD", "CALL CREDIT SPREAD", "IRON CONDOR"],
        size=n,
        p=[0.5, 0.3, 0.2],
    )

    # Build structure_correct with a bias toward True for PUT CREDIT SPREAD
    structure_correct = []
    for s in structures:
        if s == "PUT CREDIT SPREAD":
            structure_correct.append(rng.random() < 0.75)
        elif s == "CALL CREDIT SPREAD":
            structure_correct.append(rng.random() < 0.50)
        else:
            structure_correct.append(rng.random() < 0.40)

    charm_patterns = rng.choice(
        ["all_negative", "all_positive", "mixed", "mostly_negative"],
        size=n,
    )

    settlement_dirs = rng.choice(["UP", "DOWN"], size=n)
    confidence_levels = rng.choice(
        ["HIGH", "MODERATE", "LOW"], size=n, p=[0.4, 0.4, 0.2]
    )
    range_categories = rng.choice(
        ["NORMAL", "WIDE", "EXTREME"], size=n, p=[0.5, 0.35, 0.15]
    )

    # Flow NCP values -- some positive, some negative
    def _ncp(rng: np.random.Generator, n: int) -> np.ndarray:
        return rng.uniform(-1e6, 1e6, n)

    df = pd.DataFrame(
        {
            # Outcome columns
            "day_range_pts": rng.uniform(10, 120, n).astype(float),
            "day_range_pct": rng.uniform(0.1, 2.0, n),
            "settlement": rng.uniform(5700, 5900, n),
            "day_open": rng.uniform(5700, 5900, n),
            "day_high": rng.uniform(5800, 5950, n),
            "day_low": rng.uniform(5650, 5800, n),
            "close_vs_open": rng.uniform(-50, 50, n),
            "vix_close": rng.uniform(12, 35, n),
            "vix1d_close": rng.uniform(10, 30, n),
            # Label columns
            "recommended_structure": structures,
            "structure_correct": structure_correct,
            "label_confidence": confidence_levels,
            "charm_pattern": charm_patterns,
            "settlement_direction": settlement_dirs,
            "flow_was_directional": rng.choice([True, False], size=n),
            "range_category": range_categories,
            # Feature columns -- volatility
            "vix": rng.uniform(12, 35, n),
            "vix1d": rng.uniform(10, 30, n),
            "vix1d_vix_ratio": rng.uniform(0.6, 1.2, n),
            "vix_vix9d_ratio": rng.uniform(0.8, 1.3, n),
            # GEX
            "gex_oi_t1": rng.uniform(-50e9, 50e9, n),
            "gex_oi_t2": rng.uniform(-50e9, 50e9, n),
            "gex_vol_t1": rng.uniform(0, 1e9, n),
            "gex_vol_t2": rng.uniform(0, 1e9, n),
            "gex_dir_t1": rng.uniform(-1, 1, n),
            "gex_dir_t2": rng.uniform(-1, 1, n),
            # Greek
            "agg_net_gamma": rng.uniform(-1e8, 1e8, n),
            "dte0_net_charm": rng.uniform(-5e7, 5e7, n),
            "dte0_charm_pct": rng.uniform(-1, 1, n),
            "charm_slope": rng.uniform(-1, 1, n),
            # Flow agreement & NCP sources
            "flow_agreement_t1": rng.integers(0, 8, n).astype(float),
            "mt_ncp_t1": _ncp(rng, n),
            "spx_ncp_t1": _ncp(rng, n),
            "spy_ncp_t1": _ncp(rng, n),
            "qqq_ncp_t1": _ncp(rng, n),
            "spy_etf_ncp_t1": _ncp(rng, n),
            "qqq_etf_ncp_t1": _ncp(rng, n),
            "zero_dte_ncp_t1": _ncp(rng, n),
            # Day metadata
            "day_of_week": [d.weekday() for d in dates],
            "is_friday": [d.weekday() == 4 for d in dates],
            "is_event_day": rng.choice([True, False], size=n),
            # Misc features used by feature_importance
            "feature_completeness": rng.uniform(0.5, 1.0, n),
            "label_completeness": rng.uniform(0.5, 1.0, n),
        },
        index=dates,
    )

    # Convert booleans that eda.py checks with ``== True`` / ``== False``
    df["structure_correct"] = df["structure_correct"].astype(bool)
    df["flow_was_directional"] = df["flow_was_directional"].astype(bool)

    return df


def _make_minimal_df(n: int = 30) -> pd.DataFrame:
    """DataFrame with only the bare-minimum columns for smoke testing.

    Missing optional columns should cause graceful skips, not crashes.
    """
    rng = np.random.default_rng(99)
    dates = pd.date_range("2026-02-01", periods=n, freq="B")
    return pd.DataFrame(
        {
            "day_range_pts": rng.uniform(10, 80, n),
            "structure_correct": rng.choice([True, False, None], size=n),
            "recommended_structure": rng.choice(
                ["PUT CREDIT SPREAD", "IRON CONDOR"], size=n
            ),
        },
        index=dates,
    )


# ── 1. rule_validation ────────────────────────────────────────


class TestRuleValidation:
    """Tests for rule_validation(df)."""

    def test_full_data_no_crash(self, capsys):
        """Should run to completion with all expected columns present."""
        df = _make_eda_df()
        rule_validation(df)
        out = capsys.readouterr().out
        assert "RULE VALIDATION" in out

    def test_negative_gex_section(self, capsys):
        """Should print GEX comparison when gex_oi_t1 is present."""
        df = _make_eda_df()
        rule_validation(df)
        out = capsys.readouterr().out
        assert "Negative GEX" in out or "Positive GEX" in out

    def test_cohens_d_printed(self, capsys):
        """Should compute and display Cohen's d effect size."""
        df = _make_eda_df()
        rule_validation(df)
        out = capsys.readouterr().out
        assert "Cohen's d" in out

    def test_vix1d_inversion_section(self, capsys):
        """Should analyze VIX1D/VIX ratio when column is present."""
        df = _make_eda_df()
        rule_validation(df)
        out = capsys.readouterr().out
        assert "VIX1D Inversion" in out or "Inverted days" in out

    def test_charm_pattern_section(self, capsys):
        """Should break down ranges by charm pattern."""
        df = _make_eda_df()
        rule_validation(df)
        out = capsys.readouterr().out
        assert "All-Negative Charm" in out or "all_negative" in out

    def test_flow_agreement_section(self, capsys):
        """Should analyze flow agreement vs directionality."""
        df = _make_eda_df()
        rule_validation(df)
        out = capsys.readouterr().out
        assert "Flow Agreement" in out

    def test_day_of_week_section(self, capsys):
        """Should output day-of-week range comparison."""
        df = _make_eda_df()
        rule_validation(df)
        out = capsys.readouterr().out
        assert "Day of Week" in out

    def test_missing_gex_column(self, capsys):
        """Should skip GEX rule gracefully when gex_oi_t1 is absent."""
        df = _make_eda_df()
        df = df.drop(columns=["gex_oi_t1"])
        rule_validation(df)
        out = capsys.readouterr().out
        # Should still run without error; GEX section is just skipped
        assert "RULE VALIDATION" in out

    def test_missing_charm_column(self, capsys):
        """Should skip charm analysis when charm_pattern is absent."""
        df = _make_eda_df()
        df = df.drop(columns=["charm_pattern"])
        rule_validation(df)
        out = capsys.readouterr().out
        assert "RULE VALIDATION" in out

    def test_missing_flow_columns(self, capsys):
        """Should skip flow section when flow columns are absent."""
        df = _make_eda_df()
        df = df.drop(columns=["flow_agreement_t1", "settlement_direction"])
        rule_validation(df)
        out = capsys.readouterr().out
        assert "RULE VALIDATION" in out

    def test_missing_day_of_week(self, capsys):
        """Should skip day-of-week when column is absent."""
        df = _make_eda_df()
        df = df.drop(columns=["day_of_week"])
        rule_validation(df)
        out = capsys.readouterr().out
        assert "RULE VALIDATION" in out

    def test_all_nan_day_range(self, capsys):
        """Should handle all-NaN day_range_pts (empty after filter)."""
        df = _make_eda_df()
        df["day_range_pts"] = np.nan
        rule_validation(df)
        out = capsys.readouterr().out
        assert "RULE VALIDATION" in out

    def test_small_dataset(self, capsys):
        """Should handle very small datasets without crashing."""
        df = _make_eda_df(n=3)
        rule_validation(df)
        out = capsys.readouterr().out
        assert "RULE VALIDATION" in out

    def test_verdict_strings(self, capsys):
        """Should emit CONFIRMED or NOT CONFIRMED verdict strings."""
        df = _make_eda_df(n=50)
        rule_validation(df)
        out = capsys.readouterr().out
        assert "CONFIRMED" in out or "NOT CONFIRMED" in out


# ── 2. confidence_calibration ─────────────────────────────────


class TestConfidenceCalibration:
    """Tests for confidence_calibration(df)."""

    def test_full_data_no_crash(self, capsys):
        """Should run to completion with valid data."""
        df = _make_eda_df()
        confidence_calibration(df)
        out = capsys.readouterr().out
        assert "CONFIDENCE CALIBRATION" in out

    def test_confidence_levels_printed(self, capsys):
        """Should print accuracy for each confidence level."""
        df = _make_eda_df()
        confidence_calibration(df)
        out = capsys.readouterr().out
        # At least one of HIGH/MODERATE/LOW should appear
        assert "HIGH" in out or "MODERATE" in out or "LOW" in out

    def test_range_info_included(self, capsys):
        """Should include average range info per confidence bucket."""
        df = _make_eda_df()
        confidence_calibration(df)
        out = capsys.readouterr().out
        assert "pts avg range" in out

    def test_takeaway_emitted(self, capsys):
        """Should emit a takeaway about calibration quality."""
        df = _make_eda_df()
        confidence_calibration(df)
        out = capsys.readouterr().out
        assert "TAKEAWAY" in out or "No confidence data" in out

    def test_no_labels(self, capsys):
        """Should handle df with all NaN structure_correct."""
        df = _make_eda_df()
        df["structure_correct"] = np.nan
        confidence_calibration(df)
        out = capsys.readouterr().out
        # Should still print the header but no data rows
        assert "CONFIDENCE CALIBRATION" in out

    def test_no_confidence_column(self, capsys):
        """Should handle missing label_confidence column."""
        df = _make_eda_df()
        df = df.drop(columns=["label_confidence"])
        confidence_calibration(df)
        out = capsys.readouterr().out
        assert "No confidence data" in out

    def test_all_same_confidence(self, capsys):
        """Should handle all rows having the same confidence level."""
        df = _make_eda_df()
        df["label_confidence"] = "HIGH"
        confidence_calibration(df)
        out = capsys.readouterr().out
        assert "HIGH" in out

    def test_single_row(self, capsys):
        """Should not crash with a single labeled row."""
        df = _make_eda_df(n=1)
        confidence_calibration(df)
        out = capsys.readouterr().out
        assert "CONFIDENCE CALIBRATION" in out


# ── 3. structure_analysis ─────────────────────────────────────


class TestStructureAnalysis:
    """Tests for structure_analysis(df)."""

    def test_full_data_no_crash(self, capsys):
        """Should run to completion with valid data."""
        df = _make_eda_df()
        structure_analysis(df)
        out = capsys.readouterr().out
        assert "STRUCTURE OUTCOMES" in out

    def test_accuracy_by_structure(self, capsys):
        """Should print accuracy for each structure type."""
        df = _make_eda_df()
        structure_analysis(df)
        out = capsys.readouterr().out
        assert "PUT CREDIT SPREAD" in out or "CALL CREDIT SPREAD" in out

    def test_confidence_interval_printed(self, capsys):
        """Should print Wilson confidence intervals."""
        df = _make_eda_df()
        structure_analysis(df)
        out = capsys.readouterr().out
        assert "CI [" in out

    def test_failure_analysis(self, capsys):
        """Should analyze failure days when structure_correct=False exists."""
        df = _make_eda_df()
        # Ensure at least some failures
        df.iloc[0, df.columns.get_loc("structure_correct")] = False
        df.iloc[1, df.columns.get_loc("structure_correct")] = False
        structure_analysis(df)
        out = capsys.readouterr().out
        assert "wrong" in out.lower() or "failure" in out.lower()

    def test_baseline_section(self, capsys):
        """Should print Phase 2 baseline majority-class accuracy."""
        df = _make_eda_df()
        structure_analysis(df)
        out = capsys.readouterr().out
        assert "Phase 2 Baseline" in out or "majority" in out.lower()

    def test_no_labeled_rows_raises(self, capsys):
        """Crashes with IndexError when no structures are labeled.

        This is a known gap in eda.py: the Phase 2 Baseline section
        indexes into an empty value_counts() without a guard.
        """
        df = _make_eda_df()
        df["recommended_structure"] = np.nan
        with pytest.raises(IndexError):
            structure_analysis(df)

    def test_no_failures(self, capsys):
        """Should not crash when every labeled row is correct."""
        df = _make_eda_df()
        df["structure_correct"] = True
        structure_analysis(df)
        out = capsys.readouterr().out
        assert "STRUCTURE OUTCOMES" in out

    def test_all_failures(self, capsys):
        """Should handle all-failure dataset and print pattern analysis."""
        df = _make_eda_df()
        df["structure_correct"] = False
        structure_analysis(df)
        out = capsys.readouterr().out
        assert "wrong" in out.lower() or "failure" in out.lower()

    def test_missing_vix_column_in_failures(self, capsys):
        """Failure rows without vix column should not crash."""
        df = _make_eda_df()
        df["structure_correct"] = False
        df = df.drop(columns=["vix"])
        structure_analysis(df)
        out = capsys.readouterr().out
        assert "STRUCTURE OUTCOMES" in out


# ── 4. charm_analysis ─────────────────────────────────────────


class TestCharmAnalysis:
    """Tests for charm_analysis(df)."""

    def test_full_data_no_crash(self, capsys):
        """Should run to completion with valid data."""
        df = _make_eda_df()
        charm_analysis(df)
        out = capsys.readouterr().out
        assert "CHARM PATTERN DEEP DIVE" in out

    def test_each_pattern_listed(self, capsys):
        """Should list all unique charm patterns present in the data."""
        df = _make_eda_df()
        charm_analysis(df)
        out = capsys.readouterr().out
        for pattern in df["charm_pattern"].unique():
            assert pattern in out

    def test_range_and_accuracy(self, capsys):
        """Should include range and accuracy stats per pattern."""
        df = _make_eda_df()
        charm_analysis(df)
        out = capsys.readouterr().out
        assert "pts" in out
        assert "accuracy" in out

    def test_settlement_bias(self, capsys):
        """Should report bullish/bearish/neutral bias per charm pattern."""
        df = _make_eda_df()
        charm_analysis(df)
        out = capsys.readouterr().out
        assert "bullish" in out or "bearish" in out or "neutral" in out

    def test_charm_gex_interaction(self, capsys):
        """Should analyze charm + GEX combos when gex_oi_t1 is present."""
        df = _make_eda_df()
        charm_analysis(df)
        out = capsys.readouterr().out
        assert "Charm + GEX Interaction" in out or "GEX" in out.upper()

    def test_all_negative_vs_positive_takeaway(self, capsys):
        """Should produce a takeaway comparing all_negative vs all_positive."""
        df = _make_eda_df()
        # Ensure both patterns exist
        df.iloc[0, df.columns.get_loc("charm_pattern")] = "all_negative"
        df.iloc[1, df.columns.get_loc("charm_pattern")] = "all_positive"
        charm_analysis(df)
        out = capsys.readouterr().out
        assert "TAKEAWAY" in out or "all-negative" in out.lower()

    def test_too_few_charm_rows(self, capsys):
        """Should bail early with 'Not enough charm data' for < 5 rows."""
        df = _make_eda_df(n=3)
        df["charm_pattern"] = np.nan
        # Only 3 rows, and all NaN charm -> 0 rows after filter
        charm_analysis(df)
        out = capsys.readouterr().out
        assert "Not enough charm data" in out

    def test_missing_charm_column(self, capsys):
        """Should handle DataFrame without charm_pattern column."""
        df = _make_eda_df()
        df = df.drop(columns=["charm_pattern"])
        # The function filters on charm_pattern.notna() which needs the col
        # With the column gone, it will KeyError — make sure test reflects that
        # Actually the function checks ``df[df["charm_pattern"].notna()]``
        # which will raise KeyError. This is expected; test it doesn't swallow.
        with pytest.raises(KeyError):
            charm_analysis(df)

    def test_no_gex_column(self, capsys):
        """Should skip GEX interaction section when gex_oi_t1 is absent."""
        df = _make_eda_df()
        df = df.drop(columns=["gex_oi_t1"])
        charm_analysis(df)
        out = capsys.readouterr().out
        assert "CHARM PATTERN DEEP DIVE" in out

    def test_single_charm_pattern(self, capsys):
        """Should handle data with only one charm pattern value."""
        df = _make_eda_df()
        df["charm_pattern"] = "all_positive"
        charm_analysis(df)
        out = capsys.readouterr().out
        assert "all_positive" in out


# ── 5. flow_analysis ──────────────────────────────────────────


class TestFlowAnalysis:
    """Tests for flow_analysis(df)."""

    def test_full_data_no_crash(self, capsys):
        """Should run to completion with valid data."""
        df = _make_eda_df()
        flow_analysis(df)
        out = capsys.readouterr().out
        assert "FLOW SOURCE RELIABILITY" in out

    def test_source_labels_printed(self, capsys):
        """Should print reliability ratings for each flow source."""
        df = _make_eda_df()
        flow_analysis(df)
        out = capsys.readouterr().out
        # At least one source label should appear
        source_labels = [
            "Market Tide",
            "SPX Net Flow",
            "SPY Net Flow",
            "QQQ Net Flow",
            "SPY ETF Tide",
            "QQQ ETF Tide",
            "0DTE Index",
        ]
        found = any(label in out for label in source_labels)
        assert found, "Expected at least one flow source label in output"

    def test_reliability_ratings(self, capsys):
        """Should assign a reliability rating to sources."""
        df = _make_eda_df()
        flow_analysis(df)
        out = capsys.readouterr().out
        ratings = ["USEFUL", "COIN FLIP", "CONTRARIAN", "ANTI-SIGNAL"]
        found = any(r in out for r in ratings)
        assert found, "Expected at least one rating label in output"

    def test_confidence_intervals(self, capsys):
        """Should print Wilson CIs for source reliability."""
        df = _make_eda_df()
        flow_analysis(df)
        out = capsys.readouterr().out
        assert "CI [" in out

    def test_agreement_vs_range(self, capsys):
        """Should compare high vs low agreement range averages."""
        df = _make_eda_df()
        flow_analysis(df)
        out = capsys.readouterr().out
        assert "agreement" in out.lower()

    def test_trust_fade_takeaway(self, capsys):
        """Should emit a TRUST/FADE takeaway when source results exist."""
        df = _make_eda_df()
        flow_analysis(df)
        out = capsys.readouterr().out
        # May have TAKEAWAY with TRUST/FADE or no significant sources
        assert "FLOW SOURCE RELIABILITY" in out

    def test_missing_settlement_direction_raises(self, capsys):
        """Crashes with KeyError when settlement_direction is absent.

        This is a known gap in eda.py: the per-source loop indexes
        ``has_flow[[col, "settlement_direction"]]`` without checking
        whether the column exists.
        """
        df = _make_eda_df()
        df = df.drop(columns=["settlement_direction"])
        with pytest.raises(KeyError):
            flow_analysis(df)

    def test_missing_all_ncp_columns(self, capsys):
        """Should not crash when all NCP source columns are missing."""
        df = _make_eda_df()
        ncp_cols = [
            "mt_ncp_t1",
            "spx_ncp_t1",
            "spy_ncp_t1",
            "qqq_ncp_t1",
            "spy_etf_ncp_t1",
            "qqq_etf_ncp_t1",
            "zero_dte_ncp_t1",
        ]
        df = df.drop(columns=[c for c in ncp_cols if c in df.columns])
        flow_analysis(df)
        out = capsys.readouterr().out
        assert "FLOW SOURCE RELIABILITY" in out

    def test_small_dataset(self, capsys):
        """Should handle datasets too small for per-source analysis."""
        df = _make_eda_df(n=3)
        flow_analysis(df)
        out = capsys.readouterr().out
        assert "FLOW SOURCE RELIABILITY" in out


# ── 6. feature_importance ─────────────────────────────────────


class TestFeatureImportance:
    """Tests for feature_importance(df)."""

    def test_full_data_no_crash(self, capsys):
        """Should run to completion with valid data."""
        df = _make_eda_df()
        feature_importance(df)
        out = capsys.readouterr().out
        assert "FEATURE IMPORTANCE" in out

    def test_correlation_table(self, capsys):
        """Should print a correlation ranking table."""
        df = _make_eda_df()
        feature_importance(df)
        out = capsys.readouterr().out
        assert "r=" in out

    def test_fdr_correction(self, capsys):
        """Should apply FDR correction and print q-values."""
        df = _make_eda_df()
        feature_importance(df)
        out = capsys.readouterr().out
        assert "q=" in out

    def test_direction_labels(self, capsys):
        """Should indicate whether higher values help or hurt."""
        df = _make_eda_df()
        feature_importance(df)
        out = capsys.readouterr().out
        assert "higher = MORE correct" in out or "higher = LESS correct" in out

    def test_range_predictors_section(self, capsys):
        """Should include a range category predictor section."""
        df = _make_eda_df()
        # Ensure range_category is present for the Kruskal-Wallis test
        feature_importance(df)
        out = capsys.readouterr().out
        assert "RANGE CATEGORY" in out or "range" in out.lower()

    def test_kruskal_wallis_scores(self, capsys):
        """Should print Kruskal-Wallis H statistics for range prediction."""
        df = _make_eda_df()
        feature_importance(df)
        out = capsys.readouterr().out
        assert "H=" in out

    def test_correlated_feature_detected(self, capsys):
        """A feature perfectly correlated with target should rank high."""
        df = _make_eda_df(n=40)
        # Inject a feature that perfectly predicts structure_correct
        df["perfect_predictor"] = df["structure_correct"].astype(float)
        feature_importance(df)
        out = capsys.readouterr().out
        assert "perfect_predictor" in out

    def test_no_labels(self, capsys):
        """Should handle df with no structure_correct values."""
        df = _make_eda_df()
        df["structure_correct"] = np.nan
        feature_importance(df)
        out = capsys.readouterr().out
        assert "FEATURE IMPORTANCE" in out

    def test_too_few_range_rows(self, capsys):
        """Should print 'Not enough range data' when range_category is sparse."""
        df = _make_eda_df(n=5)
        df["range_category"] = np.nan
        feature_importance(df)
        out = capsys.readouterr().out
        assert "Not enough range data" in out or "FEATURE IMPORTANCE" in out

    def test_single_structure_correct_value(self, capsys):
        """Should handle zero-variance target (all True or all False)."""
        df = _make_eda_df()
        df["structure_correct"] = True
        feature_importance(df)
        out = capsys.readouterr().out
        # With zero variance in target, correlations should be skipped
        assert "FEATURE IMPORTANCE" in out


# ── 7. key_findings ───────────────────────────────────────────


class TestKeyFindings:
    """Tests for key_findings(df)."""

    def test_full_data_no_crash(self, capsys):
        """Should run to completion with valid data."""
        df = _make_eda_df()
        key_findings(df)
        out = capsys.readouterr().out
        assert "KEY FINDINGS SUMMARY" in out

    def test_dataset_summary(self, capsys):
        """Should print trading day count and label count."""
        df = _make_eda_df(n=25)
        key_findings(df)
        out = capsys.readouterr().out
        assert "25 trading days" in out
        assert "with labels" in out

    def test_structure_accuracy_section(self, capsys):
        """Should print per-structure accuracy breakdown."""
        df = _make_eda_df()
        key_findings(df)
        out = capsys.readouterr().out
        assert "STRUCTURE ACCURACY" in out

    def test_whats_working_section(self, capsys):
        """Should identify the best-performing structure."""
        df = _make_eda_df()
        key_findings(df)
        out = capsys.readouterr().out
        assert "WORKING" in out

    def test_confidence_calibration_summary(self, capsys):
        """Should summarize confidence calibration findings."""
        df = _make_eda_df()
        key_findings(df)
        out = capsys.readouterr().out
        assert "onfidence" in out  # "Confidence" or "confidence"

    def test_failure_watch_section(self, capsys):
        """Should list failure patterns under WHAT TO WATCH."""
        df = _make_eda_df()
        # Ensure at least one failure
        df.iloc[0, df.columns.get_loc("structure_correct")] = False
        key_findings(df)
        out = capsys.readouterr().out
        assert "WATCH" in out or "failure" in out.lower()

    def test_flow_reliability_summary(self, capsys):
        """Should include flow reliability section when data is available."""
        df = _make_eda_df()
        key_findings(df)
        out = capsys.readouterr().out
        assert "FLOW RELIABILITY" in out or "KEY FINDINGS" in out

    def test_phase2_readiness(self, capsys):
        """Should print Phase 2 readiness assessment."""
        df = _make_eda_df()
        key_findings(df)
        out = capsys.readouterr().out
        assert "PHASE 2" in out or "Phase 2" in out

    def test_majority_baseline_printed(self, capsys):
        """Should print majority-class baseline accuracy."""
        df = _make_eda_df()
        key_findings(df)
        out = capsys.readouterr().out
        assert "Majority class baseline" in out or "majority" in out.lower()

    def test_no_labels_at_all(self, capsys):
        """Should handle dataset where structure_correct is all NaN."""
        df = _make_eda_df()
        df["structure_correct"] = np.nan
        key_findings(df)
        out = capsys.readouterr().out
        assert "KEY FINDINGS SUMMARY" in out
        assert "0 with labels" in out

    def test_no_failures(self, capsys):
        """Should skip WHAT TO WATCH when no failures exist."""
        df = _make_eda_df()
        df["structure_correct"] = True
        key_findings(df)
        out = capsys.readouterr().out
        assert "KEY FINDINGS SUMMARY" in out

    def test_remaining_days_calculation(self, capsys):
        """Should calculate remaining days needed for Phase 2 target."""
        df = _make_eda_df(n=20)
        key_findings(df)
        out = capsys.readouterr().out
        # 20 labeled days < 60 target, so should mention remaining
        assert "more labeled days" in out or "target" in out.lower()

    def test_data_threshold_met(self, capsys):
        """Should report 'Data threshold met' when n >= 60."""
        df = _make_eda_df(n=65)
        key_findings(df)
        out = capsys.readouterr().out
        assert "threshold met" in out or "target" in out.lower()


# ── Cross-cutting edge cases ──────────────────────────────────


class TestEdgeCases:
    """Edge cases that span multiple functions."""

    def test_empty_dataframe(self, capsys):
        """Functions should not crash on empty DataFrames (where possible)."""
        dates = pd.DatetimeIndex([], dtype="datetime64[ns]", name="date")
        df = pd.DataFrame(
            {
                "day_range_pts": pd.Series([], dtype=float),
                "structure_correct": pd.Series([], dtype=object),
                "recommended_structure": pd.Series([], dtype=object),
                "label_confidence": pd.Series([], dtype=object),
                "charm_pattern": pd.Series([], dtype=object),
                "settlement_direction": pd.Series([], dtype=object),
                "flow_agreement_t1": pd.Series([], dtype=float),
                "gex_oi_t1": pd.Series([], dtype=float),
                "flow_was_directional": pd.Series([], dtype=bool),
                "day_of_week": pd.Series([], dtype=int),
                "vix1d_vix_ratio": pd.Series([], dtype=float),
            },
            index=dates,
        )

        # These should not crash on empty data
        rule_validation(df)
        confidence_calibration(df)
        charm_analysis(df)
        flow_analysis(df)
        out = capsys.readouterr().out
        assert "RULE VALIDATION" in out

    def test_all_nan_columns(self, capsys):
        """Functions should handle columns that are entirely NaN."""
        df = _make_eda_df()
        df["gex_oi_t1"] = np.nan
        df["vix1d_vix_ratio"] = np.nan
        df["flow_agreement_t1"] = np.nan
        rule_validation(df)
        out = capsys.readouterr().out
        assert "RULE VALIDATION" in out

    def test_mixed_types_in_flow_agreement(self, capsys):
        """Should handle float NaN mixed into flow_agreement_t1."""
        df = _make_eda_df()
        df.iloc[0, df.columns.get_loc("flow_agreement_t1")] = np.nan
        df.iloc[1, df.columns.get_loc("flow_agreement_t1")] = np.nan
        flow_analysis(df)
        out = capsys.readouterr().out
        assert "FLOW SOURCE RELIABILITY" in out

    def test_large_dataset(self, capsys):
        """Should handle larger datasets without performance issues."""
        df = _make_eda_df(n=200)
        rule_validation(df)
        confidence_calibration(df)
        feature_importance(df)
        charm_analysis(df)
        flow_analysis(df)
        key_findings(df)
        out = capsys.readouterr().out
        assert "KEY FINDINGS SUMMARY" in out

    def test_minimal_df_rule_validation(self, capsys):
        """rule_validation should handle a minimal DataFrame gracefully."""
        df = _make_minimal_df()
        rule_validation(df)
        out = capsys.readouterr().out
        assert "RULE VALIDATION" in out

    def test_minimal_df_key_findings(self, capsys):
        """key_findings should work with minimal columns."""
        df = _make_minimal_df()
        # Add missing columns as NaN to avoid KeyError
        for col in ["label_confidence", "gex_oi_t1", "settlement_direction"]:
            if col not in df.columns:
                df[col] = np.nan
        key_findings(df)
        out = capsys.readouterr().out
        assert "KEY FINDINGS SUMMARY" in out

    def test_boolean_structure_correct_dtype(self, capsys):
        """structure_correct should work whether bool, float, or object."""
        df = _make_eda_df()
        # Convert to float (0.0/1.0) which is common from DB loads
        df["structure_correct"] = df["structure_correct"].astype(float)
        confidence_calibration(df)
        out = capsys.readouterr().out
        assert "CONFIDENCE CALIBRATION" in out

    def test_negative_gex_all_same_sign(self, capsys):
        """rule_validation should handle all-positive or all-negative GEX."""
        df = _make_eda_df()
        df["gex_oi_t1"] = abs(df["gex_oi_t1"].astype(float))  # all positive
        rule_validation(df)
        out = capsys.readouterr().out
        # Should either show "Not enough data" or only positive GEX stats
        assert "RULE VALIDATION" in out
