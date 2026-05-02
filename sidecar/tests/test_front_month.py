"""Unit tests for :mod:`front_month` — the SQL builder for the
``filtered -> contract_volume -> front_contract -> fb`` CTE chain.

These tests assert on the rendered SQL fragment text rather than running
DuckDB against a fixture. The integration tests in
``test_archive_query.py`` cover the runtime behavior end-to-end via the
adopting call sites; here we only verify that each parameter
combination produces the expected SQL shape, so any future drift caught
in code review surfaces as a clear text-diff.
"""

from __future__ import annotations

import duckdb
import pytest

from front_month import front_month_cte


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------


def test_defaults_emit_canonical_chain() -> None:
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
    )

    # Each of the four canonical CTE names must appear as a defined
    # name (``X AS (``) so the chain is structurally complete.
    assert "WITH filtered AS (" in sql
    assert "contract_volume AS (" in sql
    assert "front_contract AS (" in sql
    assert "fb AS (" in sql


def test_defaults_use_ts_event_and_volume() -> None:
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
    )

    assert "bars.ts_event" in sql
    assert "bars.volume" in sql
    # The TBBO-only columns must NOT leak in by default.
    assert "bars.ts_recv" not in sql
    assert "bars.size" not in sql


def test_defaults_use_contract_asc_tiebreak() -> None:
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
    )

    assert "ORDER BY total_vol DESC, symbol ASC" in sql


def test_defaults_omit_hyphen_clause() -> None:
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
    )

    assert "strpos(sym.symbol, ' ') = 0" in sql
    assert "strpos(sym.symbol, '-') = 0" not in sql


# ---------------------------------------------------------------------------
# Each parameter, exercised in isolation
# ---------------------------------------------------------------------------


def test_ts_recv_replaces_ts_event_everywhere() -> None:
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
        ts_column="ts_recv",
    )

    assert "bars.ts_recv" in sql
    assert "bars.ts_event" not in sql
    # ``ts_recv`` flows through to the ``date_trunc`` filter clause too,
    # not just the SELECT list.
    assert "date_trunc('day', bars.ts_recv)" in sql


def test_tiebreak_none_omits_contract_asc() -> None:
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
        tiebreak="none",
    )

    assert "ORDER BY total_vol DESC" in sql
    assert "contract ASC" not in sql
    assert "symbol ASC" not in sql


def test_contract_col_alias_and_join_keys() -> None:
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
        contract_col="contract",
    )

    assert "sym.symbol AS contract" in sql
    assert "USING (day, contract)" in sql
    # When the alias is ``contract`` the tiebreak must follow.
    assert "ORDER BY total_vol DESC, contract ASC" in sql
    # No accidental references to the OHLCV alias.
    assert "AS symbol" not in sql


def test_size_col_swap() -> None:
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
        size_col="size",
    )

    assert "bars.size" in sql
    assert "SUM(size) AS total_vol" in sql
    assert "bars.volume" not in sql


def test_exclude_hyphenated_adds_strpos_dash_clause() -> None:
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
        exclude_hyphenated=True,
    )

    assert "strpos(sym.symbol, ' ') = 0" in sql
    assert "strpos(sym.symbol, '-') = 0" in sql


def test_extra_select_cols_propagate_into_filtered() -> None:
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
        extra_select_cols=("bars.open", "bars.high", "bars.low", "bars.close"),
    )

    for col in ("bars.open", "bars.high", "bars.low", "bars.close"):
        assert col in sql


def test_date_filter_between_range() -> None:
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="BETWEEN ?::DATE AND ?::DATE",
    )

    assert "BETWEEN ?::DATE AND ?::DATE" in sql


def test_symbol_like_inlined_literal() -> None:
    sql = front_month_cte(
        symbol_like="'NQ%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
    )

    assert "LIKE 'NQ%'" in sql


# ---------------------------------------------------------------------------
# Combinations matching the actual archive_query call sites
# ---------------------------------------------------------------------------


def test_ohlcv_batch_shape() -> None:
    """Shape used by ``day_features_batch`` / ``day_summary_batch`` /
    ``day_summary_prediction_batch`` after Phase 2b adoption.
    """
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="BETWEEN ?::DATE AND ?::DATE",
        extra_select_cols=(
            "bars.open",
            "bars.high",
            "bars.low",
            "bars.close",
        ),
    )

    assert "bars.ts_event" in sql
    assert "bars.volume" in sql
    assert "USING (day, symbol)" in sql
    assert "ORDER BY total_vol DESC, symbol ASC" in sql
    assert "BETWEEN ?::DATE AND ?::DATE" in sql


def test_tbbo_ofi_percentile_shape() -> None:
    """Shape used by ``tbbo_ofi_percentile`` after Phase 2b adoption."""
    sql = front_month_cte(
        symbol_like="?",  # caller binds the LIKE pattern via ``execute``
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql=">= ?::DATE",
        ts_column="ts_recv",
        contract_col="contract",
        size_col="size",
        exclude_hyphenated=True,
        extra_select_cols=("bars.side",),
    )

    assert "bars.ts_recv" in sql
    assert "bars.size" in sql
    assert "bars.side" in sql
    assert "USING (day, contract)" in sql
    assert "ORDER BY total_vol DESC, contract ASC" in sql
    assert "strpos(sym.symbol, '-') = 0" in sql
    # The symbology LIKE pattern is bound, not inlined.
    assert "LIKE ?" in sql


# ---------------------------------------------------------------------------
# All tiebreak/ts_column combinations (parametric coverage)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("ts_column", ["ts_event", "ts_recv"])
@pytest.mark.parametrize("tiebreak", ["none", "contract_asc"])
def test_each_combination_is_well_formed(
    ts_column: str, tiebreak: str
) -> None:
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
        ts_column=ts_column,  # type: ignore[arg-type]
        tiebreak=tiebreak,  # type: ignore[arg-type]
    )

    # Every combination must produce the same four CTE names.
    assert sql.count(" AS (") == 4
    # Trailing comma so callers can chain without glue characters.
    assert sql.rstrip().endswith("),")
    # Selected timestamp column must be the requested one.
    assert f"bars.{ts_column}" in sql
    # Tiebreak rendering toggles cleanly.
    if tiebreak == "contract_asc":
        assert "symbol ASC" in sql
    else:
        assert "ASC" not in sql.split("ORDER BY total_vol DESC")[-1].split(
            ") AS rk"
        )[0]


# ---------------------------------------------------------------------------
# DuckDB-level smoke: the rendered SQL parses cleanly
# ---------------------------------------------------------------------------


def test_rendered_sql_parses_in_duckdb() -> None:
    """Belt-and-suspenders: hand the rendered fragment to DuckDB
    wrapped in a trivial outer SELECT to confirm it isn't producing
    syntactically invalid SQL on any default-path render.
    """
    fragment = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="''",  # empty path; DuckDB only parses, never runs
        symbology_path_param="''",
        date_filter_sql="= '2024-01-01'::DATE",
    )

    # The fragment ends with a trailing comma so we tack on a stub CTE.
    full = (
        fragment
        + " stub AS (SELECT 1 AS x) SELECT * FROM stub"
    )

    conn = duckdb.connect(":memory:")
    try:
        # ``conn.extract_statements`` parses without executing — perfect
        # for a syntax check that doesn't need real Parquet files.
        statements = conn.extract_statements(full)
        assert len(statements) == 1
    finally:
        conn.close()
