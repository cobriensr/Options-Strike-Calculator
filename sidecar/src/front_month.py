"""SQL builder for the front-month-contract CTE chain used across
``archive_query.py``.

Several DuckDB queries in ``archive_query`` need to resolve the
"front-month" contract for each trading day in a date range — the
top-volume outright contract per day. Before this module the chain
``filtered -> contract_volume -> front_contract -> fb`` was duplicated
verbatim across at least four call sites with cosmetic variation
(``ts_event`` vs ``ts_recv`` timestamp columns, with vs without an
explicit ``contract ASC`` tiebreak inside ``ROW_NUMBER``, ``size`` vs
``volume`` aggregation column). The drift was load-bearing: TBBO
queries pinned a deterministic tiebreak; OHLCV queries did not, relying
on Postgres/DuckDB row order which is not guaranteed.

This module exposes a single function — :func:`front_month_cte` —
returning a ``WITH ...`` SQL fragment that callers prepend to their own
``SELECT``. The fragment ends after the ``fb`` CTE definition, and a
trailing comma is included so the caller can add their own follow-up
CTEs without worrying about separators.

Greenfield design choice: the default tiebreak is ``'contract_asc'``.
The earlier ``contract_volume`` CTE breaks most ties via volume
aggregation, but for any true volume tie ``contract_asc`` provides a
deterministic ordering. The previously-implicit OHLCV behavior
("whichever row Postgres returned first") was non-deterministic and is
not a property worth preserving.
"""

from __future__ import annotations

from typing import Literal

# The canonical column produced by symbology join. ``symbol`` is what the
# OHLCV pipeline historically used; ``contract`` is what the TBBO
# pipeline used (same data, different alias). Callers stay readable when
# they can pick whichever name fits the surrounding query.
ContractColumn = Literal["symbol", "contract"]
TsColumn = Literal["ts_event", "ts_recv"]
Tiebreak = Literal["none", "contract_asc"]
# OHLCV bars carry ``volume``; TBBO trade rows carry ``size``. Both are
# summed inside ``contract_volume``; this is just the source column.
SizeColumn = Literal["volume", "size"]


def front_month_cte(
    symbol_like: str,
    parquet_path_param: str,
    symbology_path_param: str,
    date_filter_sql: str,
    *,
    ts_column: TsColumn = "ts_event",
    tiebreak: Tiebreak = "contract_asc",
    contract_col: ContractColumn = "symbol",
    size_col: SizeColumn = "volume",
    exclude_hyphenated: bool = False,
    extra_select_cols: tuple[str, ...] = (),
) -> str:
    """Return a ``WITH ... ,`` SQL fragment producing the front-month CTE
    chain ``filtered -> contract_volume -> front_contract -> fb``.

    The returned fragment is meant to be prepended to a caller-supplied
    final ``SELECT`` (or further CTEs followed by a final ``SELECT``).
    The fragment ends with a trailing comma after the ``fb`` CTE so
    chaining additional CTEs requires no glue characters from the caller.

    Args:
        symbol_like: SQL ``LIKE`` pattern for the symbology row's symbol
            column — e.g. ``'ES%'`` for the OHLCV ES front-month, or
            ``'NQ%'`` for the NQ TBBO front-month. Embedded as a SQL
            literal in the fragment; callers passing a runtime-derived
            value should bind via ``?`` and pass ``'?'`` here so DuckDB
            sees a positional parameter.
        parquet_path_param: SQL token referencing the parquet path for
            the bars/trades table. Typically the literal string ``'?'``
            so the caller binds it via ``execute(query, [...])``.
        symbology_path_param: SQL token referencing the symbology
            parquet path. Same convention as ``parquet_path_param``.
        date_filter_sql: SQL predicate (without the ``WHERE`` keyword)
            applied to ``CAST(date_trunc('day', bars.<ts_column>) AS DATE)``.
            Examples: ``"= ?::DATE"`` for a single date, or
            ``"BETWEEN ?::DATE AND ?::DATE"`` for a range. Bind values
            via the caller's ``execute(query, [...])`` parameter list in
            left-to-right order.
        ts_column: Which Databento timestamp column drives the day
            grouping. ``'ts_event'`` is the exchange-side event time
            (correct for OHLCV bars); ``'ts_recv'`` is the
            Databento-receive time (correct for TBBO trade ticks where
            ``ts_event`` is sometimes absent or coarse). Picking the
            wrong one shifts trades across UTC day boundaries and
            silently corrupts aggregates.
        tiebreak: Tiebreaker for ``ROW_NUMBER() ... ORDER BY total_vol DESC``.
            ``'contract_asc'`` (the default) appends ``, contract ASC``
            so two contracts with identical aggregated volume resolve
            deterministically by lexicographic contract name.
            ``'none'`` is the legacy OHLCV behavior — non-deterministic
            for tied volumes; preserved only for parity with old call
            sites until they migrate.
        contract_col: Output alias for the symbology ``symbol`` field
            inside the CTE chain. Use ``'symbol'`` for OHLCV-shaped
            queries, ``'contract'`` for TBBO-shaped queries. The
            ``USING`` clause in ``fb`` keys on this column, so it must
            match whatever name the caller's downstream CTEs expect to
            join on.
        size_col: Source column summed inside ``contract_volume``.
            ``'volume'`` for OHLCV bars (one row per bar, sums to
            day volume); ``'size'`` for TBBO trades (one row per
            trade, sums to day quantity).
        exclude_hyphenated: When ``True`` the ``filtered`` CTE also
            excludes hyphenated symbols (calendar spreads like
            ``'ESZ5-ESH6'``). OHLCV doesn't bother (its ``LIKE 'ES%'``
            plus ``strpos(' ') = 0`` already filters most spreads via
            CME naming convention); TBBO sees more spread tickers and
            needs the explicit guard.
        extra_select_cols: Extra column expressions to add to
            ``filtered``'s ``SELECT`` list. Each entry is a raw SQL
            expression — e.g. ``("bars.high", "bars.low")`` to keep
            high/low available in ``fb``. ``ts_<column>``, the size
            column, and ``contract`` are always selected; this kwarg
            adds *more*.

    Returns:
        SQL fragment beginning with ``WITH filtered AS (...)`` and
        ending with ``fb AS (...) ,`` (note trailing comma). Append
        further CTEs or replace the trailing comma with whitespace if
        ``fb`` is the last CTE before ``SELECT``.

    Notes on determinism:
        With ``tiebreak='contract_asc'`` the produced SQL is
        deterministic for any input — two callers running the same
        query on the same archive get the same row set. ``'none'`` is
        kept only because some pre-refactor tests pinned the
        accidental order; new code should prefer the default.
    """
    # The set of `bars.*` columns that flow into `filtered`. The size
    # column is always included (needed by `contract_volume`); the
    # timestamp column is always included (needed by `fb`'s downstream
    # consumers); anything else is caller-supplied.
    base_cols = [
        f"bars.{ts_column}",
        f"bars.{size_col}",
    ]
    base_cols.extend(extra_select_cols)
    select_list = ",\n                   ".join(base_cols)

    if tiebreak == "contract_asc":
        order_by = f"ORDER BY total_vol DESC, {contract_col} ASC"
    else:
        order_by = "ORDER BY total_vol DESC"

    hyphen_clause = (
        f"\n              AND strpos(sym.symbol, '-') = 0"
        if exclude_hyphenated
        else ""
    )

    return f"""WITH filtered AS (
            SELECT {select_list},
                   sym.symbol AS {contract_col},
                   CAST(date_trunc('day', bars.{ts_column}) AS DATE) AS day
            FROM read_parquet({parquet_path_param}) AS bars
            JOIN read_parquet({symbology_path_param}) AS sym USING (instrument_id)
            WHERE sym.symbol LIKE {symbol_like}
              AND strpos(sym.symbol, ' ') = 0{hyphen_clause}
              AND CAST(date_trunc('day', bars.{ts_column}) AS DATE)
                  {date_filter_sql}
        ),
        contract_volume AS (
            SELECT day, {contract_col}, SUM({size_col}) AS total_vol
            FROM filtered
            GROUP BY day, {contract_col}
        ),
        front_contract AS (
            SELECT day, {contract_col}
            FROM (
                SELECT day, {contract_col},
                       ROW_NUMBER() OVER (
                           PARTITION BY day {order_by}
                       ) AS rk
                FROM contract_volume
            ) ranked
            WHERE rk = 1
        ),
        fb AS (
            SELECT f.*
            FROM filtered f
            JOIN front_contract fc USING (day, {contract_col})
        ),"""
