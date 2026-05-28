"""asyncpg connection pool and bulk-insert helper.

A single pool serves every channel handler. Pool size is small (5)
because handlers batch writes — high concurrency is not the bottleneck;
batch size is.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable, Iterator, Sequence
from typing import Any, TypeVar

import asyncpg
import asyncpg.exceptions
import orjson

from config import settings
from logger_setup import log

# SQL identifiers are interpolated into the INSERT template as a literal
# (parameterized SQL doesn't accept table or column names as bind values).
# Today every caller passes module-level constants, so this regex is
# defense-in-depth: it stops a future handler from accidentally wiring a
# user-derived value (UW root symbol, request param, etc.) through these
# helpers and turning the bulk-insert path into a SQL injection sink.
# `re.ASCII` forces \w to match [A-Za-z0-9_] only — without the flag,
# \w matches Unicode word characters too, which would let an attacker
# sneak homoglyph-style identifiers past the gate.
_IDENTIFIER_RE = re.compile(r"^[A-Za-z_]\w*$", re.ASCII)


def _validate_identifier(name: str, *, kind: str) -> None:
    """Reject any string that isn't a safe unquoted Postgres identifier.

    Raises ValueError with a descriptive message so the failure surfaces
    loudly at the call site rather than as a Postgres syntax error miles
    away in the stack.
    """
    if not isinstance(name, str) or not _IDENTIFIER_RE.match(name):
        raise ValueError(
            f"Invalid SQL identifier ({kind}): {name!r}. "
            r"Must match ^[A-Za-z_]\w*$ (ASCII)"
        )

_pool: asyncpg.Pool | None = None

# Exception classes that signal a transient connection-class failure where
# the same call is safe to retry against a fresh pool connection. asyncpg
# raises ``TimeoutError`` (stdlib) when ``command_timeout`` fires; the
# ``PostgresConnectionError`` family covers Neon scale-down / restart
# fault paths; ``InterfaceError`` is raised when the underlying socket is
# already closed before we issue the next query.
_TRANSIENT_DB_EXC: tuple[type[BaseException], ...] = (
    TimeoutError,
    asyncpg.exceptions.PostgresConnectionError,
    asyncpg.exceptions.ConnectionDoesNotExistError,
    asyncpg.exceptions.ConnectionFailureError,
    asyncpg.exceptions.InterfaceError,
)

# Conservative defaults: 3 total attempts (initial + 2 retries) with a
# small per-retry backoff. Caps total added latency at ~2s so a flush
# that triggered a Neon restart still completes inside the handler's
# batch interval budget on the happy retry path.
_DB_RETRY_MAX_ATTEMPTS = 3
_DB_RETRY_BACKOFF_S: tuple[float, ...] = (0.5, 1.5)

T = TypeVar("T")


def is_transient_db_error(exc: BaseException) -> bool:
    """Return True iff ``exc`` is a connection-class failure worth retrying.

    Exported (not underscored) so ``sentry_setup.before_send`` can fingerprint
    the same set of exceptions that the retry wrapper considers transient —
    keeps the "collapse 7 channel stacks into one Sentry group" guarantee
    aligned with the actual retry policy.
    """
    return isinstance(exc, _TRANSIENT_DB_EXC)


async def _with_db_retry(
    label: str,
    func: Callable[[], Awaitable[T]],
) -> T:
    """Run ``func`` with exponential-ish backoff on transient DB errors.

    On a transient failure (`is_transient_db_error`), sleeps per
    ``_DB_RETRY_BACKOFF_S`` and re-invokes ``func``. The caller passes a
    fresh-acquire-and-transact closure so each attempt picks a new pool
    connection — required to recover from a connection the pool still
    thinks is alive but the wire underneath has been torn down by a Neon
    restart. Non-transient errors propagate immediately; the final
    transient error is re-raised after ``_DB_RETRY_MAX_ATTEMPTS``.
    """
    last_exc: BaseException | None = None
    for attempt in range(_DB_RETRY_MAX_ATTEMPTS):
        try:
            return await func()
        except BaseException as exc:
            if not is_transient_db_error(exc):
                raise
            last_exc = exc
            if attempt >= _DB_RETRY_MAX_ATTEMPTS - 1:
                break
            delay = _DB_RETRY_BACKOFF_S[
                min(attempt, len(_DB_RETRY_BACKOFF_S) - 1)
            ]
            log.warning(
                "db transient error; retrying",
                extra={
                    "label": label,
                    "attempt": attempt + 1,
                    "max_attempts": _DB_RETRY_MAX_ATTEMPTS,
                    "delay_s": delay,
                    "err_type": type(exc).__name__,
                    "err": str(exc),
                },
            )
            await asyncio.sleep(delay)
    # All retries exhausted — surface the original failure so Sentry's
    # ``before_send`` fingerprint can collapse cross-handler instances.
    assert last_exc is not None
    raise last_exc

# Postgres' wire-protocol parameter limit per statement is 32767 (signed
# int16). We cap a single multi-row INSERT at 30000 params to leave
# headroom against off-by-ones and any future reserved slots. Anything
# bigger gets sliced into multiple round-trips by `_chunked_rows`.
MAX_INSERT_PARAMS = 30000


def _build_multi_row_insert(
    table: str,
    cols: Sequence[str],
    rows: Sequence[tuple],
    *,
    suffix: str = "",
) -> tuple[str, list]:
    """Build (sql, flat_params) for a single multi-row INSERT.

    Produces ``INSERT INTO t (cols) VALUES ($1,$2,...), ($N+1,...), ...``
    with all rows' params flattened into one list, so a single
    ``conn.execute(sql, *flat_params)`` round-trip writes the entire
    batch — replacing asyncpg's ``executemany`` (which is N separate
    prepared-statement runs in one transaction, not pipelined).

    Caller is responsible for chunking — this builder rejects row sets
    whose total parameter count exceeds ``MAX_INSERT_PARAMS`` so a typo
    can't silently blow the Postgres wire-protocol limit at runtime.

    `suffix` is appended verbatim, e.g. ``"ON CONFLICT (...) DO NOTHING"``
    or ``"ON CONFLICT (...) DO UPDATE SET col = EXCLUDED.col"``.
    """
    _validate_identifier(table, kind="table")
    for col in cols:
        _validate_identifier(col, kind="column")
    params_per_row = len(cols)
    if not rows:
        return "", []
    total_params = len(rows) * params_per_row
    if total_params > MAX_INSERT_PARAMS:
        raise ValueError(
            f"_build_multi_row_insert: {len(rows)} rows x {params_per_row} cols = "
            f"{total_params} params exceeds MAX_INSERT_PARAMS={MAX_INSERT_PARAMS}"
        )
    col_list = ", ".join(cols)
    value_groups: list[str] = []
    flat: list = []
    for i, row in enumerate(rows):
        if len(row) != params_per_row:
            raise ValueError(
                f"_build_multi_row_insert: row {i} has {len(row)} values, "
                f"expected {params_per_row}"
            )
        start = i * params_per_row + 1
        placeholders = ", ".join(f"${start + j}" for j in range(params_per_row))
        value_groups.append(f"({placeholders})")
        flat.extend(row)
    sql = f"INSERT INTO {table} ({col_list}) VALUES {', '.join(value_groups)}"
    if suffix:
        sql += f" {suffix}"
    return sql, flat


def _chunked_rows(
    rows: Sequence[tuple],
    params_per_row: int,
) -> Iterator[Sequence[tuple]]:
    """Yield slices of ``rows`` capped so each chunk fits MAX_INSERT_PARAMS.

    A no-op pass-through when ``rows`` already fits in one statement; for
    huge batches it splits into multiple round-trips automatically so
    callers never have to reason about the wire-protocol limit.
    """
    if not rows:
        return
    if params_per_row <= 0:
        raise ValueError("params_per_row must be positive")
    max_per_chunk = MAX_INSERT_PARAMS // params_per_row
    if max_per_chunk == 0:
        # A single row already exceeds the limit — surface immediately
        # rather than yielding an unflushable chunk.
        raise ValueError(
            f"_chunked_rows: params_per_row={params_per_row} exceeds "
            f"MAX_INSERT_PARAMS={MAX_INSERT_PARAMS} for a single row"
        )
    for start in range(0, len(rows), max_per_chunk):
        yield rows[start : start + max_per_chunk]


def _parse_insert_status(status: str | None) -> int:
    """Pull the row count out of asyncpg's ``"INSERT 0 N"`` status string.

    asyncpg returns the SQL command-tag as a str like ``"INSERT 0 247"``
    where the trailing integer is the rows actually written. Returns 0
    on an unparseable / missing status so callers don't have to special-
    case mocks.
    """
    if not status:
        return 0
    parts = status.split()
    if len(parts) < 3 or parts[0] != "INSERT":
        return 0
    try:
        return int(parts[-1])
    except ValueError:
        return 0


def _orjson_dumps_str(v: Any) -> str:
    """orjson returns bytes; the asyncpg text codec wants str."""
    return orjson.dumps(v).decode("utf-8")


async def _init_connection(conn: asyncpg.Connection) -> None:
    """Per-connection setup. Register codecs that map Python dict/list
    directly to JSONB / JSON columns via orjson — avoids manual
    ``json.dumps`` at every call site.
    """
    await conn.set_type_codec(
        "jsonb",
        encoder=_orjson_dumps_str,
        decoder=orjson.loads,
        schema="pg_catalog",
    )
    await conn.set_type_codec(
        "json",
        encoder=_orjson_dumps_str,
        decoder=orjson.loads,
        schema="pg_catalog",
    )


async def init_pool() -> asyncpg.Pool:
    """Create the global pool. Idempotent."""
    global _pool
    if _pool is not None:
        return _pool
    # 5 handlers x 2 + headroom for health check + manual queries.
    _pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=2,
        max_size=10,
        command_timeout=30,
        init=_init_connection,
    )
    log.info("asyncpg pool ready (min=2 max=10)")
    return _pool


def get_pool() -> asyncpg.Pool:
    """Return the live pool. Raises if init_pool was not called."""
    if _pool is None:
        raise RuntimeError("Pool not initialized. Call init_pool() first.")
    return _pool


async def close_pool() -> None:
    """Drain and close the pool. Safe to call on shutdown."""
    global _pool
    if _pool is None:
        return
    await _pool.close()
    _pool = None
    log.info("asyncpg pool closed")


async def bulk_insert_ignore_conflict(
    table: str,
    columns: list[str],
    rows: list[tuple[Any, ...]],
    conflict_cols: list[str],
) -> int:
    """Insert many rows with `ON CONFLICT (...) DO NOTHING`.

    Issues one multi-row INSERT per chunk (chunked at
    ``MAX_INSERT_PARAMS`` so a 30k+ row batch still completes), giving
    one network round-trip per chunk instead of N. asyncpg's
    ``executemany`` is NOT pipelined — it issues N separate prepared-
    statement runs in one transaction, so a 500-row batch x ~10ms RTT to
    Neon was ~5s per flush, exceeding the default 2s
    ``WS_BATCH_INTERVAL_MS`` ceiling.

    Returns the actual rows inserted, parsed from asyncpg's
    ``"INSERT 0 N"`` status string. With ON CONFLICT DO NOTHING the
    returned count can be < ``len(rows)`` when duplicates were skipped
    — handler call sites use this to compute a dedup rate alongside
    ``write_attempted``.
    """
    if not rows:
        return 0

    for cc in conflict_cols:
        _validate_identifier(cc, kind="conflict_col")
    conflict_clause = ", ".join(conflict_cols)
    suffix = f"ON CONFLICT ({conflict_clause}) DO NOTHING"

    # Single explicit transaction so a chunk-mid failure rolls the
    # whole batch. Most flow-alert rows are independent so this rarely
    # matters, but it keeps semantics tight if a malformed payload
    # sneaks past the handler's _transform validator.
    #
    # Wrapped in ``_with_db_retry`` so a transient Neon-side connection
    # tear-down (scale-down, restart, admin terminate) absorbs into a
    # silent retry — ON CONFLICT DO NOTHING makes the redo idempotent.
    async def _attempt() -> int:
        pool = get_pool()
        total_inserted = 0
        async with pool.acquire() as conn, conn.transaction():
            for chunk in _chunked_rows(rows, len(columns)):
                sql, flat_params = _build_multi_row_insert(
                    table, columns, chunk, suffix=suffix
                )
                status = await conn.execute(sql, *flat_params)
                total_inserted += _parse_insert_status(status)
        return total_inserted

    return await _with_db_retry(f"bulk_insert_ignore_conflict:{table}", _attempt)


async def bulk_upsert_replace(
    table: str,
    columns: list[str],
    rows: list[tuple[Any, ...]],
    conflict_cols: list[str],
) -> int:
    """Insert many rows with ``ON CONFLICT (...) DO UPDATE`` — every
    non-conflict column is overwritten with the EXCLUDED value.

    Use this for tables where the upstream value at a unique key can
    legitimately change after the fact (UW restates aggregated GEX
    intraday — same root cause as the vega_flow_etf restatement we hit
    on 2026-05-01). Last write wins per (conflict_cols) tuple.

    Issues one multi-row INSERT per chunk (chunked at
    ``MAX_INSERT_PARAMS``). Per-chunk Postgres acquires row locks in
    tuple-list order deterministically, which is the contract the
    GexStrikeExpiry handler's pre-flush sort relies on to avoid AB-BA
    deadlocks against the REST cron writer.

    Returns the count parsed from asyncpg's ``"INSERT 0 N"`` status
    string. For ON CONFLICT DO UPDATE, Postgres reports N as the rows
    inserted OR updated — i.e. every input row touches the table, so
    in steady state this equals ``len(rows)``.
    """
    if not rows:
        return 0

    for cc in conflict_cols:
        _validate_identifier(cc, kind="conflict_col")
    update_cols = [c for c in columns if c not in conflict_cols]
    if not update_cols:
        # Pathological: every column is a conflict key. Falling back to
        # DO NOTHING preserves intent (no value to overwrite anyway).
        return await bulk_insert_ignore_conflict(table, columns, rows, conflict_cols)

    conflict_clause = ", ".join(conflict_cols)
    update_clause = ", ".join(f"{c} = EXCLUDED.{c}" for c in update_cols)
    suffix = f"ON CONFLICT ({conflict_clause}) DO UPDATE SET {update_clause}"

    # See bulk_insert_ignore_conflict for retry rationale. ON CONFLICT
    # DO UPDATE is last-write-wins, so retrying a partially-applied batch
    # converges to the same final state.
    async def _attempt() -> int:
        pool = get_pool()
        total_inserted = 0
        async with pool.acquire() as conn, conn.transaction():
            for chunk in _chunked_rows(rows, len(columns)):
                sql, flat_params = _build_multi_row_insert(
                    table, columns, chunk, suffix=suffix
                )
                status = await conn.execute(sql, *flat_params)
                total_inserted += _parse_insert_status(status)
        return total_inserted

    return await _with_db_retry(f"bulk_upsert_replace:{table}", _attempt)
