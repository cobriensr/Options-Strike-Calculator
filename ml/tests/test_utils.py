"""
Unit tests for ML utility functions: load_env, get_connection, load_data,
and feature group constants.

Run:
    cd ml && .venv/bin/python -m pytest test_utils.py -v

Note: validate_dataframe, section, subsection, verdict, and takeaway are
already covered in test_ml.py — those are NOT duplicated here.
"""

from unittest.mock import MagicMock, patch

import pandas as pd
import psycopg2
import pytest

from utils import (
    load_env,
    get_connection,
    load_data,
    VOLATILITY_FEATURES,
    GEX_FEATURES_T1T2,
    GREEK_FEATURES_CORE,
)


# ── Feature group constant tests ──────────────────────────────


class TestFeatureGroupConstants:
    """Verify feature group constants are well-formed lists of strings."""

    def test_volatility_features_is_list_of_strings(self):
        """VOLATILITY_FEATURES should be a non-empty list of strings."""
        assert isinstance(VOLATILITY_FEATURES, list)
        assert len(VOLATILITY_FEATURES) > 0
        for feat in VOLATILITY_FEATURES:
            assert isinstance(feat, str), f"Expected str, got {type(feat)}: {feat}"

    def test_gex_features_t1t2_is_list_of_strings(self):
        """GEX_FEATURES_T1T2 should be a non-empty list of strings."""
        assert isinstance(GEX_FEATURES_T1T2, list)
        assert len(GEX_FEATURES_T1T2) > 0
        for feat in GEX_FEATURES_T1T2:
            assert isinstance(feat, str), f"Expected str, got {type(feat)}: {feat}"

    def test_greek_features_core_is_list_of_strings(self):
        """GREEK_FEATURES_CORE should be a non-empty list of strings."""
        assert isinstance(GREEK_FEATURES_CORE, list)
        assert len(GREEK_FEATURES_CORE) > 0
        for feat in GREEK_FEATURES_CORE:
            assert isinstance(feat, str), f"Expected str, got {type(feat)}: {feat}"

    def test_volatility_features_expected_members(self):
        """VOLATILITY_FEATURES should contain known VIX-related columns."""
        assert "vix" in VOLATILITY_FEATURES
        assert "vix1d" in VOLATILITY_FEATURES

    def test_gex_features_t1t2_expected_members(self):
        """GEX_FEATURES_T1T2 should contain both t1 and t2 variants."""
        t1_cols = [f for f in GEX_FEATURES_T1T2 if f.endswith("_t1")]
        t2_cols = [f for f in GEX_FEATURES_T1T2 if f.endswith("_t2")]
        assert len(t1_cols) > 0, "Should have at least one t1 feature"
        assert len(t2_cols) > 0, "Should have at least one t2 feature"

    def test_greek_features_core_expected_members(self):
        """GREEK_FEATURES_CORE should contain gamma and charm columns."""
        assert "agg_net_gamma" in GREEK_FEATURES_CORE
        assert "charm_slope" in GREEK_FEATURES_CORE

    def test_no_duplicate_features(self):
        """No feature group should contain duplicate entries."""
        for name, group in [
            ("VOLATILITY_FEATURES", VOLATILITY_FEATURES),
            ("GEX_FEATURES_T1T2", GEX_FEATURES_T1T2),
            ("GREEK_FEATURES_CORE", GREEK_FEATURES_CORE),
        ]:
            assert len(group) == len(set(group)), f"Duplicates found in {name}"

    def test_no_empty_string_features(self):
        """No feature group should contain empty strings."""
        all_features = VOLATILITY_FEATURES + GEX_FEATURES_T1T2 + GREEK_FEATURES_CORE
        for feat in all_features:
            assert feat.strip() != "", f"Empty string found in feature groups"


# ── load_env tests ─────────────────────────────────────────────


class TestLoadEnv:
    """Tests for the load_env() function that reads .env files."""

    def test_parses_simple_key_value(self, tmp_path):
        """Should parse simple KEY=VALUE lines."""
        env_file = tmp_path / ".env"
        env_file.write_text("DATABASE_URL=postgres://localhost/test\nAPI_KEY=abc123\n")

        with patch("utils.ML_ROOT", tmp_path / "ml"):
            result = load_env()

        assert result["DATABASE_URL"] == "postgres://localhost/test"
        assert result["API_KEY"] == "abc123"

    def test_skips_comments(self, tmp_path):
        """Should skip lines starting with #."""
        env_file = tmp_path / ".env"
        env_file.write_text("# This is a comment\nFOO=bar\n# Another comment\nBAZ=qux\n")

        with patch("utils.ML_ROOT", tmp_path / "ml"):
            result = load_env()

        assert "#" not in str(result.keys())
        assert "FOO" in result
        assert result["FOO"] == "bar"
        assert "BAZ" in result
        assert result["BAZ"] == "qux"

    def test_skips_blank_lines(self, tmp_path):
        """Should skip empty and whitespace-only lines."""
        env_file = tmp_path / ".env"
        env_file.write_text("FOO=bar\n\n   \n\nBAZ=qux\n")

        with patch("utils.ML_ROOT", tmp_path / "ml"), \
             patch.dict("os.environ", {}, clear=True):
            result = load_env()

        assert len(result) == 2
        assert result["FOO"] == "bar"
        assert result["BAZ"] == "qux"

    def test_strips_double_quotes(self, tmp_path):
        """Should strip surrounding double quotes from values."""
        env_file = tmp_path / ".env"
        env_file.write_text('MY_VAR="hello world"\n')

        with patch("utils.ML_ROOT", tmp_path / "ml"):
            result = load_env()

        assert result["MY_VAR"] == "hello world"

    def test_strips_single_quotes(self, tmp_path):
        """Should strip surrounding single quotes from values."""
        env_file = tmp_path / ".env"
        env_file.write_text("MY_VAR='hello world'\n")

        with patch("utils.ML_ROOT", tmp_path / "ml"):
            result = load_env()

        assert result["MY_VAR"] == "hello world"

    def test_handles_value_with_equals_sign(self, tmp_path):
        """Should handle values containing = signs (partition splits on first =)."""
        env_file = tmp_path / ".env"
        env_file.write_text("DATABASE_URL=postgres://user:pass@host/db?sslmode=require\n")

        with patch("utils.ML_ROOT", tmp_path / "ml"):
            result = load_env()

        assert result["DATABASE_URL"] == "postgres://user:pass@host/db?sslmode=require"

    def test_missing_env_file_returns_os_environ(self, tmp_path):
        """Should return os.environ when .env file does not exist."""
        missing_file = tmp_path / ".env"
        assert not missing_file.exists()

        with patch("utils.ML_ROOT", tmp_path / "ml"), \
             patch.dict("os.environ", {"FROM_ENV": "yes"}, clear=True):
            result = load_env()

        assert result == {"FROM_ENV": "yes"}

    def test_empty_env_file_returns_os_environ(self, tmp_path):
        """Should return os.environ when .env file is empty."""
        env_file = tmp_path / ".env"
        env_file.write_text("")

        with patch("utils.ML_ROOT", tmp_path / "ml"), \
             patch.dict("os.environ", {}, clear=True):
            result = load_env()

        assert result == {}

    def test_strips_whitespace_around_key_and_value(self, tmp_path):
        """Should strip whitespace from both key and value."""
        env_file = tmp_path / ".env"
        env_file.write_text("  MY_KEY  =  my_value  \n")

        with patch("utils.ML_ROOT", tmp_path / "ml"):
            result = load_env()

        assert "MY_KEY" in result
        assert result["MY_KEY"] == "my_value"

    def test_key_with_no_value(self, tmp_path):
        """Should handle KEY= with no value (empty string)."""
        env_file = tmp_path / ".env"
        env_file.write_text("EMPTY_VAR=\n")

        with patch("utils.ML_ROOT", tmp_path / "ml"):
            result = load_env()

        assert "EMPTY_VAR" in result
        assert result["EMPTY_VAR"] == ""

    def test_multiple_env_vars_mixed_format(self, tmp_path):
        """Should handle a realistic .env with mixed formatting."""
        env_file = tmp_path / ".env"
        env_file.write_text(
            "# Database config\n"
            "DATABASE_URL=postgres://localhost/mydb\n"
            "\n"
            "# API keys\n"
            'ANTHROPIC_API_KEY="sk-ant-abc123"\n'
            "CRON_SECRET='my-secret'\n"
            "  SPACED_KEY = spaced_value \n"
        )

        with patch("utils.ML_ROOT", tmp_path / "ml"), \
             patch.dict("os.environ", {}, clear=True):
            result = load_env()

        assert len(result) == 4
        assert result["DATABASE_URL"] == "postgres://localhost/mydb"
        assert result["ANTHROPIC_API_KEY"] == "sk-ant-abc123"
        assert result["CRON_SECRET"] == "my-secret"
        assert result["SPACED_KEY"] == "spaced_value"


# ── get_connection tests ───────────────────────────────────────


class TestGetConnection:
    """Tests for the get_connection() function."""

    @patch("utils.psycopg2.connect")
    @patch("utils.load_env")
    def test_returns_connection_on_success(self, mock_load_env, mock_connect):
        """Should return a psycopg2 connection when DATABASE_URL is set."""
        mock_load_env.return_value = {"DATABASE_URL": "postgres://localhost/test"}
        mock_conn = MagicMock()
        mock_connect.return_value = mock_conn

        conn = get_connection()

        assert conn is mock_conn
        mock_connect.assert_called_once_with(
            "postgres://localhost/test",
            sslmode="require",
            connect_timeout=10,
        )

    @patch("utils.load_env")
    def test_exits_when_database_url_missing(self, mock_load_env, capsys):
        """Should sys.exit(1) when DATABASE_URL is not in .env."""
        mock_load_env.return_value = {}

        with pytest.raises(SystemExit) as exc_info:
            get_connection()

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "DATABASE_URL" in captured.out

    @patch("utils.load_env")
    def test_exits_when_database_url_empty(self, mock_load_env, capsys):
        """Should sys.exit(1) when DATABASE_URL is an empty string."""
        mock_load_env.return_value = {"DATABASE_URL": ""}

        with pytest.raises(SystemExit) as exc_info:
            get_connection()

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "DATABASE_URL" in captured.out

    @patch("utils.psycopg2.connect")
    @patch("utils.load_env")
    def test_exits_on_connection_failure(self, mock_load_env, mock_connect, capsys):
        """Should sys.exit(1) when psycopg2 raises OperationalError."""
        mock_load_env.return_value = {"DATABASE_URL": "postgres://bad-host/db"}
        mock_connect.side_effect = psycopg2.OperationalError("connection refused")

        with pytest.raises(SystemExit) as exc_info:
            get_connection()

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "Could not connect" in captured.out
        assert "connection refused" in captured.out

    @patch("utils.psycopg2.connect")
    @patch("utils.load_env")
    def test_prints_troubleshooting_hint_on_failure(
        self, mock_load_env, mock_connect, capsys
    ):
        """Should print a troubleshooting hint when connection fails."""
        mock_load_env.return_value = {"DATABASE_URL": "postgres://bad-host/db"}
        mock_connect.side_effect = psycopg2.OperationalError("timeout")

        with pytest.raises(SystemExit):
            get_connection()

        captured = capsys.readouterr()
        assert "Check DATABASE_URL" in captured.out


# ── load_data tests ────────────────────────────────────────────


class TestLoadData:
    """Tests for the load_data() function."""

    @patch("utils.create_engine")
    @patch("utils.load_env")
    def test_returns_dataframe_indexed_by_date(self, mock_load_env, mock_engine):
        """Should return a DataFrame with date as the index, sorted."""
        mock_load_env.return_value = {"DATABASE_URL": "postgres://localhost/test"}
        mock_eng = MagicMock()
        mock_engine.return_value = mock_eng

        # Build a test DataFrame that read_sql_query would return
        dates = pd.to_datetime(["2026-01-03", "2026-01-01", "2026-01-02"])
        test_df = pd.DataFrame({"date": dates, "vix": [15.0, 12.0, 13.5]})

        with patch("utils.pd.read_sql_query", return_value=test_df):
            result = load_data("SELECT * FROM features")

        assert result.index.name == "date"
        # Should be sorted ascending
        assert list(result.index) == sorted(result.index)
        assert "vix" in result.columns
        mock_eng.dispose.assert_called_once()

    @patch("utils.load_env")
    def test_exits_when_database_url_missing(self, mock_load_env, capsys):
        """Should sys.exit(1) when DATABASE_URL is not set."""
        mock_load_env.return_value = {}

        with pytest.raises(SystemExit) as exc_info:
            load_data("SELECT 1")

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "DATABASE_URL" in captured.out

    @patch("utils.load_env")
    def test_exits_when_database_url_empty(self, mock_load_env, capsys):
        """Should sys.exit(1) when DATABASE_URL is empty."""
        mock_load_env.return_value = {"DATABASE_URL": ""}

        with pytest.raises(SystemExit) as exc_info:
            load_data("SELECT 1")

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "DATABASE_URL" in captured.out

    @patch("utils.create_engine")
    @patch("utils.load_env")
    def test_exits_on_query_failure(self, mock_load_env, mock_engine, capsys):
        """Should sys.exit(1) when the SQL query fails."""
        mock_load_env.return_value = {"DATABASE_URL": "postgres://localhost/test"}
        mock_eng = MagicMock()
        mock_engine.return_value = mock_eng

        with patch(
            "utils.pd.read_sql_query",
            side_effect=Exception("relation does not exist"),
        ):
            with pytest.raises(SystemExit) as exc_info:
                load_data("SELECT * FROM nonexistent_table")

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "Query failed" in captured.out
        assert "relation does not exist" in captured.out
        # Engine should still be disposed in the finally block
        mock_eng.dispose.assert_called_once()

    @patch("utils.create_engine")
    @patch("utils.load_env")
    def test_disposes_engine_on_success(self, mock_load_env, mock_engine):
        """Should call engine.dispose() after successful query."""
        mock_load_env.return_value = {"DATABASE_URL": "postgres://localhost/test"}
        mock_eng = MagicMock()
        mock_engine.return_value = mock_eng

        dates = pd.to_datetime(["2026-01-01"])
        test_df = pd.DataFrame({"date": dates, "vix": [15.0]})

        with patch("utils.pd.read_sql_query", return_value=test_df):
            load_data("SELECT * FROM features")

        mock_eng.dispose.assert_called_once()

    @patch("utils.create_engine")
    @patch("utils.load_env")
    def test_passes_query_to_read_sql(self, mock_load_env, mock_engine):
        """Should pass the exact query string to pd.read_sql_query."""
        mock_load_env.return_value = {"DATABASE_URL": "postgres://localhost/test"}
        mock_eng = MagicMock()
        mock_engine.return_value = mock_eng

        dates = pd.to_datetime(["2026-01-01"])
        test_df = pd.DataFrame({"date": dates, "val": [1.0]})
        query = "SELECT date, val FROM my_table WHERE id > 10"

        with patch("utils.pd.read_sql_query", return_value=test_df) as mock_read:
            load_data(query)

        mock_read.assert_called_once_with(query, mock_eng, parse_dates=["date"])

    @patch("utils.create_engine")
    @patch("utils.load_env")
    def test_creates_engine_with_database_url(self, mock_load_env, mock_engine):
        """Should pass DATABASE_URL to create_engine."""
        url = "postgres://user:pass@host:5432/mydb"
        mock_load_env.return_value = {"DATABASE_URL": url}
        mock_eng = MagicMock()
        mock_engine.return_value = mock_eng

        dates = pd.to_datetime(["2026-01-01"])
        test_df = pd.DataFrame({"date": dates, "val": [1.0]})

        with patch("utils.pd.read_sql_query", return_value=test_df):
            load_data("SELECT 1")

        mock_engine.assert_called_once_with(url)

    @patch("utils.create_engine")
    @patch("utils.load_env")
    def test_result_excludes_date_from_columns(self, mock_load_env, mock_engine):
        """After set_index('date'), date should be the index, not a column."""
        mock_load_env.return_value = {"DATABASE_URL": "postgres://localhost/test"}
        mock_eng = MagicMock()
        mock_engine.return_value = mock_eng

        dates = pd.to_datetime(["2026-01-01", "2026-01-02"])
        test_df = pd.DataFrame({"date": dates, "vix": [15.0, 16.0], "spy": [500, 501]})

        with patch("utils.pd.read_sql_query", return_value=test_df):
            result = load_data("SELECT * FROM features")

        assert "date" not in result.columns
        assert "vix" in result.columns
        assert "spy" in result.columns
        assert len(result) == 2
