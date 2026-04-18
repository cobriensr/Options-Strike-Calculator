"""Tests for sidecar/src/db.py.

Scope: minimal coverage of the SIDE-003 idempotency change. Full db.py
coverage (connection pool lifecycle, upsert semantics) requires a real
Postgres instance and is out of scope for pytest.

Mock strategy:
- conftest.py provides session-wide mocks for psycopg2, psycopg2.pool,
  psycopg2.extras. These are the external-package mocks every test
  file shares. We reach into them for the execute_values attribute
  that db.py calls.
- db.py is imported normally. Its get_conn() context manager is
  monkeypatched per-test via the mock_conn_pool fixture, which also
  intercepts execute_values via sys.modules["psycopg2.extras"].
- No module-level sys.modules clobbering — every patch is per-test
  via monkeypatch, so sibling test files (test_trade_processor.py,
  test_databento_client.py, test_sentry_setup.py) stay hermetic.
"""

from __future__ import annotations

import os
import sys
from decimal import Decimal
from unittest.mock import MagicMock

# Required env vars for config.py's pydantic-settings validation.
# The DATABASE_URL is a throwaway test fixture — psycopg2 is mocked
# via conftest.py so no real connection is ever attempted.
os.environ.setdefault("DATABENTO_API_KEY", "test-key")
_FAKE_DB_URL = "postgresql://test:" + "fakefixture" + "@localhost/test"
os.environ.setdefault("DATABASE_URL", _FAKE_DB_URL)

import pytest  # noqa: E402
import db  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def mock_execute_values(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Monkeypatch psycopg2.extras.execute_values per-test.

    db.batch_insert_options_trades calls `psycopg2.extras.execute_values(...)`
    — we intercept that call by patching the attribute on the shared
    psycopg2.extras mock from conftest.py. monkeypatch auto-restores
    after each test, so no cross-test pollution.
    """
    mock = MagicMock()
    psycopg2_extras = sys.modules["psycopg2.extras"]
    monkeypatch.setattr(psycopg2_extras, "execute_values", mock)
    return mock


@pytest.fixture()
def mock_conn_pool(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Replace db.get_conn with a mock context manager yielding a fake conn.

    Returns the inner cursor MagicMock for tests that want to assert
    against it. Most tests only care about the execute_values mock
    above.
    """
    mock_cursor = MagicMock()
    mock_conn = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
    mock_conn.cursor.return_value.__exit__.return_value = None

    fake_context = MagicMock()
    fake_context.__enter__.return_value = mock_conn
    fake_context.__exit__.return_value = None

    # db.get_conn accepts a keyword arg (timeout_s) after the SIDE-005
    # pool-timeout work, so the replacement needs to swallow kwargs.
    monkeypatch.setattr(db, "get_conn", lambda *args, **kwargs: fake_context)
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
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        """The INSERT must include ON CONFLICT DO NOTHING for Databento resends.

        This is the SIDE-003 fix: without the ON CONFLICT clause, Databento
        resending a trade after a brief disconnect would accumulate duplicate
        rows in futures_options_trades over time.
        """
        db.batch_insert_options_trades([SAMPLE_ROW])

        mock_execute_values.assert_called_once()
        sql_arg = mock_execute_values.call_args[0][1]  # second positional arg
        assert "INSERT INTO futures_options_trades" in sql_arg
        assert "ON CONFLICT" in sql_arg
        assert "DO NOTHING" in sql_arg

    def test_sql_conflict_target_matches_unique_index(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        """The ON CONFLICT target must match the natural-key tuple created by
        migration #50's unique index. If these drift, the ON CONFLICT clause
        will raise a 'no unique or exclusion constraint matching' error at
        runtime instead of silently deduping.
        """
        db.batch_insert_options_trades([SAMPLE_ROW])

        sql_arg = mock_execute_values.call_args[0][1]
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

    def test_empty_rows_is_noop(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        """Empty batch must not issue any SQL."""
        db.batch_insert_options_trades([])
        mock_execute_values.assert_not_called()

    def test_preserves_page_size(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        """page_size=500 is the batch chunk size — used to tune Postgres
        round-trip overhead. Pinning this so nobody accidentally removes it."""
        db.batch_insert_options_trades([SAMPLE_ROW])
        kwargs = mock_execute_values.call_args.kwargs
        assert kwargs.get("page_size") == 500


# ---------------------------------------------------------------------------
# batch_insert_top_of_book (Phase 2a, pre-trade BBO from TBBO records)
# ---------------------------------------------------------------------------


SAMPLE_TOB_ROW = (
    "ES",
    "2026-04-18 14:30:00+00",
    Decimal("5000.25"),  # bid
    10,  # bid_size
    Decimal("5000.50"),  # ask
    12,  # ask_size
)


class TestBatchInsertTopOfBook:
    def test_sql_targets_correct_table_and_columns(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        db.batch_insert_top_of_book([SAMPLE_TOB_ROW])
        mock_execute_values.assert_called_once()
        sql_arg = mock_execute_values.call_args[0][1]
        assert "INSERT INTO futures_top_of_book" in sql_arg
        for col in ("symbol", "ts", "bid", "bid_size", "ask", "ask_size"):
            assert col in sql_arg

    def test_no_on_conflict_clause(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        """Migration #71 intentionally omits a UNIQUE constraint — the
        quote stream is high-volume (one row per trade via TBBO) and
        dedup isn't meaningful at this layer. Pin this behavior so nobody
        adds an ON CONFLICT clause that would then fail at runtime with
        'no unique or exclusion constraint matching'."""
        db.batch_insert_top_of_book([SAMPLE_TOB_ROW])
        sql_arg = mock_execute_values.call_args[0][1]
        assert "ON CONFLICT" not in sql_arg

    def test_empty_rows_is_noop(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        db.batch_insert_top_of_book([])
        mock_execute_values.assert_not_called()

    def test_preserves_page_size(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        db.batch_insert_top_of_book([SAMPLE_TOB_ROW])
        kwargs = mock_execute_values.call_args.kwargs
        assert kwargs.get("page_size") == 500

    def test_multiple_rows_passed_through(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        rows = [SAMPLE_TOB_ROW] * 3
        db.batch_insert_top_of_book(rows)
        rows_arg = mock_execute_values.call_args[0][2]
        assert len(rows_arg) == 3


# ---------------------------------------------------------------------------
# batch_insert_trade_ticks (Phase 2a, TBBO ingest)
# ---------------------------------------------------------------------------


SAMPLE_TRADE_ROW = (
    "ES",
    "2026-04-18 14:30:00+00",
    Decimal("5000.50"),  # price
    5,  # size
    "B",  # aggressor_side
)


class TestBatchInsertTradeTicks:
    def test_sql_targets_correct_table_and_columns(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        db.batch_insert_trade_ticks([SAMPLE_TRADE_ROW])
        mock_execute_values.assert_called_once()
        sql_arg = mock_execute_values.call_args[0][1]
        assert "INSERT INTO futures_trade_ticks" in sql_arg
        for col in ("symbol", "ts", "price", "size", "aggressor_side"):
            assert col in sql_arg

    def test_no_on_conflict_clause(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        """Migration #72 has no UNIQUE constraint on the trade-tick table
        either — same reasoning as futures_top_of_book."""
        db.batch_insert_trade_ticks([SAMPLE_TRADE_ROW])
        sql_arg = mock_execute_values.call_args[0][1]
        assert "ON CONFLICT" not in sql_arg

    def test_empty_rows_is_noop(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        db.batch_insert_trade_ticks([])
        mock_execute_values.assert_not_called()

    def test_preserves_page_size(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        db.batch_insert_trade_ticks([SAMPLE_TRADE_ROW])
        kwargs = mock_execute_values.call_args.kwargs
        assert kwargs.get("page_size") == 500
