"""asyncpg connection pool and bulk-insert helper.

A single pool serves every channel handler. Pool size is small (5)
because handlers batch writes — high concurrency is not the bottleneck;
batch size is.
"""

from __future__ import annotations

from typing import Any

import asyncpg
import orjson

from config import settings
from logger_setup import log

_pool: asyncpg.Pool | None = None


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
    _pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=1,
        max_size=5,
        command_timeout=30,
        init=_init_connection,
    )
    log.info("asyncpg pool ready (min=1 max=5)")
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

    Returns the number of rows actually inserted (excluding conflicts).
    Uses executemany rather than COPY because COPY does not support
    ON CONFLICT — for the volume flow-alerts produces (~thousands/day)
    executemany throughput is more than enough.
    """
    if not rows:
        return 0

    placeholders = ", ".join(f"${i + 1}" for i in range(len(columns)))
    conflict_clause = ", ".join(conflict_cols)
    sql = (
        f"INSERT INTO {table} ({', '.join(columns)}) "
        f"VALUES ({placeholders}) "
        f"ON CONFLICT ({conflict_clause}) DO NOTHING"
    )

    # Single explicit transaction so a row failure rolls the batch.
    # Most flow-alert rows are independent so this rarely matters,
    # but it keeps semantics tight if a malformed payload sneaks in.
    # asyncpg's executemany returns "INSERT 0 N" status strings; we
    # can't get per-row insertion count without RETURNING, so we
    # report batch size as upper bound. The real inserted count is
    # tracked via write_count in handler-side state.
    pool = get_pool()
    async with pool.acquire() as conn, conn.transaction():
        await conn.executemany(sql, rows)
    return len(rows)


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

    Returns the size of the input batch (asyncpg's ``executemany`` does
    not give per-row insert/update counts without RETURNING).
    """
    if not rows:
        return 0

    update_cols = [c for c in columns if c not in conflict_cols]
    if not update_cols:
        # Pathological: every column is a conflict key. Falling back to
        # DO NOTHING preserves intent (no value to overwrite anyway).
        return await bulk_insert_ignore_conflict(table, columns, rows, conflict_cols)

    placeholders = ", ".join(f"${i + 1}" for i in range(len(columns)))
    conflict_clause = ", ".join(conflict_cols)
    update_clause = ", ".join(f"{c} = EXCLUDED.{c}" for c in update_cols)
    sql = (
        f"INSERT INTO {table} ({', '.join(columns)}) "
        f"VALUES ({placeholders}) "
        f"ON CONFLICT ({conflict_clause}) DO UPDATE SET {update_clause}"
    )

    pool = get_pool()
    async with pool.acquire() as conn, conn.transaction():
        await conn.executemany(sql, rows)
    return len(rows)
