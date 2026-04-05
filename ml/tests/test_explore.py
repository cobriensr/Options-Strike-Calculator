"""
Unit tests for ml/explore.py — print_summary and fetch_data.

Run:
    cd ml && .venv/bin/python -m pytest test_explore.py -v
"""

from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest

# ── Helpers ───────────────────────────────────────────────────


def _make_explore_df(n: int = 10) -> pd.DataFrame:
    """Build a DataFrame that mirrors the shape explore.py expects."""
    dates = pd.date_range("2026-03-01", periods=n, freq="B")
    rng = np.random.default_rng(42)

    return pd.DataFrame(
        {
            "feature_completeness": rng.uniform(0.7, 1.0, n),
            "settlement": rng.choice([5700.0, 5720.0, 5750.0, np.nan], n),
            "day_range_pts": rng.uniform(15, 80, n),
            "vix": rng.uniform(14, 28, n),
            "vix1d": rng.uniform(12, 30, n),
            "vix1d_vix_ratio": rng.uniform(0.8, 1.2, n),
            "gex_oi_t1": rng.uniform(-50e9, 50e9, n),
            "gex_oi_t4": rng.uniform(-40e9, 40e9, n),
            "flow_agreement_t1": rng.integers(0, 9, n).astype(float),
            "flow_agreement_t4": rng.integers(0, 9, n).astype(float),
            "gamma_asymmetry": rng.uniform(-1, 1, n),
            "charm_slope": rng.uniform(-0.5, 0.5, n),
        },
        index=dates,
    )


# ── print_summary tests ──────────────────────────────────────


class TestPrintSummary:
    """Tests for the print_summary function."""

    def test_print_summary_basic(self, capsys):
        """Should print date range, day count, and 'ML Training Data' header."""
        from explore import print_summary

        df = _make_explore_df(10)
        print_summary(df)

        captured = capsys.readouterr().out
        assert "ML Training Data" in captured
        assert "10 days" in captured
        assert "2026-03-" in captured  # date range includes March dates
        assert "Feature completeness" in captured
        assert "Key Features" in captured

    def test_print_summary_with_labels(self, capsys):
        """Should print label counts when structure_correct and charm_diverged exist."""
        from explore import print_summary

        df = _make_explore_df(10)
        rng = np.random.default_rng(99)

        # Add label columns
        df["structure_correct"] = rng.choice([True, False, None], 10)
        df["charm_diverged"] = rng.choice([True, False, None], 10)
        df["recommended_structure"] = rng.choice(
            ["PUT CREDIT SPREAD", "CALL CREDIT SPREAD", "IRON CONDOR"], 10
        )
        df["charm_pattern"] = rng.choice(["all_negative", "all_positive", "mixed"], 10)
        df["range_category"] = rng.choice(["NARROW", "NORMAL", "WIDE", "EXTREME"], 10)

        print_summary(df)

        captured = capsys.readouterr().out
        assert "Labels:" in captured
        assert "Charm divergence labels:" in captured
        assert "Structure Distribution" in captured
        assert "Charm Pattern Distribution" in captured
        assert "Range Category Distribution" in captured

    def test_print_summary_with_outcomes_and_correlations(self, capsys):
        """Should print outcome counts and correlation section when settlement is present."""
        from explore import print_summary

        df = _make_explore_df(10)
        # Ensure all settlements are non-null so we get the correlation section
        df["settlement"] = np.linspace(5700, 5750, 10)

        print_summary(df)

        captured = capsys.readouterr().out
        assert "Outcomes:" in captured
        assert "10/10" in captured
        assert "Correlations with Day Range" in captured

    def test_print_summary_empty_features_section(self, capsys):
        """Should not crash if numeric feature columns are absent."""
        from explore import print_summary

        dates = pd.date_range("2026-03-01", periods=5, freq="B")
        df = pd.DataFrame(
            {"feature_completeness": [0.9] * 5},
            index=dates,
        )

        print_summary(df)

        captured = capsys.readouterr().out
        assert "ML Training Data" in captured
        assert "5 days" in captured


# ── fetch_data tests ──────────────────────────────────────────


class TestFetchData:
    """Tests for the fetch_data function."""

    @patch("explore.psycopg2.connect")
    def test_fetch_data_mocked(self, mock_connect):
        """Should call psycopg2.connect and pd.read_sql_query with the right params."""
        from explore import fetch_data

        # Build a mock DataFrame that read_sql_query would return
        dates = pd.to_datetime(["2026-03-03", "2026-03-04"])
        mock_df = pd.DataFrame(
            {
                "date": dates,
                "feature_completeness": [0.9, 0.85],
                "vix": [18.5, 19.2],
            }
        )

        mock_conn = MagicMock()
        mock_connect.return_value = mock_conn

        with patch("explore.pd.read_sql_query", return_value=mock_df) as mock_read:
            result = fetch_data(
                "postgres://localhost/test",
                after="2026-03-01",
                before="2026-03-31",
                min_feature=0.5,
                min_label=0.0,
            )

        mock_connect.assert_called_once_with(
            "postgres://localhost/test", sslmode="require"
        )
        mock_read.assert_called_once()

        # Verify the connection was closed
        mock_conn.close.assert_called_once()

        # Verify the result is indexed by date and sorted
        assert result.index.name == "date"
        assert list(result.index) == sorted(result.index)
        assert "vix" in result.columns

    @patch("explore.psycopg2.connect")
    def test_fetch_data_empty_returns_empty(self, mock_connect, capsys):
        """Should print 'No data returned.' and return empty DataFrame."""
        from explore import fetch_data

        mock_conn = MagicMock()
        mock_connect.return_value = mock_conn

        empty_df = pd.DataFrame()
        with patch("explore.pd.read_sql_query", return_value=empty_df):
            result = fetch_data("postgres://localhost/test")

        assert result.empty
        captured = capsys.readouterr().out
        assert "No data returned" in captured
        mock_conn.close.assert_called_once()

    @patch("explore.psycopg2.connect")
    def test_fetch_data_passes_params(self, mock_connect):
        """Should forward after, before, min_feature, min_label as query params."""
        from explore import fetch_data

        dates = pd.to_datetime(["2026-03-10"])
        mock_df = pd.DataFrame({"date": dates, "feature_completeness": [1.0]})
        mock_conn = MagicMock()
        mock_connect.return_value = mock_conn

        with patch("explore.pd.read_sql_query", return_value=mock_df) as mock_read:
            fetch_data(
                "postgres://localhost/test",
                after="2026-03-01",
                before="2026-03-31",
                min_feature=0.8,
                min_label=0.3,
            )

        # Verify params dict was passed
        call_kwargs = mock_read.call_args
        params = call_kwargs.kwargs.get("params") or call_kwargs[1].get("params")
        assert params["after"] == "2026-03-01"
        assert params["before"] == "2026-03-31"
        assert params["min_feature"] == pytest.approx(0.8)
        assert params["min_label"] == pytest.approx(0.3)

    @patch("explore.psycopg2.connect")
    def test_fetch_data_closes_conn_on_error(self, mock_connect):
        """Should close the connection even if read_sql_query raises."""
        from explore import fetch_data

        mock_conn = MagicMock()
        mock_connect.return_value = mock_conn

        with patch(
            "explore.pd.read_sql_query",
            side_effect=Exception("query failed"),
        ):
            with pytest.raises(Exception, match="query failed"):
                fetch_data("postgres://localhost/test")

        mock_conn.close.assert_called_once()

    @patch("explore.psycopg2.connect")
    def test_fetch_data_defaults_none_params(self, mock_connect):
        """Should pass None for after/before and 0.0 for min_* by default."""
        from explore import fetch_data

        dates = pd.to_datetime(["2026-03-10"])
        mock_df = pd.DataFrame({"date": dates, "feature_completeness": [1.0]})
        mock_conn = MagicMock()
        mock_connect.return_value = mock_conn

        with patch("explore.pd.read_sql_query", return_value=mock_df) as mock_read:
            fetch_data("postgres://localhost/test")

        call_kwargs = mock_read.call_args
        params = call_kwargs.kwargs.get("params") or call_kwargs[1].get("params")
        assert params["after"] is None
        assert params["before"] is None
        assert params["min_feature"] == pytest.approx(0.0)
        assert params["min_label"] == pytest.approx(0.0)
