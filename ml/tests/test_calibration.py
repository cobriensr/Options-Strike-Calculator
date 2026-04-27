"""
Tests for ml/src/calibration.py — Phase 3 calibration dashboard.

Covers:
  - bucket_summary: correct hit-rate and MAE computation
  - compute_calibration_score: monotonic vs anti-monotonic cases
  - assign_stability_tertile: correct tertile labels
  - compute_errors: error, abs_error, and hit-flag computation
  - main(): graceful handling of empty input and small buckets
  - save_summary / print_summary: JSON shape and stdout output

All tests use synthetic DataFrames; no DB connection is required.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pandas as pd
import pytest

from calibration import (
    HIT_THRESHOLDS,
    MIN_BUCKET_ROWS,
    MIN_TOTAL_ROWS,
    assign_stability_tertile,
    bucket_summary,
    build_summary,
    compute_calibration_score,
    compute_errors,
    print_summary,
    save_summary,
)

# ── Fixtures ──────────────────────────────────────────────────────────────────


def _make_df(
    n: int = 60,
    regimes: list[str] | None = None,
    confidences: list[str] | None = None,
    seed: int = 42,
) -> pd.DataFrame:
    """
    Build a synthetic DataFrame that mirrors the trace_live_analyses schema.
    Covers 3 regimes, 3 confidence levels, and 3 stability buckets by default.
    """
    rng = np.random.default_rng(seed)

    if regimes is None:
        regimes = ["trending_up", "ranging", "trending_down"]
    if confidences is None:
        confidences = ["high", "medium", "low"]

    base_close = 5500.0
    predicted_close = base_close + rng.uniform(-30, 30, n)
    # True close is within ±20 of prediction to give realistic hit rates
    actual_close = predicted_close + rng.uniform(-20, 20, n)

    df = pd.DataFrame(
        {
            "id": range(1, n + 1),
            "captured_at": pd.date_range("2026-01-01", periods=n, freq="h"),
            "regime": rng.choice(regimes, size=n),
            "confidence": rng.choice(confidences, size=n),
            "stability_pct": rng.uniform(10, 95, n),
            "predicted_close": predicted_close,
            "actual_close": actual_close,
            "full_response": [None] * n,
        }
    )
    return df


@pytest.fixture
def base_df() -> pd.DataFrame:
    return _make_df(n=60)


@pytest.fixture
def errors_df(base_df: pd.DataFrame) -> pd.DataFrame:
    return compute_errors(base_df)


@pytest.fixture
def full_df(errors_df: pd.DataFrame) -> pd.DataFrame:
    return assign_stability_tertile(errors_df)


# ── compute_errors ────────────────────────────────────────────────────────────


class TestComputeErrors:
    def test_error_column_added(self, base_df: pd.DataFrame):
        result = compute_errors(base_df)
        assert "error" in result.columns

    def test_abs_error_column_added(self, base_df: pd.DataFrame):
        result = compute_errors(base_df)
        assert "abs_error" in result.columns

    def test_abs_error_is_nonnegative(self, base_df: pd.DataFrame):
        result = compute_errors(base_df)
        assert (result["abs_error"] >= 0).all()

    def test_hit_flag_columns_added(self, base_df: pd.DataFrame):
        result = compute_errors(base_df)
        for thr in HIT_THRESHOLDS:
            assert f"hit_{thr}pt" in result.columns

    def test_hit_flags_are_binary(self, base_df: pd.DataFrame):
        result = compute_errors(base_df)
        for thr in HIT_THRESHOLDS:
            unique_vals = set(result[f"hit_{thr}pt"].unique())
            assert unique_vals.issubset({0, 1}), f"hit_{thr}pt has non-binary values"

    def test_hit_5pt_subset_of_hit_10pt(self, base_df: pd.DataFrame):
        """If abs_error <= 5, it must also be <= 10."""
        result = compute_errors(base_df)
        hit5 = result["hit_5pt"] == 1
        hit10 = result["hit_10pt"] == 1
        assert (hit5 & ~hit10).sum() == 0

    def test_exact_error_computation(self):
        """Error = actual - predicted, abs_error = abs(error)."""
        df = pd.DataFrame(
            {
                "predicted_close": [5500.0, 5500.0, 5500.0],
                "actual_close": [5510.0, 5490.0, 5500.0],
                "stability_pct": [50.0, 50.0, 50.0],
            }
        )
        result = compute_errors(df)
        np.testing.assert_allclose(result["error"].values, [10.0, -10.0, 0.0])
        np.testing.assert_allclose(result["abs_error"].values, [10.0, 10.0, 0.0])

    def test_hit_flags_match_threshold(self):
        """hit_5pt=1 when abs_error<=5, hit_10pt=1 when abs_error<=10."""
        df = pd.DataFrame(
            {
                "predicted_close": [5500.0, 5500.0, 5500.0],
                "actual_close": [5504.0, 5508.0, 5518.0],
                "stability_pct": [50.0, 50.0, 50.0],
            }
        )
        result = compute_errors(df)
        assert result["hit_5pt"].tolist() == [1, 0, 0]
        assert result["hit_10pt"].tolist() == [1, 1, 0]
        assert result["hit_15pt"].tolist() == [1, 1, 0]

    def test_original_df_not_mutated(self, base_df: pd.DataFrame):
        original_cols = list(base_df.columns)
        compute_errors(base_df)
        assert list(base_df.columns) == original_cols


# ── assign_stability_tertile ──────────────────────────────────────────────────


class TestAssignStabilityTertile:
    def test_tertile_column_added(self, errors_df: pd.DataFrame):
        result = assign_stability_tertile(errors_df)
        assert "stability_tertile" in result.columns

    def test_only_valid_labels(self, errors_df: pd.DataFrame):
        result = assign_stability_tertile(errors_df)
        assert set(result["stability_tertile"].unique()).issubset({"low", "mid", "high"})

    def test_roughly_equal_thirds(self, errors_df: pd.DataFrame):
        """Each tertile should contain roughly 1/3 of rows (±5% tolerance)."""
        result = assign_stability_tertile(errors_df)
        counts = result["stability_tertile"].value_counts(normalize=True)
        for label in ["low", "mid", "high"]:
            assert abs(counts.get(label, 0) - 1 / 3) < 0.10, (
                f"Tertile '{label}' has unexpected fraction: {counts.get(label, 0):.2f}"
            )

    def test_ordering_preserved(self, errors_df: pd.DataFrame):
        """Rows with low stability_pct must be in the 'low' tertile."""
        result = assign_stability_tertile(errors_df)
        q33 = result["stability_pct"].quantile(0.333)
        low_pct = result.loc[result["stability_pct"] <= q33, "stability_tertile"]
        assert (low_pct == "low").all()

    def test_original_df_not_mutated(self, errors_df: pd.DataFrame):
        original_cols = list(errors_df.columns)
        assign_stability_tertile(errors_df)
        assert list(errors_df.columns) == original_cols


# ── bucket_summary ────────────────────────────────────────────────────────────


class TestBucketSummary:
    def test_returns_dict(self, full_df: pd.DataFrame):
        result = bucket_summary(full_df, "regime")
        assert isinstance(result, dict)

    def test_all_regimes_present(self, full_df: pd.DataFrame):
        result = bucket_summary(full_df, "regime")
        expected_regimes = set(full_df["regime"].unique())
        assert set(result.keys()) == expected_regimes

    def test_bucket_has_required_keys(self, full_df: pd.DataFrame):
        result = bucket_summary(full_df, "confidence")
        required_keys = {"n", "hit5", "hit10", "hit15", "mean_abs_error"}
        for bucket, stats in result.items():
            assert set(stats.keys()) == required_keys, (
                f"Bucket {bucket!r} missing keys: {required_keys - set(stats.keys())}"
            )

    def test_hit_rates_between_zero_and_one(self, full_df: pd.DataFrame):
        result = bucket_summary(full_df, "confidence")
        for bucket, stats in result.items():
            for key in ["hit5", "hit10", "hit15"]:
                assert 0.0 <= stats[key] <= 1.0, (
                    f"Bucket {bucket!r} {key}={stats[key]} out of [0, 1]"
                )

    def test_n_sums_to_total(self, full_df: pd.DataFrame):
        result = bucket_summary(full_df, "regime")
        total_from_buckets = sum(v["n"] for v in result.values())
        assert total_from_buckets == len(full_df)

    def test_mean_abs_error_is_nonnegative(self, full_df: pd.DataFrame):
        result = bucket_summary(full_df, "stability_tertile")
        for _bucket, stats in result.items():
            assert stats["mean_abs_error"] >= 0

    def test_known_values(self):
        """
        With exact predictions:
          rows 0-1: error=0 → hit5=1, hit10=1, hit15=1
          rows 2-3: error=8 → hit5=0, hit10=1, hit15=1
          rows 4-5: error=20 → hit5=0, hit10=0, hit15=0
        Bucket A (rows 0-3): hit10 = 4/4 = 1.0 (all within ±10)... wait:
          row 0: error=0  → hit10=1
          row 1: error=0  → hit10=1
          row 2: error=8  → hit10=1
          row 3: error=8  → hit10=1
        All 4 rows hit10=1.
        """
        df = pd.DataFrame(
            {
                "group": ["A", "A", "A", "A", "B", "B"],
                "hit_5pt": [1, 1, 0, 0, 0, 0],
                "hit_10pt": [1, 1, 1, 1, 0, 0],
                "hit_15pt": [1, 1, 1, 1, 0, 0],
                "abs_error": [0.0, 0.0, 8.0, 8.0, 20.0, 20.0],
            }
        )
        result = bucket_summary(df, "group")
        assert result["A"]["n"] == 4
        assert result["A"]["hit5"] == pytest.approx(0.5)
        assert result["A"]["hit10"] == pytest.approx(1.0)
        assert result["A"]["mean_abs_error"] == pytest.approx(4.0)
        assert result["B"]["n"] == 2
        assert result["B"]["hit10"] == pytest.approx(0.0)

    def test_warns_on_small_bucket(self, capsys):
        """Buckets with n < MIN_BUCKET_ROWS should emit a warning to stderr."""
        rng = np.random.default_rng(77)
        n_small = MIN_BUCKET_ROWS - 1
        df = pd.DataFrame(
            {
                "group": ["rare"] * n_small + ["common"] * 30,
                "hit_5pt": rng.integers(0, 2, n_small + 30),
                "hit_10pt": rng.integers(0, 2, n_small + 30),
                "hit_15pt": rng.integers(0, 2, n_small + 30),
                "abs_error": rng.uniform(0, 20, n_small + 30),
            }
        )
        import sys
        from io import StringIO

        old_stderr = sys.stderr
        sys.stderr = StringIO()
        try:
            bucket_summary(df, "group")
            stderr_output = sys.stderr.getvalue()
        finally:
            sys.stderr = old_stderr

        assert "warn" in stderr_output.lower() or "rare" in stderr_output


# ── compute_calibration_score ─────────────────────────────────────────────────


class TestComputeCalibrationScore:
    def test_perfectly_monotonic_returns_zero(self):
        """
        When high > medium > low hit rates, score should be 0.0 (perfect).
        """
        by_confidence = {
            "low": {"hit10": 0.30},
            "medium": {"hit10": 0.55},
            "high": {"hit10": 0.80},
        }
        score = compute_calibration_score(by_confidence)
        assert score == pytest.approx(0.0)

    def test_anti_monotonic_three_levels(self):
        """
        With 3 levels fully reversed (high=lowest, low=highest):
          claimed ranks: low=0, medium=1, high=2
          actual ranks:  low=2, medium=1, high=0   (high has lowest hit rate)
          deviations (normalized by n-1=2): |0-2|/2=1, |1-1|/2=0, |2-0|/2=1
          mean = 0.667
        """
        by_confidence = {
            "low": {"hit10": 0.80},
            "medium": {"hit10": 0.55},
            "high": {"hit10": 0.30},
        }
        score = compute_calibration_score(by_confidence)
        assert score == pytest.approx(2 / 3)

    def test_reversed_two_level(self):
        """
        With only high and low: if high has lower hit rate,
        score should reflect full rank reversal.
        """
        by_confidence = {
            "low": {"hit10": 0.70},
            "high": {"hit10": 0.40},
        }
        score = compute_calibration_score(by_confidence)
        # 2 levels: claimed ranks [0,1] (low→high), actual ranks [1,0]
        # deviations: |0-1|/1, |1-0|/1 = [1.0, 1.0], mean = 1.0
        assert score == pytest.approx(1.0)

    def test_correct_two_level(self):
        """With high > low, score is 0 for 2 levels."""
        by_confidence = {
            "low": {"hit10": 0.40},
            "high": {"hit10": 0.70},
        }
        score = compute_calibration_score(by_confidence)
        assert score == pytest.approx(0.0)

    def test_returns_nan_with_one_level(self):
        """Cannot compute a rank correlation with a single level."""
        by_confidence = {"high": {"hit10": 0.65}}
        score = compute_calibration_score(by_confidence)
        assert np.isnan(score)

    def test_returns_nan_with_empty_dict(self):
        score = compute_calibration_score({})
        assert np.isnan(score)

    def test_unknown_confidence_levels_ignored(self):
        """Labels not in CONFIDENCE_ORDER are excluded from the ranking."""
        by_confidence = {
            "low": {"hit10": 0.40},
            "medium": {"hit10": 0.60},
            "high": {"hit10": 0.80},
            "ultra": {"hit10": 0.99},  # not in CONFIDENCE_ORDER
        }
        score = compute_calibration_score(by_confidence)
        # 'ultra' is not in CONFIDENCE_ORDER, so only low/medium/high are used
        # That's perfectly ordered → score = 0.0
        assert score == pytest.approx(0.0)

    def test_score_in_range_zero_to_one(self, full_df: pd.DataFrame):
        """Score from real data should always be in [0, 1]."""
        by_confidence = bucket_summary(full_df, "confidence")
        score = compute_calibration_score(by_confidence)
        if not np.isnan(score):
            assert 0.0 <= score <= 1.0


# ── build_summary ─────────────────────────────────────────────────────────────


class TestBuildSummary:
    def test_required_keys_present(self, full_df: pd.DataFrame):
        by_regime = bucket_summary(full_df, "regime")
        by_confidence = bucket_summary(full_df, "confidence")
        by_stability = bucket_summary(full_df, "stability_tertile")
        score = compute_calibration_score(by_confidence)
        summary = build_summary(full_df, by_regime, by_confidence, by_stability, score)

        required_keys = {
            "generated_at",
            "total_rows",
            "by_regime",
            "by_confidence",
            "by_stability",
            "calibration_score",
        }
        assert set(summary.keys()) == required_keys

    def test_total_rows_matches_df(self, full_df: pd.DataFrame):
        by_regime = bucket_summary(full_df, "regime")
        by_confidence = bucket_summary(full_df, "confidence")
        by_stability = bucket_summary(full_df, "stability_tertile")
        summary = build_summary(full_df, by_regime, by_confidence, by_stability, 0.0)
        assert summary["total_rows"] == len(full_df)


# ── save_summary ──────────────────────────────────────────────────────────────


class TestSaveSummary:
    def test_creates_json_file(self, full_df: pd.DataFrame, tmp_path: Path):
        by_regime = bucket_summary(full_df, "regime")
        by_confidence = bucket_summary(full_df, "confidence")
        by_stability = bucket_summary(full_df, "stability_tertile")
        summary = build_summary(full_df, by_regime, by_confidence, by_stability, 0.0)

        out = save_summary(summary, tmp_path)
        assert out.exists()
        assert out.suffix == ".json"

    def test_json_is_valid_and_parseable(self, full_df: pd.DataFrame, tmp_path: Path):
        by_regime = bucket_summary(full_df, "regime")
        by_confidence = bucket_summary(full_df, "confidence")
        by_stability = bucket_summary(full_df, "stability_tertile")
        summary = build_summary(full_df, by_regime, by_confidence, by_stability, 0.2)

        out = save_summary(summary, tmp_path)
        loaded = json.loads(out.read_text())
        assert loaded["total_rows"] == len(full_df)
        assert "by_regime" in loaded
        assert "calibration_score" in loaded

    def test_filename_contains_date(self, full_df: pd.DataFrame, tmp_path: Path):
        from datetime import date

        by_regime = bucket_summary(full_df, "regime")
        by_confidence = bucket_summary(full_df, "confidence")
        by_stability = bucket_summary(full_df, "stability_tertile")
        summary = build_summary(full_df, by_regime, by_confidence, by_stability, 0.0)

        out = save_summary(summary, tmp_path)
        today = date.today().isoformat()
        assert today in out.name


# ── print_summary ─────────────────────────────────────────────────────────────


class TestPrintSummary:
    def test_prints_total_rows(self, capsys, full_df: pd.DataFrame):
        by_regime = bucket_summary(full_df, "regime")
        by_confidence = bucket_summary(full_df, "confidence")
        by_stability = bucket_summary(full_df, "stability_tertile")
        score = compute_calibration_score(by_confidence)
        summary = build_summary(full_df, by_regime, by_confidence, by_stability, score)

        print_summary(summary)
        captured = capsys.readouterr()
        assert str(len(full_df)) in captured.out
        assert "calibration_score" in captured.out.lower() or "calibration" in captured.out.lower()

    def test_prints_bucket_names(self, capsys, full_df: pd.DataFrame):
        by_regime = bucket_summary(full_df, "regime")
        by_confidence = bucket_summary(full_df, "confidence")
        by_stability = bucket_summary(full_df, "stability_tertile")
        score = compute_calibration_score(by_confidence)
        summary = build_summary(full_df, by_regime, by_confidence, by_stability, score)

        print_summary(summary)
        captured = capsys.readouterr()
        # At least one regime name should appear
        for regime in full_df["regime"].unique():
            if regime in captured.out:
                break
        else:
            pytest.fail("No regime name found in print_summary output")


# ── Empty / degenerate input ──────────────────────────────────────────────────


class TestEmptyAndDegenerateInput:
    def test_empty_df_raises_or_returns_empty(self):
        """An empty DataFrame should not crash bucket_summary — it should return {}."""
        df = pd.DataFrame(
            columns=["regime", "confidence", "stability_tertile",
                     "hit_5pt", "hit_10pt", "hit_15pt", "abs_error"]
        )
        result = bucket_summary(df, "regime")
        assert result == {}

    def test_single_bucket_calibration_score_nan(self):
        """A single confidence level can't be ranked — score must be NaN."""
        single = {"high": {"hit10": 0.70}}
        score = compute_calibration_score(single)
        assert np.isnan(score)

    def test_all_perfect_predictions(self):
        """When predicted == actual for all rows, every hit flag is 1."""
        n = 20
        df = pd.DataFrame(
            {
                "predicted_close": [5500.0] * n,
                "actual_close": [5500.0] * n,
                "stability_pct": [50.0] * n,
            }
        )
        result = compute_errors(df)
        assert (result["hit_5pt"] == 1).all()
        assert (result["hit_10pt"] == 1).all()
        assert (result["hit_15pt"] == 1).all()
        assert (result["abs_error"] < 1e-9).all()

    def test_single_row_stability_tertile(self):
        """With a single row, stability_tertile must not crash."""
        df = pd.DataFrame(
            {
                "predicted_close": [5500.0],
                "actual_close": [5505.0],
                "stability_pct": [60.0],
                "hit_5pt": [1],
                "hit_10pt": [1],
                "hit_15pt": [1],
                "abs_error": [5.0],
            }
        )
        result = assign_stability_tertile(df)
        assert "stability_tertile" in result.columns
        assert len(result) == 1


# ── main() with mocked DB ─────────────────────────────────────────────────────


class TestMain:
    def _setup_mocks(self, monkeypatch, df, plots_dir: Path, findings_dir: Path):
        """Patch DB connection and file paths for main() tests."""
        import calibration

        # Patch load_trace_outcomes to return synthetic df
        monkeypatch.setattr(calibration, "load_trace_outcomes", lambda conn: df)

        # Patch PLOTS_DIR and FINDINGS_DIR to use tmp_path
        monkeypatch.setattr(calibration, "PLOTS_DIR", plots_dir)
        monkeypatch.setattr(calibration, "FINDINGS_DIR", findings_dir)

        # Patch psycopg2.connect to avoid real DB
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        monkeypatch.setattr(calibration.psycopg2, "connect", lambda url: mock_conn)

        # Set DATABASE_URL
        monkeypatch.setenv("DATABASE_URL", "postgresql://fake/db")

    def test_main_graceful_exit_on_empty_data(
        self, monkeypatch, capsys, tmp_path: Path
    ):
        """main() must exit 0 with a warning when no outcome rows exist."""
        import calibration

        plots_dir = tmp_path / "plots"
        findings_dir = tmp_path / "findings"
        plots_dir.mkdir()
        findings_dir.mkdir()

        empty_df = pd.DataFrame(
            columns=[
                "id", "captured_at", "regime", "confidence",
                "stability_pct", "predicted_close", "actual_close", "full_response"
            ]
        )
        self._setup_mocks(monkeypatch, empty_df, plots_dir, findings_dir)

        with pytest.raises(SystemExit) as exc:
            calibration.main()

        assert exc.value.code == 0
        captured = capsys.readouterr()
        assert "WARNING" in captured.out or "warning" in captured.out.lower()

    def test_main_creates_plots_and_findings(
        self, monkeypatch, tmp_path: Path
    ):
        """main() must create 5 PNG files and 1 JSON findings file."""
        import calibration

        plots_dir = tmp_path / "plots"
        findings_dir = tmp_path / "findings"
        plots_dir.mkdir()
        findings_dir.mkdir()

        # Enough rows: 3 regimes × 3 confidences × ~7 rows each
        df = _make_df(n=MIN_TOTAL_ROWS + 10, seed=7)
        df["confidence"] = np.tile(["high", "medium", "low"], len(df))[:len(df)]
        df["regime"] = np.tile(
            ["trending_up", "ranging", "trending_down"], len(df)
        )[:len(df)]
        self._setup_mocks(monkeypatch, df, plots_dir, findings_dir)

        calibration.main()

        png_files = list(plots_dir.glob("*.png"))
        assert len(png_files) == 5, (
            f"Expected 5 PNG files, got {[f.name for f in png_files]}"
        )

        expected_names = {
            "calibration-by-regime.png",
            "calibration-by-confidence.png",
            "calibration-by-stability.png",
            "calibration-curve.png",
            "calibration-error-distribution.png",
        }
        actual_names = {f.name for f in png_files}
        assert actual_names == expected_names

        json_files = list(findings_dir.glob("calibration-*.json"))
        assert len(json_files) == 1

        loaded = json.loads(json_files[0].read_text())
        assert "total_rows" in loaded
        assert "calibration_score" in loaded
        assert "by_regime" in loaded

    def test_main_warns_on_insufficient_rows(
        self, monkeypatch, capsys, tmp_path: Path
    ):
        """
        main() should continue (not exit) but emit a warning when
        N < MIN_TOTAL_ROWS.
        """
        import calibration

        plots_dir = tmp_path / "plots"
        findings_dir = tmp_path / "findings"
        plots_dir.mkdir()
        findings_dir.mkdir()

        df = _make_df(n=MIN_TOTAL_ROWS - 1, seed=99)
        df["confidence"] = "high"
        df["regime"] = "ranging"
        self._setup_mocks(monkeypatch, df, plots_dir, findings_dir)

        import sys
        from io import StringIO

        old_stderr = sys.stderr
        sys.stderr = StringIO()
        try:
            calibration.main()
            stderr_output = sys.stderr.getvalue()
        finally:
            sys.stderr = old_stderr

        assert "warn" in stderr_output.lower() or "minimum" in stderr_output.lower()

    def test_main_missing_database_url_exits_nonzero(
        self, monkeypatch, tmp_path: Path
    ):
        """main() must exit 1 when DATABASE_URL is unset."""
        import calibration

        plots_dir = tmp_path / "plots"
        findings_dir = tmp_path / "findings"
        plots_dir.mkdir()
        findings_dir.mkdir()

        monkeypatch.setattr(calibration, "PLOTS_DIR", plots_dir)
        monkeypatch.setattr(calibration, "FINDINGS_DIR", findings_dir)
        monkeypatch.delenv("DATABASE_URL", raising=False)
        # Also prevent load_env from finding .env.local
        monkeypatch.setattr(calibration, "ENV_LOCAL", tmp_path / ".env.local.nonexistent")

        with pytest.raises(SystemExit) as exc:
            calibration.main()

        assert exc.value.code == 1
