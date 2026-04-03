"""
Unit tests for ml/visualize.py — smoke tests for all plot functions.

Each test calls a plot function with valid synthetic data, verifies no
exception is raised, and checks that the expected .png file was created.
PLOT_DIR is monkeypatched to a tmp_path so the real plots/ dir is untouched.

Run:
    cd ml && .venv/bin/python -m pytest test_visualize.py -v
"""

from pathlib import Path
from unittest.mock import patch

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest


# ── Helpers ───────────────────────────────────────────────────


def _make_viz_df(n: int = 20) -> pd.DataFrame:
    """Build a DataFrame with all columns the visualize.py plot functions need."""
    dates = pd.date_range("2026-03-01", periods=n, freq="B")
    rng = np.random.default_rng(42)

    structures = ["PUT CREDIT SPREAD", "CALL CREDIT SPREAD", "IRON CONDOR"]
    charm_patterns = [
        "all_negative", "all_positive", "mixed",
        "pcs_confirming", "ccs_confirming",
    ]
    range_cats = ["NARROW", "NORMAL", "WIDE", "EXTREME"]
    confidences = ["HIGH", "MODERATE", "LOW"]
    settlement_dirs = ["UP", "DOWN"]

    return pd.DataFrame(
        {
            # Volatility features
            "vix": rng.uniform(14, 28, n),
            "vix1d": rng.uniform(12, 30, n),
            "vix1d_vix_ratio": rng.uniform(0.8, 1.2, n),

            # GEX features
            "gex_oi_t1": rng.uniform(-50e9, 50e9, n),
            "gex_dir_t1": rng.uniform(-1, 1, n),
            "gex_vol_t1": rng.uniform(0, 1e9, n),

            # Greek features
            "agg_net_gamma": rng.uniform(-1e6, 1e6, n),
            "charm_slope": rng.uniform(-0.5, 0.5, n),
            "dte0_charm_pct": rng.uniform(-0.1, 0.1, n),

            # Flow features
            "flow_agreement_t1": rng.integers(0, 9, n).astype(float),
            "mt_ncp_t1": rng.uniform(-5e6, 5e6, n),
            "spx_ncp_t1": rng.uniform(-5e6, 5e6, n),
            "spy_ncp_t1": rng.uniform(-5e6, 5e6, n),
            "qqq_ncp_t1": rng.uniform(-5e6, 5e6, n),
            "spy_etf_ncp_t1": rng.uniform(-5e6, 5e6, n),
            "qqq_etf_ncp_t1": rng.uniform(-5e6, 5e6, n),
            "zero_dte_ncp_t1": rng.uniform(-5e6, 5e6, n),

            # Outcome columns
            "day_range_pts": rng.uniform(15, 80, n),
            "day_range_pct": rng.uniform(0.3, 1.5, n),
            "settlement": rng.uniform(5700, 5750, n),
            "day_open": rng.uniform(5700, 5750, n),
            "day_high": rng.uniform(5740, 5780, n),
            "day_low": rng.uniform(5670, 5710, n),
            "close_vs_open": rng.uniform(-30, 30, n),

            # Label columns
            "recommended_structure": rng.choice(structures, n),
            "structure_correct": rng.choice([True, False], n),
            "label_confidence": rng.choice(confidences, n),
            "charm_pattern": rng.choice(charm_patterns, n),
            "range_category": rng.choice(range_cats, n),
            "settlement_direction": rng.choice(settlement_dirs, n),

            # Day of week
            "day_of_week": [d.isoweekday() for d in dates],
        },
        index=dates,
    )


@pytest.fixture(autouse=True)
def _redirect_plot_dir(tmp_path, monkeypatch):
    """Redirect PLOT_DIR to a temporary directory for every test."""
    import visualize
    monkeypatch.setattr(visualize, "PLOT_DIR", tmp_path)


@pytest.fixture(autouse=True)
def _close_figures():
    """Close all matplotlib figures after each test to prevent memory leaks."""
    yield
    plt.close("all")


# ── Plot smoke tests ─────────────────────────────────────────


class TestPlotCorrelationHeatmap:
    """Smoke tests for plot_correlation_heatmap."""

    def test_creates_png(self, tmp_path):
        """Should create correlations.png without error."""
        from visualize import plot_correlation_heatmap

        df = _make_viz_df(20)
        plot_correlation_heatmap(df)

        assert (tmp_path / "correlations.png").exists()

    def test_skips_with_few_rows(self, tmp_path):
        """Should silently skip when fewer than 5 valid rows."""
        from visualize import plot_correlation_heatmap

        df = _make_viz_df(3)
        plot_correlation_heatmap(df)

        # File should NOT be created since we have < 5 rows
        assert not (tmp_path / "correlations.png").exists()


class TestPlotRangeByRegime:
    """Smoke tests for plot_range_by_regime."""

    def test_creates_png(self, tmp_path):
        """Should create range_by_regime.png without error."""
        from visualize import plot_range_by_regime

        df = _make_viz_df(20)
        plot_range_by_regime(df)

        assert (tmp_path / "range_by_regime.png").exists()


class TestPlotFlowReliability:
    """Smoke tests for plot_flow_reliability."""

    def test_creates_png(self, tmp_path):
        """Should create flow_reliability.png without error."""
        from visualize import plot_flow_reliability

        df = _make_viz_df(20)
        plot_flow_reliability(df)

        assert (tmp_path / "flow_reliability.png").exists()

    def test_skips_without_settlement_direction(self, tmp_path):
        """Should silently skip when settlement_direction is all NaN."""
        from visualize import plot_flow_reliability

        df = _make_viz_df(20)
        df["settlement_direction"] = np.nan
        plot_flow_reliability(df)

        assert not (tmp_path / "flow_reliability.png").exists()


class TestPlotGexVsRange:
    """Smoke tests for plot_gex_vs_range."""

    def test_creates_png(self, tmp_path):
        """Should create gex_vs_range.png without error."""
        from visualize import plot_gex_vs_range

        df = _make_viz_df(20)
        plot_gex_vs_range(df)

        assert (tmp_path / "gex_vs_range.png").exists()

    def test_raises_on_missing_columns(self, tmp_path):
        """Should raise KeyError when a required column is missing."""
        from visualize import plot_gex_vs_range

        df = _make_viz_df(20)
        df = df.drop(columns=["charm_pattern"])

        with pytest.raises(KeyError):
            plot_gex_vs_range(df)


class TestPlotTimeline:
    """Smoke tests for plot_timeline."""

    def test_creates_png(self, tmp_path):
        """Should create timeline.png without error."""
        from visualize import plot_timeline

        df = _make_viz_df(20)
        plot_timeline(df)

        assert (tmp_path / "timeline.png").exists()


class TestPlotStructureConfidence:
    """Smoke tests for plot_structure_confidence."""

    def test_creates_png(self, tmp_path):
        """Should create structure_confidence.png without error."""
        from visualize import plot_structure_confidence

        df = _make_viz_df(20)
        plot_structure_confidence(df)

        assert (tmp_path / "structure_confidence.png").exists()

    def test_skips_with_no_labels(self, tmp_path):
        """Should silently skip when structure_correct is all NaN."""
        from visualize import plot_structure_confidence

        df = _make_viz_df(20)
        df["structure_correct"] = np.nan
        plot_structure_confidence(df)

        assert not (tmp_path / "structure_confidence.png").exists()


class TestPlotDayOfWeek:
    """Smoke tests for plot_day_of_week."""

    def test_creates_png(self, tmp_path):
        """Should create day_of_week.png without error."""
        from visualize import plot_day_of_week

        df = _make_viz_df(20)
        plot_day_of_week(df)

        assert (tmp_path / "day_of_week.png").exists()


class TestPlotStationarity:
    """Smoke tests for plot_stationarity."""

    def test_creates_png(self, tmp_path):
        """Should create stationarity.png without error."""
        from visualize import plot_stationarity

        df = _make_viz_df(20)
        plot_stationarity(df)

        assert (tmp_path / "stationarity.png").exists()

    def test_skips_with_too_few_rows(self, tmp_path):
        """Should silently skip when window calculation yields < 3."""
        from visualize import plot_stationarity

        df = _make_viz_df(5)
        plot_stationarity(df)

        # window = min(10, 5 // 3) = 1, which is < 3, so it returns early
        assert not (tmp_path / "stationarity.png").exists()
