"""Unit tests for the multi-row INSERT path in src/db.py.

Phase 2 of the uw-stream-hardening spec replaced asyncpg's
``executemany`` (N separate prepared-statement runs in one transaction)
with a single multi-row INSERT per chunk built by
``_build_multi_row_insert``. These tests cover the builder, the
chunker, and the two public ``bulk_insert_*`` helpers that wrap them —
verifying we issue one ``conn.execute`` per chunk instead of one per
row.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import asyncpg.exceptions
import pytest

from db import (
    MAX_INSERT_PARAMS,
    _build_multi_row_insert,
    _chunked_rows,
    _parse_insert_status,
    bulk_insert_ignore_conflict,
    bulk_upsert_replace,
    is_transient_db_error,
)

# ----------------------------------------------------------------------
# _build_multi_row_insert
# ----------------------------------------------------------------------


class TestBuildMultiRowInsert:
    def test_single_row_one_value_group(self):
        sql, params = _build_multi_row_insert("t", ("a", "b", "c"), [(1, 2, 3)])
        assert sql == "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)"
        assert params == [1, 2, 3]

    def test_500_rows_each_get_their_own_value_group(self):
        cols = ("a", "b", "c", "d")
        rows = [(i, i + 1, i + 2, i + 3) for i in range(500)]
        sql, params = _build_multi_row_insert("t", cols, rows)
        # 500 grouped placeholder sets in the SQL.
        assert sql.count("VALUES (") == 1
        # Comma-separated value groups: count opening parens after VALUES.
        # The 500 groups all look like `($k, $k+1, ...)`.
        groups = sql.split("VALUES ", 1)[1]
        assert groups.count("(") == 500
        # Flat params length = rows x cols.
        assert len(params) == 500 * 4

    def test_500_rows_placeholders_are_sequentially_numbered(self):
        cols = ("a", "b")
        rows = [(i, i + 1) for i in range(500)]
        sql, _params = _build_multi_row_insert("t", cols, rows)
        # First and last placeholders are $1 and $1000 with no gaps.
        assert "($1, $2)" in sql
        assert "($999, $1000)" in sql
        # Every $N from $1 to $1000 appears exactly once in the SQL.
        for n in range(1, 1001):
            assert f"${n}" in sql, f"placeholder $n={n} missing"

    def test_empty_rows_returns_empty(self):
        sql, params = _build_multi_row_insert("t", ("a", "b"), [])
        assert sql == ""
        assert params == []

    def test_wrong_column_count_raises_with_row_index(self):
        with pytest.raises(ValueError) as exc:
            _build_multi_row_insert(
                "t",
                ("a", "b", "c"),
                [(1, 2, 3), (4, 5)],  # row 1 short
            )
        msg = str(exc.value)
        assert "row 1" in msg
        assert "2 values" in msg
        assert "expected 3" in msg

    def test_total_params_exceeds_limit_raises(self):
        # 7501 rows x 4 cols = 30004 params > MAX_INSERT_PARAMS=30000.
        cols = ("a", "b", "c", "d")
        rows = [(i, i, i, i) for i in range(7501)]
        with pytest.raises(ValueError) as exc:
            _build_multi_row_insert("t", cols, rows)
        msg = str(exc.value)
        assert "30004" in msg  # total params reported
        assert str(MAX_INSERT_PARAMS) in msg

    def test_suffix_is_appended_verbatim(self):
        suffix = "ON CONFLICT (a) DO NOTHING"
        sql, _params = _build_multi_row_insert("t", ("a", "b"), [(1, 2)], suffix=suffix)
        assert sql.endswith(f" {suffix}")

    def test_no_suffix_no_trailing_space(self):
        sql, _params = _build_multi_row_insert("t", ("a",), [(1,)])
        assert not sql.endswith(" ")


# ----------------------------------------------------------------------
# _chunked_rows
# ----------------------------------------------------------------------


class TestChunkedRows:
    def test_smaller_than_chunk_yields_one_chunk(self):
        rows = [(i,) for i in range(10)]
        chunks = list(_chunked_rows(rows, params_per_row=1))
        assert len(chunks) == 1
        assert list(chunks[0]) == rows

    def test_exactly_chunk_size_yields_one_chunk(self):
        # MAX_INSERT_PARAMS / 1 = 30000 rows fits in one chunk.
        rows = [(i,) for i in range(MAX_INSERT_PARAMS)]
        chunks = list(_chunked_rows(rows, params_per_row=1))
        assert len(chunks) == 1
        assert len(chunks[0]) == MAX_INSERT_PARAMS

    def test_double_chunk_size_yields_two_equal_chunks(self):
        # params_per_row=2 → max_per_chunk = 15000.
        rows = [(i, i) for i in range(30000)]
        chunks = list(_chunked_rows(rows, params_per_row=2))
        assert len(chunks) == 2
        assert len(chunks[0]) == 15000
        assert len(chunks[1]) == 15000

    def test_zero_rows_yields_nothing(self):
        chunks = list(_chunked_rows([], params_per_row=4))
        assert chunks == []

    def test_invalid_params_per_row_raises(self):
        with pytest.raises(ValueError):
            list(_chunked_rows([(1,)], params_per_row=0))

    def test_single_row_too_wide_raises(self):
        # A single row with > MAX_INSERT_PARAMS params can't be flushed.
        with pytest.raises(ValueError):
            list(_chunked_rows([(1,)], params_per_row=MAX_INSERT_PARAMS + 1))


# ----------------------------------------------------------------------
# _parse_insert_status
# ----------------------------------------------------------------------


class TestParseInsertStatus:
    def test_normal_status(self):
        assert _parse_insert_status("INSERT 0 247") == 247

    def test_zero_status(self):
        assert _parse_insert_status("INSERT 0 0") == 0

    def test_none_returns_zero(self):
        assert _parse_insert_status(None) == 0

    def test_empty_returns_zero(self):
        assert _parse_insert_status("") == 0

    def test_unrelated_command_returns_zero(self):
        assert _parse_insert_status("UPDATE 5") == 0

    def test_malformed_returns_zero(self):
        assert _parse_insert_status("INSERT 0 not_a_number") == 0


# ----------------------------------------------------------------------
# bulk_insert_ignore_conflict — single round-trip per chunk
# ----------------------------------------------------------------------


def _mock_pool_with_conn(conn: MagicMock) -> MagicMock:
    """Build a mock asyncpg pool whose acquire() returns a context manager
    yielding the given connection, and whose conn.transaction() is also
    an async context manager. asyncpg's ``async with pool.acquire() as
    conn, conn.transaction():`` requires both halves to be async CMs.
    """
    pool = MagicMock()

    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=False)
    pool.acquire = MagicMock(return_value=acquire_cm)

    txn_cm = MagicMock()
    txn_cm.__aenter__ = AsyncMock(return_value=None)
    txn_cm.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=txn_cm)

    return pool


class TestBulkInsertIgnoreConflict:
    @pytest.mark.asyncio
    async def test_single_row_calls_execute_once_not_executemany(self):
        conn = MagicMock()
        conn.execute = AsyncMock(return_value="INSERT 0 1")
        conn.executemany = AsyncMock()  # presence trap — should NOT be called
        pool = _mock_pool_with_conn(conn)

        with patch("db.get_pool", return_value=pool):
            result = await bulk_insert_ignore_conflict(
                table="t",
                columns=["a", "b", "c"],
                rows=[(1, 2, 3)],
                conflict_cols=["a"],
            )

        # Exactly one round-trip, NOT N.
        assert conn.execute.await_count == 1
        conn.executemany.assert_not_awaited()

        sql, *args = conn.execute.await_args.args
        assert sql.startswith("INSERT INTO t (a, b, c) VALUES")
        assert "ON CONFLICT (a) DO NOTHING" in sql
        assert list(args) == [1, 2, 3]
        # Phase 3 / M2: returns the parsed insert count from the
        # ``"INSERT 0 N"`` status string, not the input batch size.
        assert result == 1

    @pytest.mark.asyncio
    async def test_500_rows_one_execute_call_with_500_value_groups(self):
        conn = MagicMock()
        conn.execute = AsyncMock(return_value="INSERT 0 500")
        pool = _mock_pool_with_conn(conn)

        cols = ["a", "b", "c", "d"]
        rows = [(i, i, i, i) for i in range(500)]

        with patch("db.get_pool", return_value=pool):
            await bulk_insert_ignore_conflict(
                table="t",
                columns=cols,
                rows=rows,
                conflict_cols=["a"],
            )

        assert conn.execute.await_count == 1
        sql, *args = conn.execute.await_args.args
        # 500 value groups, 500 x 4 = 2000 params.
        groups = sql.split("VALUES ", 1)[1]
        # Strip suffix before counting groups.
        body = groups.split(" ON CONFLICT ", 1)[0]
        assert body.count("(") == 500
        assert len(args) == 500 * 4

    @pytest.mark.asyncio
    async def test_30001_rows_with_4_cols_splits_into_multiple_chunks(self):
        conn = MagicMock()
        conn.execute = AsyncMock(return_value="INSERT 0 7500")
        pool = _mock_pool_with_conn(conn)

        cols = ["a", "b", "c", "d"]
        # MAX_INSERT_PARAMS=30000 / 4 cols = 7500 rows/chunk.
        # 30001 rows → ceil(30001/7500) = 5 chunks.
        rows = [(i, i, i, i) for i in range(30001)]

        with patch("db.get_pool", return_value=pool):
            await bulk_insert_ignore_conflict(
                table="t",
                columns=cols,
                rows=rows,
                conflict_cols=["a"],
            )

        assert conn.execute.await_count == 5

        # Every chunk's flat-param count must be ≤ MAX_INSERT_PARAMS.
        for call in conn.execute.await_args_list:
            _sql, *params = call.args
            assert len(params) <= MAX_INSERT_PARAMS

        # Sum of all chunk param counts = 30001 x 4 = 120004.
        total_params = sum(
            len(call.args) - 1  # subtract the SQL string positional
            for call in conn.execute.await_args_list
        )
        assert total_params == 30001 * 4


# ----------------------------------------------------------------------
# bulk_upsert_replace — same single-round-trip-per-chunk behavior
# ----------------------------------------------------------------------


class TestBulkUpsertReplace:
    @pytest.mark.asyncio
    async def test_single_row_uses_one_execute_with_do_update_clause(self):
        conn = MagicMock()
        conn.execute = AsyncMock(return_value="INSERT 0 1")
        conn.executemany = AsyncMock()  # presence trap
        pool = _mock_pool_with_conn(conn)

        with patch("db.get_pool", return_value=pool):
            result = await bulk_upsert_replace(
                table="t",
                columns=["a", "b", "c"],
                rows=[(1, 2, 3)],
                conflict_cols=["a"],
            )

        assert conn.execute.await_count == 1
        conn.executemany.assert_not_awaited()
        sql = conn.execute.await_args.args[0]
        assert "ON CONFLICT (a) DO UPDATE SET" in sql
        assert "b = EXCLUDED.b" in sql
        assert "c = EXCLUDED.c" in sql
        # Conflict key MUST NOT appear in SET clause — Postgres rejects
        # `"a" specified more than once` when a conflict key is also
        # listed in DO UPDATE SET.
        assert "a = EXCLUDED.a" not in sql
        assert result == 1

    @pytest.mark.asyncio
    async def test_empty_rows_short_circuits_without_pool_access(self):
        # With no rows, we don't even reach get_pool — covers the
        # early-return guard rail.
        with patch("db.get_pool") as mock_pool:
            result = await bulk_upsert_replace(
                table="t",
                columns=["a", "b"],
                rows=[],
                conflict_cols=["a"],
            )
        assert result == 0
        mock_pool.assert_not_called()

    @pytest.mark.asyncio
    async def test_all_columns_are_conflict_keys_falls_back_to_do_nothing(self):
        # Pathological case: every column is a conflict key, so there's
        # nothing to UPDATE. Spec falls back to bulk_insert_ignore_conflict.
        conn = MagicMock()
        conn.execute = AsyncMock(return_value="INSERT 0 1")
        pool = _mock_pool_with_conn(conn)

        with patch("db.get_pool", return_value=pool):
            await bulk_upsert_replace(
                table="t",
                columns=["a", "b"],
                rows=[(1, 2)],
                conflict_cols=["a", "b"],
            )

        sql = conn.execute.await_args.args[0]
        assert "DO NOTHING" in sql
        assert "DO UPDATE" not in sql


# ----------------------------------------------------------------------
# Phase 3 / M2 — honest insert-count reporting from asyncpg's status string
# ----------------------------------------------------------------------


class TestBulkInsertReturnsParsedCount:
    @pytest.mark.asyncio
    async def test_bulk_insert_returns_inserted_count_from_status_string(self):
        """``conn.execute`` returns ``"INSERT 0 N"``; the helper must
        return N (the rows actually written) rather than ``len(rows)``.

        This is what makes ``write_count`` trustworthy as a dedup-rate
        signal — under ON CONFLICT DO NOTHING, repeated rows are silently
        skipped and only the parsed N reflects reality.
        """
        conn = MagicMock()
        # Input batch is 1000 rows but only 247 actually inserted
        # (the rest were ON CONFLICT DO NOTHING duplicates).
        conn.execute = AsyncMock(return_value="INSERT 0 247")
        pool = _mock_pool_with_conn(conn)

        cols = ["a", "b"]
        rows = [(i, i) for i in range(1000)]

        with patch("db.get_pool", return_value=pool):
            result = await bulk_insert_ignore_conflict(
                table="t",
                columns=cols,
                rows=rows,
                conflict_cols=["a"],
            )

        assert result == 247

    @pytest.mark.asyncio
    async def test_bulk_insert_aggregates_inserted_count_across_chunks(self):
        """30001 rows in a 4-col table splits into 5 chunks (7500 each
        + 1 trailing). The helper must SUM the per-chunk parsed counts
        — a single chunk's status would lose the others.
        """
        conn = MagicMock()
        # First 4 chunks are 7500 rows, last is 1 row. Mock returns
        # status strings that say all rows landed.
        conn.execute = AsyncMock(
            side_effect=[
                "INSERT 0 7500",
                "INSERT 0 7500",
                "INSERT 0 7500",
                "INSERT 0 7500",
                "INSERT 0 1",
            ],
        )
        pool = _mock_pool_with_conn(conn)

        cols = ["a", "b", "c", "d"]
        rows = [(i, i, i, i) for i in range(30001)]

        with patch("db.get_pool", return_value=pool):
            result = await bulk_insert_ignore_conflict(
                table="t",
                columns=cols,
                rows=rows,
                conflict_cols=["a"],
            )

        # All chunks reported full inserts → sum is 30001.
        assert result == 30001
        assert conn.execute.await_count == 5

    @pytest.mark.asyncio
    async def test_bulk_insert_returns_zero_when_status_is_unparseable(self):
        """Defensive: a mock or future asyncpg version that returns ``""``
        (or something other than ``INSERT 0 N``) shouldn't blow up the
        flush — the helper just records 0 inserted and moves on.
        """
        conn = MagicMock()
        conn.execute = AsyncMock(return_value="")
        pool = _mock_pool_with_conn(conn)

        with patch("db.get_pool", return_value=pool):
            result = await bulk_insert_ignore_conflict(
                table="t",
                columns=["a"],
                rows=[(1,), (2,), (3,)],
                conflict_cols=["a"],
            )

        assert result == 0

    @pytest.mark.asyncio
    async def test_bulk_upsert_replace_returns_parsed_count(self):
        """ON CONFLICT DO UPDATE: Postgres reports N as inserted+updated;
        the helper still parses + returns it the same way.
        """
        conn = MagicMock()
        conn.execute = AsyncMock(return_value="INSERT 0 5")
        pool = _mock_pool_with_conn(conn)

        with patch("db.get_pool", return_value=pool):
            result = await bulk_upsert_replace(
                table="t",
                columns=["a", "b"],
                rows=[(i, i + 1) for i in range(5)],
                conflict_cols=["a"],
            )

        assert result == 5


# ----------------------------------------------------------------------
# Transient-error retry behavior — added 2026-05-14 after a Neon scale-down
# produced 7+ Sentry groups from one event because flush sites raised
# without any reconnect / retry path. See sentry_setup._before_send for
# the matching fingerprint collapse.
# ----------------------------------------------------------------------


class TestIsTransientDbError:
    def test_stdlib_timeout_is_transient(self):
        assert is_transient_db_error(TimeoutError("command_timeout"))

    def test_asyncpg_interface_error_is_transient(self):
        assert is_transient_db_error(asyncpg.exceptions.InterfaceError("connection closed"))

    def test_asyncpg_connection_does_not_exist_is_transient(self):
        assert is_transient_db_error(asyncpg.exceptions.ConnectionDoesNotExistError("57P01"))

    def test_value_error_is_not_transient(self):
        assert not is_transient_db_error(ValueError("bad row"))

    def test_runtime_error_is_not_transient(self):
        assert not is_transient_db_error(RuntimeError("logic bug"))


class TestBulkInsertRetry:
    @pytest.mark.asyncio
    async def test_retries_after_transient_timeout_then_succeeds(self):
        """One stdlib TimeoutError on the first attempt — second attempt
        succeeds. ``conn.execute`` is called twice; the function returns
        the second attempt's parsed count.
        """
        conn = MagicMock()
        conn.execute = AsyncMock(side_effect=[TimeoutError("command_timeout"), "INSERT 0 1"])
        pool = _mock_pool_with_conn(conn)

        with patch("db.get_pool", return_value=pool), patch("asyncio.sleep", new=AsyncMock()):
            result = await bulk_insert_ignore_conflict(
                table="t",
                columns=["a", "b"],
                rows=[(1, 2)],
                conflict_cols=["a"],
            )

        assert result == 1
        assert conn.execute.await_count == 2

    @pytest.mark.asyncio
    async def test_retries_acquires_fresh_connection_each_attempt(self):
        """The retry must hit ``pool.acquire`` again — recovering from a
        stale pool connection is the whole point. Counts acquire() calls.
        """
        conn = MagicMock()
        conn.execute = AsyncMock(
            side_effect=[
                asyncpg.exceptions.ConnectionDoesNotExistError("57P01"),
                "INSERT 0 1",
            ]
        )
        pool = _mock_pool_with_conn(conn)

        with patch("db.get_pool", return_value=pool), patch("asyncio.sleep", new=AsyncMock()):
            await bulk_insert_ignore_conflict(
                table="t",
                columns=["a", "b"],
                rows=[(1, 2)],
                conflict_cols=["a"],
            )

        # Attempt 1 acquires, fails on execute. Attempt 2 acquires again.
        assert pool.acquire.call_count == 2

    @pytest.mark.asyncio
    async def test_gives_up_after_max_attempts_and_reraises(self):
        """Sustained transient failure: helper re-raises the last
        TimeoutError after ``_DB_RETRY_MAX_ATTEMPTS`` attempts.
        """
        conn = MagicMock()
        conn.execute = AsyncMock(side_effect=TimeoutError("persistent"))
        pool = _mock_pool_with_conn(conn)

        with (
            patch("db.get_pool", return_value=pool),
            patch("asyncio.sleep", new=AsyncMock()),
            pytest.raises(TimeoutError),
        ):
            await bulk_insert_ignore_conflict(
                table="t",
                columns=["a", "b"],
                rows=[(1, 2)],
                conflict_cols=["a"],
            )

        # 3 attempts total = 3 execute calls.
        assert conn.execute.await_count == 3

    @pytest.mark.asyncio
    async def test_non_transient_error_does_not_retry(self):
        """A plain ValueError (e.g. row-shape mismatch) must NOT trigger
        retry — retrying a logic bug just amplifies cost.
        """
        conn = MagicMock()
        conn.execute = AsyncMock(side_effect=ValueError("bad row"))
        pool = _mock_pool_with_conn(conn)

        with (
            patch("db.get_pool", return_value=pool),
            patch("asyncio.sleep", new=AsyncMock()) as sleep_mock,
            pytest.raises(ValueError),
        ):
            await bulk_insert_ignore_conflict(
                table="t",
                columns=["a", "b"],
                rows=[(1, 2)],
                conflict_cols=["a"],
            )

        # Exactly one attempt, no backoff sleep.
        assert conn.execute.await_count == 1
        sleep_mock.assert_not_awaited()


class TestBulkUpsertRetry:
    @pytest.mark.asyncio
    async def test_upsert_retries_on_transient_and_returns_final_count(self):
        """``bulk_upsert_replace`` shares the same retry wrapper.
        First attempt blows up with an InterfaceError (socket already
        closed); second attempt returns INSERT 0 3.
        """
        conn = MagicMock()
        conn.execute = AsyncMock(
            side_effect=[
                asyncpg.exceptions.InterfaceError("connection is closed"),
                "INSERT 0 3",
            ]
        )
        pool = _mock_pool_with_conn(conn)

        with patch("db.get_pool", return_value=pool), patch("asyncio.sleep", new=AsyncMock()):
            result = await bulk_upsert_replace(
                table="t",
                columns=["a", "b"],
                rows=[(i, i + 1) for i in range(3)],
                conflict_cols=["a"],
            )

        assert result == 3
        assert conn.execute.await_count == 2
