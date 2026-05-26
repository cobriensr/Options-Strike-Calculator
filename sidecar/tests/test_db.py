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
from datetime import date
from decimal import Decimal
from typing import Generator
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


# ---------------------------------------------------------------------------
# _execute_values_batch helper — the shared shape lifted out of the four
# batch_insert callers above.
# ---------------------------------------------------------------------------


class TestExecuteValuesBatch:
    """Direct coverage of the helper. The four batch_insert public
    functions exercise it transitively, but pinning behavior here
    makes future tweaks (page size override, additional callers) safe
    without dragging assertions through the SQL-shape suites."""

    SAMPLE_SQL = "INSERT INTO some_table (a, b) VALUES %s"
    SAMPLE_ROW = (1, 2)

    def test_empty_rows_is_noop(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        """The empty-rows guard is what every caller relied on; pinning
        it as a property of the helper itself."""
        db._execute_values_batch(self.SAMPLE_SQL, [])
        mock_execute_values.assert_not_called()

    def test_single_row_passed_through(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        db._execute_values_batch(self.SAMPLE_SQL, [self.SAMPLE_ROW])
        mock_execute_values.assert_called_once()
        sql_arg = mock_execute_values.call_args[0][1]
        rows_arg = mock_execute_values.call_args[0][2]
        assert sql_arg == self.SAMPLE_SQL
        assert rows_arg == [self.SAMPLE_ROW]

    def test_multi_row_passed_through(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        rows = [self.SAMPLE_ROW] * 7
        db._execute_values_batch(self.SAMPLE_SQL, rows)
        rows_arg = mock_execute_values.call_args[0][2]
        assert len(rows_arg) == 7

    def test_default_page_size_is_module_constant(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        """The 500-row default has been the stable value across every
        caller since SIDE-003; pin it via the named constant so a
        future change is deliberate."""
        assert db._DEFAULT_BATCH_PAGE_SIZE == 500
        db._execute_values_batch(self.SAMPLE_SQL, [self.SAMPLE_ROW])
        kwargs = mock_execute_values.call_args.kwargs
        assert kwargs.get("page_size") == db._DEFAULT_BATCH_PAGE_SIZE

    def test_page_size_override(
        self, mock_conn_pool: MagicMock, mock_execute_values: MagicMock
    ) -> None:
        """Callers can override page_size when the workload calls for
        a different chunking strategy."""
        db._execute_values_batch(self.SAMPLE_SQL, [self.SAMPLE_ROW], page_size=100)
        kwargs = mock_execute_values.call_args.kwargs
        assert kwargs.get("page_size") == 100

    def test_operational_error_retries_once_and_succeeds(
        self,
        mock_conn_pool: MagicMock,
        mock_execute_values: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """SENTRY-EMERALD-DESERT-6X: when the first borrowed connection
        is stale (Neon SSL drop after idle), execute_values raises
        OperationalError. The helper must retry once with a fresh conn
        rather than dropping the in-flight 500-row batch.

        psycopg2 is mocked at session scope, so OperationalError isn't a
        real class — install a temporary Exception subclass and patch
        the mock attribute for the duration of the test."""
        import psycopg2

        class _FakeOpError(Exception):
            pass

        monkeypatch.setattr(psycopg2, "OperationalError", _FakeOpError)
        mock_execute_values.side_effect = [
            _FakeOpError("SSL connection has been closed unexpectedly"),
            None,  # second attempt succeeds
        ]

        db._execute_values_batch(self.SAMPLE_SQL, [self.SAMPLE_ROW])

        assert mock_execute_values.call_count == 2

    def test_operational_error_raises_when_retry_also_fails(
        self,
        mock_conn_pool: MagicMock,
        mock_execute_values: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """If the second attempt also fails with OperationalError, propagate
        — the caller's capture_exception is the final-failure observability
        path."""
        import psycopg2

        class _FakeOpError(Exception):
            pass

        monkeypatch.setattr(psycopg2, "OperationalError", _FakeOpError)
        mock_execute_values.side_effect = _FakeOpError("still broken")

        with pytest.raises(_FakeOpError, match="still broken"):
            db._execute_values_batch(self.SAMPLE_SQL, [self.SAMPLE_ROW])

        assert mock_execute_values.call_count == 2

    def test_non_operational_error_does_not_retry(
        self,
        mock_conn_pool: MagicMock,
        mock_execute_values: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Only OperationalError gets the retry. Programming errors
        (bad SQL, constraint violations) must surface immediately —
        retrying them would just delay the failure and double-log."""
        import psycopg2

        class _FakeOpError(Exception):
            pass

        monkeypatch.setattr(psycopg2, "OperationalError", _FakeOpError)
        mock_execute_values.side_effect = ValueError("not an SSL drop")

        with pytest.raises(ValueError, match="not an SSL drop"):
            db._execute_values_batch(self.SAMPLE_SQL, [self.SAMPLE_ROW])

        assert mock_execute_values.call_count == 1


# ---------------------------------------------------------------------------
# _execute_with_retry helper — single-statement sibling of
# _execute_values_batch. Same retry shape so the SSL-drop coverage now
# extends to upsert_options_daily and any future single-statement caller
# wired through the helper.
# ---------------------------------------------------------------------------


class TestExecuteWithRetry:
    """Direct coverage for the single-statement retry helper added to
    fix SENTRY-EMERALD-DESERT-6W (the option-stat upsert path's Neon
    SSL drop)."""

    SAMPLE_SQL = "INSERT INTO some_table (a, b) VALUES (%s, %s)"
    SAMPLE_PARAMS = (1, 2)

    def test_success_on_first_attempt(self, mock_conn_pool: MagicMock) -> None:
        db._execute_with_retry(self.SAMPLE_SQL, self.SAMPLE_PARAMS)
        mock_conn_pool.execute.assert_called_once_with(
            self.SAMPLE_SQL, self.SAMPLE_PARAMS
        )

    def test_operational_error_retries_once_and_succeeds(
        self,
        mock_conn_pool: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """First borrowed connection is stale (Neon SSL drop after idle);
        the helper retries on a fresh connection."""
        import psycopg2

        class _FakeOpError(Exception):
            pass

        monkeypatch.setattr(psycopg2, "OperationalError", _FakeOpError)
        mock_conn_pool.execute.side_effect = [
            _FakeOpError("SSL connection has been closed unexpectedly"),
            None,
        ]

        db._execute_with_retry(self.SAMPLE_SQL, self.SAMPLE_PARAMS)

        assert mock_conn_pool.execute.call_count == 2

    def test_operational_error_raises_when_retry_also_fails(
        self,
        mock_conn_pool: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import psycopg2

        class _FakeOpError(Exception):
            pass

        monkeypatch.setattr(psycopg2, "OperationalError", _FakeOpError)
        mock_conn_pool.execute.side_effect = _FakeOpError("still broken")

        with pytest.raises(_FakeOpError, match="still broken"):
            db._execute_with_retry(self.SAMPLE_SQL, self.SAMPLE_PARAMS)

        assert mock_conn_pool.execute.call_count == 2

    def test_non_operational_error_does_not_retry(
        self,
        mock_conn_pool: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import psycopg2

        class _FakeOpError(Exception):
            pass

        monkeypatch.setattr(psycopg2, "OperationalError", _FakeOpError)
        mock_conn_pool.execute.side_effect = ValueError("bad SQL")

        with pytest.raises(ValueError, match="bad SQL"):
            db._execute_with_retry(self.SAMPLE_SQL, self.SAMPLE_PARAMS)

        assert mock_conn_pool.execute.call_count == 1

    def test_upsert_options_daily_routes_through_retry_helper(
        self,
        mock_conn_pool: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Smoke: a transient SSL drop on the option-stat upsert path
        now recovers without dropping the in-flight stat (the failure
        mode that produced SENTRY-EMERALD-DESERT-6W)."""
        import psycopg2

        class _FakeOpError(Exception):
            pass

        monkeypatch.setattr(psycopg2, "OperationalError", _FakeOpError)
        mock_conn_pool.execute.side_effect = [
            _FakeOpError("SSL connection has been closed unexpectedly"),
            None,
        ]

        db.upsert_options_daily(
            "ES",
            date(2026, 5, 14),
            date(2026, 5, 16),
            Decimal("4400.0"),
            "C",
            open_interest=123,
        )

        assert mock_conn_pool.execute.call_count == 2
        # Guard against a future rewire silently sending this path
        # through a different SQL: pin that the call hits the target
        # table.
        sql_arg = mock_conn_pool.execute.call_args.args[0]
        assert "INSERT INTO futures_options_daily" in sql_arg


# ---------------------------------------------------------------------------
# Phase 5e — load_alert_config silent-fallback observability
# ---------------------------------------------------------------------------


class TestLoadAlertConfigObservability:
    """Verify the empty-dict fallback now forwards unexpected exceptions
    to Sentry. Empty config remains the documented runtime behavior;
    the only behavior change is observability of the failure path.

    Note on mocking psycopg2.errors.UndefinedTable: conftest mocks the
    whole psycopg2 package, so its `errors` attribute is a MagicMock
    where `UndefinedTable` is an auto-spec'd MagicMock (not an Exception
    subclass — Python rejects it as an `except` target). Each test
    that needs the UndefinedTable branch installs a real Exception
    subclass for the duration of the test only.
    """

    @pytest.fixture
    def real_undefined_table(self, monkeypatch: pytest.MonkeyPatch) -> type[Exception]:
        """Install a real exception class for psycopg2.errors.UndefinedTable.

        Without this, `except psycopg2.errors.UndefinedTable:` raises
        TypeError because the mock's auto-attribute isn't a class.
        """
        import psycopg2

        cls = type("UndefinedTable", (Exception,), {})
        monkeypatch.setattr(psycopg2.errors, "UndefinedTable", cls)
        return cls

    def test_undefined_table_returns_empty_without_sentry(
        self,
        mock_conn_pool: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
        real_undefined_table: type[Exception],
    ) -> None:
        """Pre-init state (table doesn't exist yet) is a known-OK
        condition — must NOT page Sentry, just log a warning."""
        mock_conn_pool.execute.side_effect = real_undefined_table("table missing")

        captured: list[BaseException] = []
        monkeypatch.setattr(
            "sentry_setup.capture_exception",
            lambda exc, **_kw: captured.append(exc),
        )

        result = db.load_alert_config()

        assert result == {}
        # UndefinedTable is the known pre-init state; Sentry stays quiet.
        assert captured == []

    def test_unexpected_exception_forwards_to_sentry(
        self,
        mock_conn_pool: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
        real_undefined_table: type[Exception],
    ) -> None:
        """A non-UndefinedTable exception must surface in Sentry while
        the empty-dict fallback is still returned (caller contract)."""
        boom = RuntimeError("connection reset")
        mock_conn_pool.execute.side_effect = boom

        captured: list[tuple[BaseException, dict]] = []

        def fake_capture(exc: BaseException, **kw: object) -> None:
            captured.append((exc, kw))

        monkeypatch.setattr("sentry_setup.capture_exception", fake_capture)

        result = db.load_alert_config()

        assert result == {}
        assert len(captured) == 1
        assert captured[0][0] is boom
        # Tag + context shape locks the observability payload.
        kwargs = captured[0][1]
        assert kwargs.get("tags") == {"component": "db"}
        assert kwargs.get("context") == {"phase": "load_alert_config"}

    def test_sentry_failure_does_not_break_caller(
        self,
        mock_conn_pool: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
        real_undefined_table: type[Exception],
    ) -> None:
        """If Sentry forwarding itself raises, the empty-dict caller
        contract must still hold — never let observability break the
        runtime fallback."""
        mock_conn_pool.execute.side_effect = RuntimeError("connection reset")

        def boom_sentry(*_a: object, **_kw: object) -> None:
            raise RuntimeError("sentry SDK exploded")

        monkeypatch.setattr("sentry_setup.capture_exception", boom_sentry)

        # Must not raise — caller relies on dict return.
        assert db.load_alert_config() == {}


# ---------------------------------------------------------------------------
# get_conn — dead-connection handling (SENTRY-EMERALD-DESERT-6S/-2C)
# ---------------------------------------------------------------------------


class TestGetConnDeadConnectionHandling:
    """Verify get_conn doesn't mask the original exception when the
    connection has been torn down by libpq (Neon SSL drop), and that
    broken connections are discarded from the pool rather than handed
    back to the next caller.

    These tests bypass the per-test `mock_conn_pool` fixture (which
    replaces get_conn wholesale) and instead patch the pool layer so
    the real get_conn body executes.
    """

    @pytest.fixture
    def fake_pool_with_conn(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> tuple[MagicMock, MagicMock]:
        """Install a fake pool whose getconn() returns a controllable conn.

        Returns (pool, conn) so each test can configure side effects on
        the conn (rollback raising, closed != 0, etc.) and assert on
        pool.putconn calls.
        """
        conn = MagicMock()
        conn.closed = 0  # default: healthy
        pool = MagicMock()
        pool.getconn.return_value = conn
        monkeypatch.setattr(db, "get_pool", lambda: pool)
        return pool, conn

    def test_original_exception_propagates_when_rollback_succeeds(
        self, fake_pool_with_conn: tuple[MagicMock, MagicMock]
    ) -> None:
        """Baseline: when the body raises and rollback succeeds, the
        body's exception is what reaches the caller (not the rollback)."""
        _pool, conn = fake_pool_with_conn

        with pytest.raises(RuntimeError, match="body boom"):
            with db.get_conn() as _:
                raise RuntimeError("body boom")

        conn.rollback.assert_called_once()

    def test_rollback_failure_does_not_mask_original_exception(
        self, fake_pool_with_conn: tuple[MagicMock, MagicMock]
    ) -> None:
        """The bug from SENTRY-EMERALD-DESERT-6S: when the body raises
        OperationalError (Neon SSL drop) and rollback then raises
        InterfaceError (connection already closed), the InterfaceError
        used to mask the real cause. The OperationalError must reach
        the caller now."""
        _pool, conn = fake_pool_with_conn
        conn.rollback.side_effect = RuntimeError(
            "InterfaceError: connection already closed"
        )

        with pytest.raises(RuntimeError, match="ssl drop"):
            with db.get_conn() as _:
                raise RuntimeError("ssl drop")

        conn.rollback.assert_called_once()

    def test_broken_connection_is_discarded_from_pool(
        self, fake_pool_with_conn: tuple[MagicMock, MagicMock]
    ) -> None:
        """When libpq marks the connection broken (conn.closed != 0),
        putconn must be called with close=True so the pool drops it
        instead of handing the dead socket to the next caller."""
        pool, conn = fake_pool_with_conn
        conn.closed = 2  # libpq's "broken connection" state
        conn.rollback.side_effect = RuntimeError("connection already closed")

        with pytest.raises(RuntimeError):
            with db.get_conn() as _:
                raise RuntimeError("ssl drop")

        pool.putconn.assert_called_once_with(conn, close=True)

    def test_healthy_connection_returned_to_pool_with_close_false(
        self, fake_pool_with_conn: tuple[MagicMock, MagicMock]
    ) -> None:
        """Regression guard: don't churn the pool when nothing is wrong.
        On the success path (no exception, conn.closed == 0), putconn
        must be called with close=False so the connection is reused."""
        pool, conn = fake_pool_with_conn

        with db.get_conn() as _:
            pass

        conn.commit.assert_called_once()
        pool.putconn.assert_called_once_with(conn, close=False)

    def test_putconn_failure_during_shutdown_is_swallowed(
        self, fake_pool_with_conn: tuple[MagicMock, MagicMock]
    ) -> None:
        """During shutdown the pool may already be closed; putconn then
        raises PoolError. That must not replace the body's exception."""
        pool, conn = fake_pool_with_conn
        pool.putconn.side_effect = RuntimeError("connection pool is closed")

        with pytest.raises(RuntimeError, match="body boom"):
            with db.get_conn() as _:
                raise RuntimeError("body boom")


# ---------------------------------------------------------------------------
# get_pool — lazy init + re-init when closed
# ---------------------------------------------------------------------------


class TestGetPool:
    """Cover the lazy-init and re-init paths in `get_pool`.

    Each test resets `db._pool` so the prior test's pool doesn't bleed in.
    We patch `psycopg2.pool.ThreadedConnectionPool` to avoid touching the
    real driver, and stub `config.settings.database_url` via a fake module
    so the lazy `from config import settings` call lands on our value.
    """

    @pytest.fixture(autouse=True)
    def _reset_pool(self) -> Generator[None, None, None]:
        """Restore db._pool to None before and after each test in this class."""
        original = db._pool
        db._pool = None
        yield
        db._pool = original

    @pytest.fixture
    def fake_threaded_pool(self, monkeypatch: pytest.MonkeyPatch) -> MagicMock:
        """Patch the ThreadedConnectionPool factory to a MagicMock."""
        import psycopg2.pool

        factory = MagicMock()
        factory.return_value = MagicMock()
        monkeypatch.setattr(psycopg2.pool, "ThreadedConnectionPool", factory)
        return factory

    @pytest.fixture
    def fake_settings(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Inject a fake `config` module exposing settings.database_url."""
        fake_config = MagicMock()
        fake_config.settings.database_url = "postgresql://u:p@host/db?sslmode=require"
        monkeypatch.setitem(sys.modules, "config", fake_config)

    def test_lazy_init_creates_pool_with_stripped_dsn(
        self,
        fake_threaded_pool: MagicMock,
        fake_settings: None,
    ) -> None:
        """First call should construct a pool, stripping query params from
        the DSN (Neon's pooler rejects startup params like statement_timeout)."""
        pool = db.get_pool()

        assert pool is fake_threaded_pool.return_value
        fake_threaded_pool.assert_called_once()
        kwargs = fake_threaded_pool.call_args.kwargs
        assert kwargs["minconn"] == 1
        assert kwargs["maxconn"] == 5
        assert kwargs["sslmode"] == "require"
        # `?sslmode=require` portion must be stripped before psycopg2 sees it.
        assert kwargs["dsn"] == "postgresql://u:p@host/db"

    def test_lazy_init_enables_tcp_keepalives(
        self,
        fake_threaded_pool: MagicMock,
        fake_settings: None,
    ) -> None:
        """Pin the libpq keepalive params so the kernel can detect a
        server-side SSL drop before the next query lands on a dead socket.
        Without these, Neon idling the pooled connection over the
        Fri-4pm-to-Sun-5pm-CT futures gap raises
        ``OperationalError: SSL connection has been closed unexpectedly``
        on the first batch after open. See SENTRY-EMERALD-DESERT-6X."""
        db.get_pool()
        kwargs = fake_threaded_pool.call_args.kwargs
        assert kwargs["keepalives"] == 1
        assert kwargs["keepalives_idle"] == 30
        assert kwargs["keepalives_interval"] == 10
        assert kwargs["keepalives_count"] == 5

    def test_returns_same_pool_on_repeated_calls(
        self,
        fake_threaded_pool: MagicMock,
        fake_settings: None,
    ) -> None:
        """Lazy init should be a one-shot — second call must reuse."""
        first = db.get_pool()
        # Mark it as not-closed so the re-init branch is skipped.
        first.closed = False
        second = db.get_pool()
        assert first is second
        assert fake_threaded_pool.call_count == 1

    def test_reinit_when_pool_closed(
        self,
        fake_threaded_pool: MagicMock,
        fake_settings: None,
    ) -> None:
        """If a prior pool is `closed`, get_pool must construct a new one."""
        fake_threaded_pool.side_effect = [
            MagicMock(closed=True),  # first pool, will be observed as closed
            MagicMock(closed=False),  # second pool, the replacement
        ]
        first = db.get_pool()
        assert first.closed is True
        second = db.get_pool()
        assert second is not first
        assert fake_threaded_pool.call_count == 2


# ---------------------------------------------------------------------------
# _getconn_with_timeout — slow-borrow warning + retry-on-PoolError
# ---------------------------------------------------------------------------


class TestGetConnWithTimeout:
    """Cover the slow-borrow Sentry warning and the PoolError retry loop."""

    def test_fast_borrow_returns_immediately(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The happy path: getconn returns instantly, no warning fires."""
        # monotonic returns the same value on each call -> elapsed_ms == 0
        monkeypatch.setattr(db.time, "monotonic", lambda: 100.0)
        conn = MagicMock()
        pool = MagicMock()
        pool.getconn.return_value = conn

        captured: list[str] = []
        monkeypatch.setattr(
            "sentry_setup.capture_message",
            lambda msg, **_kw: captured.append(msg),
        )

        result = db._getconn_with_timeout(pool, timeout_s=10.0)

        assert result is conn
        assert captured == []

    def test_slow_borrow_triggers_sentry_warning(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When elapsed_ms > SLOW_GETCONN_WARNING_MS (1000), forward to Sentry."""
        # Two calls to monotonic: start=0, after-getconn=2.5s -> 2500ms
        ticks = iter([0.0, 2.5])
        monkeypatch.setattr(db.time, "monotonic", lambda: next(ticks))
        conn = MagicMock()
        pool = MagicMock()
        pool.getconn.return_value = conn

        captured: list[tuple[str, dict]] = []

        def fake_capture(msg: str, **kwargs: object) -> None:
            captured.append((msg, kwargs))

        monkeypatch.setattr("sentry_setup.capture_message", fake_capture)

        result = db._getconn_with_timeout(pool, timeout_s=10.0)

        assert result is conn
        assert len(captured) == 1
        msg, kwargs = captured[0]
        assert "slow" in msg.lower()
        assert kwargs.get("level") == "warning"
        # Round to one decimal — matches the call site.
        assert kwargs.get("context") == {"elapsed_ms": 2500.0}

    def test_slow_borrow_sentry_failure_falls_back_to_log(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """If the sentry import/call raises, the warning still goes to the
        local log (covered) and the connection is still returned."""
        ticks = iter([0.0, 2.0])
        monkeypatch.setattr(db.time, "monotonic", lambda: next(ticks))
        conn = MagicMock()
        pool = MagicMock()
        pool.getconn.return_value = conn

        def boom(*_a: object, **_kw: object) -> None:
            raise RuntimeError("sentry not available")

        monkeypatch.setattr("sentry_setup.capture_message", boom)

        # Must not raise — the slow path swallows sentry failures.
        result = db._getconn_with_timeout(pool, timeout_s=10.0)
        assert result is conn

    def test_pool_error_retries_then_succeeds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """PoolError on first borrow should sleep+retry, then succeed."""
        import psycopg2.pool

        # Three monotonic reads: initial start, deadline-check after 1st
        # PoolError (still inside deadline), and elapsed-ms read on the
        # successful borrow path. Keep all values < timeout to skip the
        # slow-warning branch.
        ticks = iter([0.0, 0.001, 0.002, 0.003, 0.004])
        monkeypatch.setattr(db.time, "monotonic", lambda: next(ticks))

        sleeps: list[float] = []
        monkeypatch.setattr(db.time, "sleep", lambda s: sleeps.append(s))

        conn = MagicMock()
        pool = MagicMock()
        pool.getconn.side_effect = [
            psycopg2.pool.PoolError("exhausted"),
            conn,
        ]

        result = db._getconn_with_timeout(pool, timeout_s=10.0)

        assert result is conn
        assert sleeps == [0.005]  # initial backoff_s
        assert pool.getconn.call_count == 2

    def test_pool_error_past_deadline_raises_pool_timeout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When PoolError persists past the deadline, raise PoolTimeoutError."""
        import psycopg2.pool

        # start=0, then deadline-check returns 5.0 (past the 1s timeout),
        # then a final elapsed-ms read inside the raise.
        ticks = iter([0.0, 5.0, 5.001])
        monkeypatch.setattr(db.time, "monotonic", lambda: next(ticks))
        monkeypatch.setattr(db.time, "sleep", lambda s: None)

        pool = MagicMock()
        pool.getconn.side_effect = psycopg2.pool.PoolError("exhausted")

        with pytest.raises(db.PoolTimeoutError, match="db pool saturated"):
            db._getconn_with_timeout(pool, timeout_s=1.0)


# ---------------------------------------------------------------------------
# verify_connection
# ---------------------------------------------------------------------------


class TestVerifyConnection:
    def test_happy_path_returns_none(self, mock_conn_pool: MagicMock) -> None:
        """SELECT 1 returning (1,) means the DB is reachable."""
        mock_conn_pool.fetchone.return_value = (1,)
        # Must not raise.
        db.verify_connection()
        mock_conn_pool.execute.assert_called_once()
        sql = mock_conn_pool.execute.call_args[0][0]
        assert "SELECT 1" in sql

    def test_no_row_raises_runtime_error(self, mock_conn_pool: MagicMock) -> None:
        mock_conn_pool.fetchone.return_value = None
        with pytest.raises(
            RuntimeError, match="Database connection verification failed"
        ):
            db.verify_connection()

    def test_wrong_row_raises_runtime_error(self, mock_conn_pool: MagicMock) -> None:
        mock_conn_pool.fetchone.return_value = (0,)
        with pytest.raises(
            RuntimeError, match="Database connection verification failed"
        ):
            db.verify_connection()


# ---------------------------------------------------------------------------
# is_db_healthy
# ---------------------------------------------------------------------------


class TestIsDbHealthy:
    def test_returns_true_on_success(self, mock_conn_pool: MagicMock) -> None:
        assert db.is_db_healthy() is True

    def test_returns_false_on_exception(self, mock_conn_pool: MagicMock) -> None:
        mock_conn_pool.execute.side_effect = RuntimeError("connection reset")
        assert db.is_db_healthy() is False


# ---------------------------------------------------------------------------
# upsert_futures_bar — single-row execute SQL shape
# ---------------------------------------------------------------------------


class TestUpsertFuturesBar:
    def test_execute_called_with_expected_sql_and_params(
        self, mock_conn_pool: MagicMock
    ) -> None:
        from datetime import datetime as _datetime

        ts = _datetime(2026, 4, 18, 14, 30)
        db.upsert_futures_bar(
            "ES",
            ts,
            Decimal("5000.0"),
            Decimal("5005.0"),
            Decimal("4995.0"),
            Decimal("5002.0"),
            123,
        )
        mock_conn_pool.execute.assert_called_once()
        sql, params = mock_conn_pool.execute.call_args[0]
        assert "INSERT INTO futures_bars" in sql
        assert "ON CONFLICT (symbol, ts) DO UPDATE" in sql
        # Params tuple in declaration order.
        assert params == (
            "ES",
            ts,
            Decimal("5000.0"),
            Decimal("5005.0"),
            Decimal("4995.0"),
            Decimal("5002.0"),
            123,
        )


# ---------------------------------------------------------------------------
# insert_options_trade — single-row execute SQL shape
# ---------------------------------------------------------------------------


class TestInsertOptionsTrade:
    def test_execute_called_with_expected_sql_and_params(
        self, mock_conn_pool: MagicMock
    ) -> None:
        from datetime import date as _date, datetime as _datetime

        ts = _datetime(2026, 4, 5, 14, 30)
        expiry = _date(2026, 4, 6)
        trade_date = _date(2026, 4, 5)

        db.insert_options_trade(
            "ES",
            expiry,
            Decimal("5300.0"),
            "C",
            ts,
            Decimal("50.25"),
            1,
            "B",
            trade_date,
        )
        mock_conn_pool.execute.assert_called_once()
        sql, params = mock_conn_pool.execute.call_args[0]
        assert "INSERT INTO futures_options_trades" in sql
        assert params == (
            "ES",
            expiry,
            Decimal("5300.0"),
            "C",
            ts,
            Decimal("50.25"),
            1,
            "B",
            trade_date,
        )


# ---------------------------------------------------------------------------
# upsert_options_daily — single-row execute SQL shape
# ---------------------------------------------------------------------------


class TestUpsertOptionsDaily:
    def test_execute_called_with_expected_sql_and_params(
        self, mock_conn_pool: MagicMock
    ) -> None:
        from datetime import date as _date

        trade_date = _date(2026, 4, 5)
        expiry = _date(2026, 4, 6)
        db.upsert_options_daily(
            "ES",
            trade_date,
            expiry,
            Decimal("5300.0"),
            "C",
            open_interest=100,
            volume=200,
            settlement=Decimal("12.50"),
            implied_vol=Decimal("0.18"),
            delta=Decimal("0.42"),
            is_final=True,
        )
        mock_conn_pool.execute.assert_called_once()
        sql, params = mock_conn_pool.execute.call_args[0]
        assert "INSERT INTO futures_options_daily" in sql
        assert (
            "ON CONFLICT (underlying, trade_date, expiry, strike, option_type)" in sql
        )
        assert params == (
            "ES",
            trade_date,
            expiry,
            Decimal("5300.0"),
            "C",
            100,
            200,
            Decimal("12.50"),
            Decimal("0.18"),
            Decimal("0.42"),
            True,
        )

    def test_defaults_propagate_as_none(self, mock_conn_pool: MagicMock) -> None:
        """All optional kwargs default to None so the COALESCE() upsert
        on the SQL side keeps the existing column value."""
        from datetime import date as _date

        db.upsert_options_daily(
            "ES",
            _date(2026, 4, 5),
            _date(2026, 4, 6),
            Decimal("5300.0"),
            "C",
        )
        params = mock_conn_pool.execute.call_args[0][1]
        # Trailing 6 params: open_interest, volume, settlement, implied_vol,
        # delta default to None; is_final defaults to False.
        assert params[5:] == (None, None, None, None, None, False)


# ---------------------------------------------------------------------------
# load_alert_config — happy-path row iteration
# ---------------------------------------------------------------------------


class TestLoadAlertConfigHappyPath:
    def test_returns_dict_keyed_by_alert_type(self, mock_conn_pool: MagicMock) -> None:
        """fetchall returns RealDictCursor-style rows; load_alert_config
        must reshape into {alert_type: {...}}."""
        mock_conn_pool.fetchall.return_value = [
            {
                "alert_type": "gap_widening",
                "enabled": True,
                "params": {"threshold": 0.5},
                "cooldown_minutes": 15,
            },
            {
                "alert_type": "vol_spike",
                "enabled": False,
                "params": {},
                "cooldown_minutes": 30,
            },
        ]

        result = db.load_alert_config()

        assert set(result.keys()) == {"gap_widening", "vol_spike"}
        assert result["gap_widening"]["enabled"] is True
        assert result["gap_widening"]["params"] == {"threshold": 0.5}
        assert result["gap_widening"]["cooldown_minutes"] == 15
        assert result["vol_spike"]["enabled"] is False


# ---------------------------------------------------------------------------
# has_theta_option_eod_rows
# ---------------------------------------------------------------------------


class TestHasThetaOptionEodRows:
    def test_returns_true_when_row_exists(self, mock_conn_pool: MagicMock) -> None:
        mock_conn_pool.fetchone.return_value = (1,)
        assert db.has_theta_option_eod_rows("SPX") is True
        sql, params = mock_conn_pool.execute.call_args[0]
        assert "SELECT 1 FROM theta_option_eod" in sql
        assert "LIMIT 1" in sql
        assert params == ("SPX",)

    def test_returns_false_when_no_row(self, mock_conn_pool: MagicMock) -> None:
        mock_conn_pool.fetchone.return_value = None
        assert db.has_theta_option_eod_rows("SPX") is False


# ---------------------------------------------------------------------------
# get_recent_bars
# ---------------------------------------------------------------------------


class TestGetRecentBars:
    def test_returns_dict_per_row(self, mock_conn_pool: MagicMock) -> None:
        from datetime import datetime as _datetime

        rows = [
            {
                "ts": _datetime(2026, 4, 18, 14, 30),
                "open": Decimal("5000.0"),
                "high": Decimal("5005.0"),
                "low": Decimal("4995.0"),
                "close": Decimal("5002.0"),
                "volume": 100,
            },
        ]
        mock_conn_pool.fetchall.return_value = rows

        result = db.get_recent_bars("ES", minutes=30)

        assert len(result) == 1
        assert result[0]["close"] == Decimal("5002.0")
        sql, params = mock_conn_pool.execute.call_args[0]
        assert "FROM futures_bars" in sql
        assert "make_interval(mins => %s)" in sql
        assert params == ("ES", 30)

    def test_default_minutes_is_60(self, mock_conn_pool: MagicMock) -> None:
        mock_conn_pool.fetchall.return_value = []
        db.get_recent_bars("ES")
        params = mock_conn_pool.execute.call_args[0][1]
        assert params == ("ES", 60)


# ---------------------------------------------------------------------------
# drain_pool
# ---------------------------------------------------------------------------


class TestDrainPool:
    """Cover drain_pool with both an active and an already-drained pool.

    Each test snapshots and restores `db._pool` so it doesn't leak into
    sibling tests that depend on get_conn / get_pool fixtures.
    """

    @pytest.fixture(autouse=True)
    def _snapshot_pool(self) -> Generator[None, None, None]:
        original = db._pool
        yield
        db._pool = original

    def test_drains_active_pool_and_resets_to_none(self) -> None:
        fake_pool = MagicMock()
        fake_pool.closed = False
        db._pool = fake_pool

        db.drain_pool()

        fake_pool.closeall.assert_called_once()
        assert db._pool is None

    def test_noop_when_pool_is_none(self) -> None:
        db._pool = None
        # Must not raise — the early-return guard handles this.
        db.drain_pool()
        assert db._pool is None

    def test_noop_when_pool_already_closed(self) -> None:
        fake_pool = MagicMock()
        fake_pool.closed = True
        db._pool = fake_pool

        db.drain_pool()

        fake_pool.closeall.assert_not_called()
        # _pool is left as the closed pool (not reset) — covered by code path.
        assert db._pool is fake_pool
