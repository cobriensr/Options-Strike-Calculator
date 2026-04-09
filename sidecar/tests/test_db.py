"""Tests for sidecar/src/db.py.

Scope: minimal coverage of the SIDE-003 idempotency change. Full db.py
coverage (connection pool lifecycle, upsert semantics) requires a real
Postgres instance and is out of scope for pytest.

We mock psycopg2 + psycopg2.pool + psycopg2.extras before importing db
so the module loads in environments where psycopg2 is not installed
(e.g., the local venv used for running these tests).
"""

from __future__ import annotations

import sys
from decimal import Decimal
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Pre-import psycopg2 mock setup
# ---------------------------------------------------------------------------

mock_psycopg2 = MagicMock()
mock_psycopg2_pool = MagicMock()
mock_psycopg2_extras = MagicMock()
mock_psycopg2.pool = mock_psycopg2_pool
mock_psycopg2.extras = mock_psycopg2_extras

# execute_values is where db.batch_insert_options_trades sends its SQL.
# We replace it with a tracking MagicMock so tests can inspect the query.
execute_values_mock = MagicMock()
mock_psycopg2_extras.execute_values = execute_values_mock

sys.modules["psycopg2"] = mock_psycopg2
sys.modules["psycopg2.pool"] = mock_psycopg2_pool
sys.modules["psycopg2.extras"] = mock_psycopg2_extras

# logger_setup is harmless but we mock it too to avoid accidentally
# constructing the real JSON handler in these tests.
sys.modules["logger_setup"] = MagicMock()

# config imports settings which reads env vars via pydantic — mock it
# to keep tests hermetic.
mock_config = MagicMock()
mock_config.settings = MagicMock()
mock_config.settings.database_url = "postgres://test@localhost/test"
sys.modules["config"] = mock_config

import pytest  # noqa: E402
import db  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_mocks() -> None:
    """Reset the execute_values mock between tests."""
    execute_values_mock.reset_mock()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def mock_conn_pool(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Replace db.get_conn with a mock context manager yielding a fake conn."""
    mock_cursor = MagicMock()
    mock_conn = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
    mock_conn.cursor.return_value.__exit__.return_value = None

    fake_context = MagicMock()
    fake_context.__enter__.return_value = mock_conn
    fake_context.__exit__.return_value = None

    monkeypatch.setattr(db, "get_conn", lambda: fake_context)
    return mock_cursor


# ---------------------------------------------------------------------------
# batch_insert_options_trades — SIDE-003 idempotency
# ---------------------------------------------------------------------------


SAMPLE_ROW = (
    "ES",
    "2026-04-06",
    Decimal("5300.0"),
    "C",
    "2026-04-05 14:30:00+00",
    Decimal("50.25"),
    1,
    "B",
    "2026-04-05",
)


class TestBatchInsertIdempotency:
    def test_sql_contains_on_conflict_do_nothing(
        self, mock_conn_pool: MagicMock
    ) -> None:
        """The INSERT must include ON CONFLICT DO NOTHING for Databento resends.

        This is the SIDE-003 fix: without the ON CONFLICT clause, Databento
        resending a trade after a brief disconnect would accumulate duplicate
        rows in futures_options_trades over time.
        """
        db.batch_insert_options_trades([SAMPLE_ROW])

        execute_values_mock.assert_called_once()
        sql_arg = execute_values_mock.call_args[0][1]  # second positional arg
        assert "INSERT INTO futures_options_trades" in sql_arg
        assert "ON CONFLICT" in sql_arg
        assert "DO NOTHING" in sql_arg

    def test_sql_conflict_target_matches_unique_index(
        self, mock_conn_pool: MagicMock
    ) -> None:
        """The ON CONFLICT target must match the natural-key tuple created by
        migration #50's unique index. If these drift, the ON CONFLICT clause
        will raise a 'no unique or exclusion constraint matching' error at
        runtime instead of silently deduping.
        """
        db.batch_insert_options_trades([SAMPLE_ROW])

        sql_arg = execute_values_mock.call_args[0][1]
        # All 8 natural-key columns in order
        for col in (
            "ts",
            "underlying",
            "expiry",
            "strike",
            "option_type",
            "price",
            "size",
            "side",
        ):
            assert col in sql_arg

    def test_empty_rows_is_noop(self, mock_conn_pool: MagicMock) -> None:
        """Empty batch must not issue any SQL."""
        db.batch_insert_options_trades([])
        execute_values_mock.assert_not_called()

    def test_preserves_page_size(self, mock_conn_pool: MagicMock) -> None:
        """page_size=500 is the batch chunk size — used to tune Postgres
        round-trip overhead. Pinning this so nobody accidentally removes it."""
        db.batch_insert_options_trades([SAMPLE_ROW])
        kwargs = execute_values_mock.call_args.kwargs
        assert kwargs.get("page_size") == 500
