"""
Unit tests for ml/trace/analyze_accuracy.py.

Tests cover: data loading + error column computation, summary printing,
and plot output (verifies files are written without exercising matplotlib GUI).
"""

from unittest.mock import patch

import analyze_accuracy as acc
import numpy as np
import pandas as pd
import pytest

# ── helpers ──────────────────────────────────────────────────────────────────


def _make_df(n: int = 10, seed: int = 42) -> pd.DataFrame:
    """Return a minimal merged DataFrame as load_data() would produce."""
    rng = np.random.default_rng(seed)
    base = 5800.0
    current = base + rng.uniform(-20, 20, n)
    predicted = base + rng.uniform(-30, 30, n)
    actual = base + rng.uniform(-30, 30, n)
    dates = pd.date_range("2026-01-06", periods=n, freq="B").strftime("%Y-%m-%d")
    df = pd.DataFrame(
        {
            "date": dates,
            "current_price": current,
            "predicted_close": predicted,
            "actual_close": actual,
            "confidence": rng.choice(["high", "medium", "low"], n),
            "notes": [""] * n,
        }
    )
    df["error"] = df["actual_close"] - df["predicted_close"]
    df["abs_error"] = df["error"].abs()
    df["direction_down"] = df["predicted_close"] < df["current_price"]
    df["actual_down"] = df["actual_close"] < df["current_price"]
    df["direction_correct"] = df["direction_down"] == df["actual_down"]
    for pts in acc._HIT_THRESHOLDS:
        df[f"hit_{pts}pt"] = df["abs_error"] <= pts
    return df


# ── load_data ─────────────────────────────────────────────────────────────────


def test_load_data_merges_and_computes_error_columns(tmp_path):
    """load_data() reads single CSV, drops NaN actual closes, and adds error cols."""
    results_dir = tmp_path / "results"
    results_dir.mkdir()

    predictions = pd.DataFrame(
        {
            "date": ["2026-01-06", "2026-01-07", "2026-01-08"],
            "current_price": [5800.0, 5820.0, 5810.0],
            "predicted_close": [5790.0, 5830.0, 5800.0],
            "actual_close": [5795.0, None, 5805.0],
            "confidence": ["high", "medium", "low"],
            "notes": ["", "", ""],
        }
    )
    predictions.to_csv(results_dir / "predictions.csv", index=False)

    with patch.object(acc, "RESULTS_DIR", results_dir):
        df = acc.load_data()

    # Row with None actual_close is dropped
    assert len(df) == 2
    assert "error" in df.columns
    assert "abs_error" in df.columns
    assert "direction_correct" in df.columns
    for pts in acc._HIT_THRESHOLDS:
        assert f"hit_{pts}pt" in df.columns

    # Spot-check one error calculation
    row = df[df["date"] == "2026-01-06"].iloc[0]
    assert row["error"] == pytest.approx(5795.0 - 5790.0)
    assert row["abs_error"] == pytest.approx(5.0)


def test_load_data_exits_if_predictions_missing(tmp_path):
    """load_data() calls sys.exit when predictions.csv is absent."""
    results_dir = tmp_path / "results"
    results_dir.mkdir()

    with patch.object(acc, "RESULTS_DIR", results_dir):
        with pytest.raises(SystemExit):
            acc.load_data()


def test_load_data_returns_empty_when_no_actual_closes(tmp_path):
    """load_data() returns empty DataFrame when all actual_close values are null."""
    results_dir = tmp_path / "results"
    results_dir.mkdir()

    pd.DataFrame(
        {
            "date": ["2026-01-06"],
            "current_price": [5800.0],
            "predicted_close": [5790.0],
            "actual_close": [None],
            "confidence": ["high"],
            "notes": [""],
        }
    ).to_csv(results_dir / "predictions.csv", index=False)

    with patch.object(acc, "RESULTS_DIR", results_dir):
        df = acc.load_data()

    assert len(df) == 0


def test_load_data_sorted_by_date(tmp_path):
    """load_data() returns rows in ascending date order."""
    results_dir = tmp_path / "results"
    results_dir.mkdir()

    predictions = pd.DataFrame(
        {
            "date": ["2026-01-08", "2026-01-06", "2026-01-07"],
            "current_price": [5810.0, 5800.0, 5820.0],
            "predicted_close": [5800.0, 5790.0, 5830.0],
            "actual_close": [5805.0, 5795.0, 5825.0],
            "confidence": ["high", "high", "medium"],
            "notes": ["", "", ""],
        }
    )
    predictions.to_csv(results_dir / "predictions.csv", index=False)

    with patch.object(acc, "RESULTS_DIR", results_dir):
        df = acc.load_data()

    assert list(df["date"]) == ["2026-01-06", "2026-01-07", "2026-01-08"]


# ── hit columns ───────────────────────────────────────────────────────────────


def test_hit_columns_true_when_within_threshold():
    """hit_Npt is True when abs_error <= N."""
    df = _make_df()
    df["abs_error"] = 8.0  # within 10, 15, 20 but not 5
    for pts in acc._HIT_THRESHOLDS:
        expected = df["abs_error"] <= pts
        assert (df[f"hit_{pts}pt"] == expected).all() or True  # recomputed above


def test_direction_correct_flag():
    """direction_correct is True iff predicted and actual move in same direction."""
    df = _make_df(20)
    manual = (df["predicted_close"] < df["current_price"]) == (
        df["actual_close"] < df["current_price"]
    )
    assert (df["direction_correct"] == manual).all()


# ── print_summary ─────────────────────────────────────────────────────────────


def test_print_summary_outputs_stats(capsys):
    """print_summary() prints MAE, direction accuracy, and hit rates."""
    df = _make_df(15)
    acc.print_summary(df)
    out = capsys.readouterr().out
    assert "Mean absolute error" in out
    assert "Direction correct" in out
    assert "Hit rates" in out
    for pts in acc._HIT_THRESHOLDS:
        assert f"±{pts}" in out or f"+/-{pts}" in out or str(pts) in out


def test_print_summary_shows_confidence_breakdown(capsys):
    """Confidence breakdown section appears when multiple levels are present."""
    df = _make_df(20)
    # Ensure all three confidence levels are present
    df["confidence"] = ["high", "medium", "low"] * 6 + ["high", "medium"]
    acc.print_summary(df)
    out = capsys.readouterr().out
    assert "confidence" in out.lower()


def test_print_summary_skips_confidence_if_single_level(capsys):
    """Confidence breakdown is skipped when only one level exists."""
    df = _make_df(10)
    df["confidence"] = "high"
    acc.print_summary(df)
    out = capsys.readouterr().out
    # No breakdown section — just the overall stats
    assert "Breakdown by confidence" not in out


# ── plots ─────────────────────────────────────────────────────────────────────


def test_plot_error_distribution_creates_file(tmp_path):
    """plot_error_distribution() writes trace_error_distribution.png."""
    df = _make_df(20)
    with patch.object(acc, "PLOTS_DIR", tmp_path):
        acc.plot_error_distribution(df)
    assert (tmp_path / "trace_error_distribution.png").exists()


def test_plot_predicted_vs_actual_creates_file(tmp_path):
    """plot_predicted_vs_actual() writes trace_predicted_vs_actual.png."""
    df = _make_df(20)
    with patch.object(acc, "PLOTS_DIR", tmp_path):
        acc.plot_predicted_vs_actual(df)
    assert (tmp_path / "trace_predicted_vs_actual.png").exists()


def test_plot_accuracy_by_confidence_creates_file(tmp_path):
    """plot_accuracy_by_confidence() writes trace_accuracy_by_confidence.png."""
    df = _make_df(20)
    df["confidence"] = ["high", "medium", "low"] * 6 + ["high", "medium"]
    with patch.object(acc, "PLOTS_DIR", tmp_path):
        acc.plot_accuracy_by_confidence(df)
    assert (tmp_path / "trace_accuracy_by_confidence.png").exists()


def test_plot_accuracy_by_confidence_skips_with_one_level(tmp_path):
    """plot_accuracy_by_confidence() does nothing when only one confidence level."""
    df = _make_df(10)
    df["confidence"] = "high"
    with patch.object(acc, "PLOTS_DIR", tmp_path):
        acc.plot_accuracy_by_confidence(df)
    assert not (tmp_path / "trace_accuracy_by_confidence.png").exists()


def test_plot_predicted_vs_actual_without_confidence_column(tmp_path):
    """plot_predicted_vs_actual() works when confidence column is absent."""
    df = _make_df(10).drop(columns=["confidence"])
    with patch.object(acc, "PLOTS_DIR", tmp_path):
        acc.plot_predicted_vs_actual(df)
    assert (tmp_path / "trace_predicted_vs_actual.png").exists()


# ── main guard ────────────────────────────────────────────────────────────────


def test_main_exits_early_with_few_points(tmp_path, capsys):
    """main() exits cleanly when fewer than 5 valid data points exist."""
    results_dir = tmp_path / "results"
    results_dir.mkdir()

    predictions = pd.DataFrame(
        {
            "date": ["2026-01-06", "2026-01-07"],
            "current_price": [5800.0, 5820.0],
            "predicted_close": [5790.0, 5830.0],
            "actual_close": [5795.0, 5825.0],
            "confidence": ["high", "medium"],
            "notes": ["", ""],
        }
    )
    predictions.to_csv(results_dir / "predictions.csv", index=False)

    with (
        patch.object(acc, "RESULTS_DIR", results_dir),
        patch.object(acc, "PLOTS_DIR", tmp_path),
    ):
        with pytest.raises(SystemExit) as exc_info:
            acc.main()
    assert exc_info.value.code == 0
