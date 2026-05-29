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

from pathlib import Path

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
    # ``ts_recv`` flows through to the CME-session-date expression too,
    # not just the SELECT list.
    assert "bars.ts_recv AT TIME ZONE 'America/Chicago'" in sql


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
def test_each_combination_is_well_formed(ts_column: str, tiebreak: str) -> None:
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
        assert "ASC" not in sql.split("ORDER BY total_vol DESC")[-1].split(") AS rk")[0]


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
    full = fragment + " stub AS (SELECT 1 AS x) SELECT * FROM stub"

    conn = duckdb.connect(":memory:")
    try:
        # ``conn.extract_statements`` parses without executing — perfect
        # for a syntax check that doesn't need real Parquet files.
        statements = conn.extract_statements(full)
        assert len(statements) == 1
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# CME session-date bucketing (FINDING A)
# ---------------------------------------------------------------------------


def test_day_bucket_uses_cme_session_date_not_utc_day() -> None:
    """The ``day`` bucket must be the CME session date (17:00 CT roll),
    NOT ``date_trunc('day', ...)`` over the UTC calendar day. The
    overnight slice (after 17:00 CT) belongs to the NEXT session.
    """
    sql = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="= ?::DATE",
    )

    # The old UTC-day derivation must be gone everywhere.
    assert "date_trunc('day'" not in sql
    # The CME-session-date expression must be present.
    assert "AT TIME ZONE 'America/Chicago'" in sql
    assert "INTERVAL 7 HOUR" in sql


def _build_roll_archive(root: Path) -> None:
    """Write a tiny ohlcv_1m + symbology archive straddling a CME roll.

    Two ES contracts active across the 2024-06-03 -> 2024-06-04 boundary:

    - ``ESM4`` (front) dominates the *daytime* 2024-06-03 session.
    - ``ESU4`` (back) is rolled into and dominates the *overnight* slice
      that opens 2024-06-03 17:00 CT (= 22:00 UTC) and the 2024-06-04
      daytime session.

    The overnight bar at 2024-06-03 22:30 UTC (= 17:30 CT) must bucket
    into the 2024-06-04 session, where ESU4 is the front month — a
    UTC-day bucket would wrongly fold it into 2024-06-03 and let the
    daytime ESM4 volume win.
    """
    from datetime import datetime, timezone

    iid_m4, iid_u4 = 1, 2
    # (ts_event, instrument_id, open, high, low, close, volume)
    bars = [
        # 2024-06-03 daytime: ESM4 dominates this session.
        (datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc), iid_m4, 1, 1, 1, 1, 1000),
        (datetime(2024, 6, 3, 20, 0, tzinfo=timezone.utc), iid_u4, 1, 1, 1, 1, 10),
        # 2024-06-03 22:30 UTC = 17:30 CT -> belongs to 2024-06-04 session.
        # ESU4 dominates here.
        (datetime(2024, 6, 3, 22, 30, tzinfo=timezone.utc), iid_u4, 1, 1, 1, 1, 5000),
        (datetime(2024, 6, 3, 23, 0, tzinfo=timezone.utc), iid_m4, 1, 1, 1, 1, 5),
        # 2024-06-04 daytime continues the new session.
        (datetime(2024, 6, 4, 14, 30, tzinfo=timezone.utc), iid_u4, 1, 1, 1, 1, 2000),
    ]
    sym_open = datetime(2024, 5, 1, 0, 0, tzinfo=timezone.utc)
    sym_close = datetime(2024, 7, 1, 0, 0, tzinfo=timezone.utc)
    symbology = [
        (iid_m4, "ESM4", sym_open, sym_close),
        (iid_u4, "ESU4", sym_open, sym_close),
    ]

    conn = duckdb.connect()
    year_dir = root / "ohlcv_1m" / "year=2024"
    year_dir.mkdir(parents=True, exist_ok=True)
    conn.execute(
        """
        CREATE OR REPLACE TEMP TABLE bars_tmp (
            ts_event TIMESTAMPTZ, instrument_id INTEGER,
            open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT
        )
        """
    )
    conn.executemany("INSERT INTO bars_tmp VALUES (?, ?, ?, ?, ?, ?, ?)", bars)
    conn.execute(f"COPY bars_tmp TO '{year_dir / 'part.parquet'}' (FORMAT PARQUET)")

    conn.execute(
        """
        CREATE OR REPLACE TEMP TABLE sym_tmp (
            instrument_id INTEGER, symbol VARCHAR,
            first_seen TIMESTAMPTZ, last_seen TIMESTAMPTZ
        )
        """
    )
    conn.executemany("INSERT INTO sym_tmp VALUES (?, ?, ?, ?)", symbology)
    conn.execute(f"COPY sym_tmp TO '{root / 'symbology.parquet'}' (FORMAT PARQUET)")
    conn.close()


def test_overnight_bar_buckets_into_next_session_and_picks_front(
    tmp_path: Path,
) -> None:
    """End-to-end: run the rendered CTE against a real in-memory DuckDB
    over a fixture straddling the 17:00 CT roll.

    The overnight bar (2024-06-03 22:30 UTC = 17:30 CT) must land in the
    2024-06-04 session, and the front-month pick for that session must be
    ESU4 (5000+2000 vol) — not ESM4. A UTC-day bucket would put the
    overnight ESU4 volume on 2024-06-03 and pick ESM4 instead.
    """
    _build_roll_archive(tmp_path)

    fragment = front_month_cte(
        symbol_like="'ES%'",
        parquet_path_param="?",
        symbology_path_param="?",
        date_filter_sql="BETWEEN ?::DATE AND ?::DATE",
    )
    # Per-day front-month contract picked by the chain. The fragment ends
    # with a trailing comma (for CTE chaining), so tack on a wrapping CTE
    # rather than a bare SELECT.
    query = (
        fragment
        + " result AS (SELECT DISTINCT day, symbol FROM fb)"
        + " SELECT day, symbol FROM result ORDER BY day, symbol"
    )

    conn = duckdb.connect(":memory:")
    try:
        conn.execute("SET TimeZone = 'UTC'")
        rows = conn.execute(
            query,
            [
                str(tmp_path / "ohlcv_1m" / "**" / "*.parquet"),
                str(tmp_path / "symbology.parquet"),
                "2024-06-03",
                "2024-06-04",
            ],
        ).fetchall()
    finally:
        conn.close()

    by_day = {str(day): symbol for day, symbol in rows}
    # 2024-06-03 daytime session -> ESM4 (1000 vol) beats ESU4 (10 vol).
    assert by_day["2024-06-03"] == "ESM4"
    # 2024-06-04 session (incl. the 17:30 CT overnight bar) -> ESU4.
    assert by_day["2024-06-04"] == "ESU4"
