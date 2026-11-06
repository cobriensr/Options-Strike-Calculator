"""
Unit tests for ML utility functions: load_env, get_connection, load_data,
and feature group constants.

Run:
    cd ml && .venv/Scripts/python -m pytest test_utils.py -v

Note: validate_dataframe, section, subsection, verdict, and takeaway are
already covered in test_ml.py — those are NOT duplicated here.
"""

import json
import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import psycopg2
import pytest

from conftest import DatabaseAccessBlocked
from utils import (
    _MERGE_SECTION_SQL,
    GEX_FEATURES_T1T2,
    GREEK_FEATURES_CORE,
    VOLATILITY_FEATURES,
    get_connection,
    load_data,
    load_env,
    make_engine,
    save_section_findings,
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
            assert feat.strip() != "", "Empty string found in feature groups"


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
        env_file.write_text(
            "# This is a comment\nFOO=bar\n# Another comment\nBAZ=qux\n"
        )

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

        with (
            patch("utils.ML_ROOT", tmp_path / "ml"),
            patch.dict("os.environ", {}, clear=True),
        ):
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
        env_file.write_text(
            "DATABASE_URL=postgres://user:pass@host/db?sslmode=require\n"
        )

        with patch("utils.ML_ROOT", tmp_path / "ml"):
            result = load_env()

        assert result["DATABASE_URL"] == "postgres://user:pass@host/db?sslmode=require"

    def test_missing_env_file_returns_os_environ(self, tmp_path):
        """Should return os.environ when .env file does not exist."""
        missing_file = tmp_path / ".env"
        assert not missing_file.exists()

        with (
            patch("utils.ML_ROOT", tmp_path / "ml"),
            patch.dict("os.environ", {"FROM_ENV": "yes"}, clear=True),
        ):
            result = load_env()

        assert result == {"FROM_ENV": "yes"}

    def test_empty_env_file_returns_os_environ(self, tmp_path):
        """Should return os.environ when .env file is empty."""
        env_file = tmp_path / ".env"
        env_file.write_text("")

        with (
            patch("utils.ML_ROOT", tmp_path / "ml"),
            patch.dict("os.environ", {}, clear=True),
        ):
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

        with (
            patch("utils.ML_ROOT", tmp_path / "ml"),
            patch.dict("os.environ", {}, clear=True),
        ):
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
        """Should build the engine from DATABASE_URL, on the psycopg2 driver."""
        mock_load_env.return_value = {
            "DATABASE_URL": "postgresql://user:pass@host:5432/mydb"
        }
        mock_eng = MagicMock()
        mock_engine.return_value = mock_eng

        dates = pd.to_datetime(["2026-01-01"])
        test_df = pd.DataFrame({"date": dates, "val": [1.0]})

        with patch("utils.pd.read_sql_query", return_value=test_df):
            load_data("SELECT 1")

        mock_engine.assert_called_once_with(
            "postgresql+psycopg2://user:pass@host:5432/mydb"
        )

    @patch("utils.create_engine")
    @patch("utils.load_env")
    def test_an_engine_that_cannot_be_built_raises_as_itself(
        self, mock_load_env, mock_engine
    ):
        """A missing driver must surface as ModuleNotFoundError, not as the
        UnboundLocalError the `finally: engine.dispose()` used to raise."""
        mock_load_env.return_value = {
            "DATABASE_URL": "postgresql://user:pass@host:5432/mydb"
        }
        mock_engine.side_effect = ModuleNotFoundError("No module named 'psycopg'")

        with pytest.raises(ModuleNotFoundError, match="psycopg"):
            load_data("SELECT 1")

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


# ── make_engine tests ──────────────────────────────────────────


class TestMakeEngine:
    """make_engine pins the psycopg2 driver for a bare postgres(ql):// URL."""

    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            (
                "postgresql://user:pass@host:5432/mydb?sslmode=require",
                "postgresql+psycopg2://user:pass@host:5432/mydb?sslmode=require",
            ),
            # Heroku-style and older DATABASE_URLs: SQLAlchemy 1.4+ no longer
            # loads a dialect named "postgres", so it needs the rewrite too.
            (
                "postgres://user:pass@host:5432/mydb?sslmode=require",
                "postgresql+psycopg2://user:pass@host:5432/mydb?sslmode=require",
            ),
            # Already names its driver: passed through untouched.
            (
                "postgresql+psycopg2://user:pass@host:5432/mydb",
                "postgresql+psycopg2://user:pass@host:5432/mydb",
            ),
        ],
        ids=["postgresql", "postgres", "driver-named"],
    )
    @patch("utils.create_engine")
    def test_a_bare_url_gets_the_psycopg2_driver(self, mock_create, url, expected):
        make_engine(url)
        mock_create.assert_called_once_with(expected)

    @pytest.mark.parametrize(
        "url",
        [
            "postgresql+psycopg2://user:pass@host/db",
            "postgresql+asyncpg://user:pass@host/db",
            "sqlite:///local.db",
        ],
    )
    @patch("utils.create_engine")
    def test_a_url_that_names_a_driver_is_left_alone(self, mock_create, url):
        make_engine(url)
        mock_create.assert_called_once_with(url)

    @pytest.mark.parametrize("scheme", ["postgresql", "postgres"])
    def test_a_bare_url_builds_a_psycopg2_engine_whatever_sqlalchemy_does(self, scheme):
        # SQLAlchemy 2.1 resolves a bare postgresql:// to psycopg 3, which is
        # not installed: create_engine raised ModuleNotFoundError. A bare
        # postgres:// names no dialect at all (NoSuchModuleError). No connect
        # happens here; create_engine is lazy.
        engine = make_engine(f"{scheme}://user:pass@invalid.invalid/db")
        assert engine.dialect.driver == "psycopg2"
        engine.dispose()

    def test_a_connect_through_the_engine_reaches_the_psycopg2_block(
        self, db_block_attempts
    ):
        engine = make_engine("postgresql://user:pass@invalid.invalid/db")
        with pytest.raises(DatabaseAccessBlocked):
            engine.connect()
        assert db_block_attempts.new == ["psycopg2.connect"]
        db_block_attempts.discard()
        engine.dispose()


# ── save_section_findings tests ────────────────────────────────


def _reject_constant(token: str):
    raise ValueError(f"bare {token} token in JSON")


def _load_strict(path: Path) -> dict:
    """Parse a findings file the way Postgres jsonb would: no NaN or Infinity."""
    return json.loads(path.read_text(), parse_constant=_reject_constant)


class TestSaveSectionFindings:
    """The file takes every section; the database takes only the one saved."""

    DSN = "postgresql://u:p@db.invalid/neondb"  # fake: psycopg2.connect is patched

    @pytest.fixture
    def root(self, tmp_path, monkeypatch):
        monkeypatch.setattr("utils.ML_ROOT", tmp_path)
        monkeypatch.setattr("utils.load_env", lambda: {"DATABASE_URL": self.DSN})
        return tmp_path

    @pytest.fixture
    def db(self, monkeypatch):
        cur = MagicMock()
        conn = MagicMock()
        conn.__enter__.return_value = conn
        conn.cursor.return_value.__enter__.return_value = cur
        connect = MagicMock(return_value=conn)
        monkeypatch.setattr("utils.psycopg2.connect", connect)
        return SimpleNamespace(connect=connect, conn=conn, cur=cur)

    # ── what reaches the database ──

    def test_db_receives_only_the_section(self, root, db):
        (root / "findings.json").write_text(
            json.dumps(
                {
                    "phase2": {"fake": 1},
                    "calibration": {"fake": 2},
                    "pipeline_sections": ["phase2"],
                }
            )
        )
        save_section_findings("health", {"status": "PASS"})
        db.cur.execute.assert_called_once()
        sql, params = db.cur.execute.call_args.args
        assert sql is _MERGE_SECTION_SQL
        assert params["name"] == "health"
        assert json.loads(params["data"]) == {"status": "PASS"}
        # Nothing from the dirty local file travels.
        assert "fake" not in repr(params)
        assert "phase2" not in repr(params)
        assert "calibration" not in repr(params)

    def test_sql_merges_and_never_replaces(self):
        assert "EXCLUDED.findings" not in _MERGE_SECTION_SQL
        assert "ml_findings.findings" in _MERGE_SECTION_SQL
        assert "||" in _MERGE_SECTION_SQL

    def test_sql_placeholders_match_the_params_sent(self, root, db):
        save_section_findings("a", {"x": 1})
        params = db.cur.execute.call_args.args[1]
        assert set(re.findall(r"%\((\w+)\)s", _MERGE_SECTION_SQL)) == set(params)

    def test_same_generated_at_in_file_and_db(self, root, db):
        save_section_findings("a", {"x": 1})
        saved = _load_strict(root / "findings.json")
        assert db.cur.execute.call_args.args[1]["generated_at"] == saved["generated_at"]

    def test_the_connection_is_closed_after_a_save(self, root, db):
        save_section_findings("a", {"x": 1})
        db.conn.close.assert_called_once()

    def test_no_database_url_skips_the_db(self, root, db, monkeypatch):
        monkeypatch.setattr("utils.load_env", lambda: {})
        save_section_findings("a", {"x": 1})
        db.connect.assert_not_called()
        assert _load_strict(root / "findings.json")["a"] == {"x": 1}

    # ── the local file ──

    def test_local_file_still_accumulates_sections(self, root, db):
        save_section_findings("a", {"x": 1})
        save_section_findings("b", {"y": 2})
        saved = _load_strict(root / "findings.json")
        assert saved["a"] == {"x": 1}
        assert saved["b"] == {"y": 2}
        assert saved["pipeline_sections"] == ["a", "b"]

    def test_saving_a_section_twice_lists_it_once(self, root, db):
        save_section_findings("a", {"x": 1})
        save_section_findings("a", {"x": 2})
        saved = _load_strict(root / "findings.json")
        assert saved["a"] == {"x": 2}
        assert saved["pipeline_sections"] == ["a"]

    @pytest.mark.parametrize("name", ["generated_at", "pipeline_sections"])
    def test_metadata_names_are_not_sections(self, root, db, name):
        with pytest.raises(ValueError, match=name):
            save_section_findings(name, {"x": 1})
        # Rejected before any write: no file, no connection.
        assert not (root / "findings.json").exists()
        db.connect.assert_not_called()

    # ── a database error is not swallowed ──

    def test_an_execute_error_propagates_after_the_file_is_written(
        self, root, db, capsys
    ):
        db.cur.execute.side_effect = psycopg2.OperationalError("connection lost")
        with pytest.raises(psycopg2.OperationalError, match="connection lost"):
            save_section_findings("a", {"x": 1})
        assert _load_strict(root / "findings.json")["a"] == {"x": 1}
        out = capsys.readouterr().out
        assert "Could not upsert" not in out
        assert "Saved: ml_findings" not in out

    def test_the_connection_is_closed_when_the_merge_fails(self, root, db):
        db.cur.execute.side_effect = psycopg2.OperationalError("connection lost")
        with pytest.raises(psycopg2.OperationalError):
            save_section_findings("a", {"x": 1})
        db.conn.close.assert_called_once()

    def test_a_connect_error_propagates_after_the_file_is_written(self, root, db):
        db.connect.side_effect = psycopg2.OperationalError("connection refused")
        with pytest.raises(psycopg2.OperationalError, match="connection refused"):
            save_section_findings("a", {"x": 1})
        assert _load_strict(root / "findings.json")["a"] == {"x": 1}

    def test_a_malformed_findings_file_propagates(self, root, db):
        (root / "findings.json").write_text("{not json")
        with pytest.raises(json.JSONDecodeError):
            save_section_findings("a", {"x": 1})
        db.connect.assert_not_called()

    # ── non-finite floats become null ──

    @pytest.mark.parametrize(
        "bad",
        [
            float("nan"),
            float("inf"),
            float("-inf"),
            np.float64("nan"),
            np.float32("nan"),
            np.float32("-inf"),
            np.float16("inf"),
        ],
        ids=[
            "float-nan",
            "float-inf",
            "float-neg-inf",
            "np.float64-nan",
            "np.float32-nan",
            "np.float32-neg-inf",
            "np.float16-inf",
        ],
    )
    def test_a_non_finite_value_is_saved_as_null_in_the_file_and_the_db(
        self, root, db, capsys, bad
    ):
        save_section_findings("eda", {"results": {"q1": {"p_value": bad, "n": 5}}})
        expected = {"results": {"q1": {"p_value": None, "n": 5}}}
        assert _load_strict(root / "findings.json")["eda"] == expected
        payload = db.cur.execute.call_args.args[1]["data"]
        assert json.loads(payload, parse_constant=_reject_constant) == expected
        out = capsys.readouterr().out
        assert "'eda'" in out
        assert "results.q1.p_value" in out

    def test_non_finite_values_are_found_inside_lists_and_tuples(
        self, root, db, capsys
    ):
        data = {
            "rows": [1.0, float("nan"), {"x": np.float32("nan")}],
            "pair": (np.float64("inf"), 2),
        }
        save_section_findings("eda", data)
        expected = {"rows": [1.0, None, {"x": None}], "pair": [None, 2]}
        assert _load_strict(root / "findings.json")["eda"] == expected
        payload = db.cur.execute.call_args.args[1]["data"]
        assert json.loads(payload, parse_constant=_reject_constant) == expected
        out = capsys.readouterr().out
        assert "rows[1]" in out
        assert "rows[2].x" in out
        assert "pair[0]" in out

    def test_finite_values_pass_through_untouched(self, root, db, capsys):
        data = {"a": 0.0, "b": 3, "c": np.float64(1.5), "d": True, "e": "x", "f": None}
        save_section_findings("eda", data)
        assert _load_strict(root / "findings.json")["eda"] == {
            "a": 0.0,
            "b": 3,
            "c": 1.5,
            "d": True,
            "e": "x",
            "f": None,
        }
        assert "non-finite" not in capsys.readouterr().out

    def test_the_callers_data_is_not_mutated(self, root, db):
        data = {"a": [float("nan")], "b": {"c": np.float32("nan")}}
        save_section_findings("eda", data)
        assert np.isnan(data["a"][0])
        assert np.isnan(data["b"]["c"])

    def test_a_nan_left_in_another_section_of_the_file_is_healed(
        self, root, db, capsys
    ):
        # An older run wrote a bare NaN token. It must neither break this save
        # nor stay in the file, and the warning names the section it was in.
        (root / "findings.json").write_text('{"old": {"score": NaN}}')
        save_section_findings("new", {"x": 1})
        saved = _load_strict(root / "findings.json")
        assert saved["old"] == {"score": None}
        assert saved["new"] == {"x": 1}
        out = capsys.readouterr().out
        assert "'old'" in out
        assert "score" in out
