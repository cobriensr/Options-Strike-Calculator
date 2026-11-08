"""load_zero_gamma selects columns that exist in ``zero_gamma_levels``.

It used to select ``zero_gamma_strike``, a column the table never had (the
column is ``zero_gamma``), so the loader raised on every call. The Neon
loaders need a live DATABASE_URL and are not smoke-tested, so nothing caught
it. This test needs neither a database nor the Parquet archive: it captures
the SQL the loader sends and checks every selected column against the
``CREATE TABLE zero_gamma_levels`` of the real migration in
``api/_lib/db-migrations.ts``.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import pandas as pd

from setups_backtest import data_loaders

MIGRATIONS = Path(__file__).resolve().parents[2] / "api" / "_lib" / "db-migrations.ts"


def _table_columns() -> set[str]:
    """Column names of ``zero_gamma_levels`` as the migration creates it."""
    text = MIGRATIONS.read_text(encoding="utf-8")
    m = re.search(
        r"CREATE TABLE IF NOT EXISTS zero_gamma_levels \((.*?)\n\s*\)",
        text,
        re.S,
    )
    assert m, "zero_gamma_levels CREATE TABLE not found in db-migrations.ts"
    cols: set[str] = set()
    for line in m.group(1).splitlines():
        line = line.strip()
        if line and not line.startswith("--"):
            cols.add(line.split()[0])
    return cols


def _selected_columns(sql: str) -> list[str]:
    m = re.search(r"SELECT(.*?)FROM", sql, re.S | re.I)
    assert m, "no SELECT ... FROM in the loader SQL"
    return [c.strip() for c in m.group(1).split(",") if c.strip()]


def test_load_zero_gamma_selects_only_existing_columns(monkeypatch):
    captured: dict[str, str] = {}

    def fake_read_sql_query(sql, con, params=None):
        captured["sql"] = sql
        return pd.DataFrame(columns=["ts", "zero_gamma", "confidence"])

    monkeypatch.setattr(data_loaders.pd, "read_sql_query", fake_read_sql_query)

    df = data_loaders.load_zero_gamma(
        object(), "SPX", date(2026, 4, 1), date(2026, 4, 2)
    )

    assert list(df.columns) == ["ts", "zero_gamma", "confidence"]
    selected = _selected_columns(captured["sql"])
    assert selected == ["ts", "zero_gamma", "confidence"]
    missing = [c for c in selected if c not in _table_columns()]
    assert not missing, f"selected columns missing from zero_gamma_levels: {missing}"
    assert "zero_gamma_strike" not in captured["sql"]
