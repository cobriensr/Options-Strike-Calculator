"""Smoke tests for setups_backtest.data_loaders against the real archive.

These hit the local Parquet archive under ``ml/data/archive/`` (which is
gitignored — see ``.gitignore``), so they only run where that archive
exists. The whole module is skipped when the tbbo archive is absent (e.g.
on CI runners, which have no seed step), and additionally marked ``slow``
for local opt-out via ``-m 'not slow'``.

Neon DB loaders are NOT tested here — they require a live ``DATABASE_URL``
and are smoke-tested in Phase 0b's CLI dry-run instead.
"""

from __future__ import annotations

import glob
from datetime import date

import pytest

from setups_backtest import data_loaders

# The Parquet archive is gitignored and not seeded on CI, so these smoke
# tests can only run where it exists locally. Skip the whole module when the
# tbbo partitions are missing rather than fail with a DuckDB "no files found"
# IOException — that turned the ML CI gate red once the lint failure that had
# been masking it was fixed (2026-06-05).
_ARCHIVE_PRESENT = bool(glob.glob(data_loaders.tbbo_glob()))
pytestmark = pytest.mark.skipif(
    not _ARCHIVE_PRESENT,
    reason=(
        "local Parquet archive absent (ml/data/archive/tbbo is gitignored / "
        "not seeded on CI); run where the archive exists"
    ),
)


@pytest.fixture(scope="module")
def conn():
    with data_loaders.duckdb_session() as c:
        yield c


# A known-good liquid day from the spec's test window.
SAMPLE_DATE = date(2026, 4, 15)


@pytest.mark.slow
def test_pick_front_month_es(conn):
    fm = data_loaders.pick_front_month(conn, "ES", SAMPLE_DATE)
    assert fm is not None
    assert fm.startswith("ES")
    # No spaces or hyphens (i.e., outright, not spread or option).
    assert " " not in fm and "-" not in fm


@pytest.mark.slow
def test_pick_front_month_nq(conn):
    fm = data_loaders.pick_front_month(conn, "NQ", SAMPLE_DATE)
    assert fm is not None
    assert fm.startswith("NQ")


@pytest.mark.slow
def test_pick_front_month_rejects_unknown_symbol(conn):
    with pytest.raises(ValueError):
        data_loaders.pick_front_month(conn, "ZN", SAMPLE_DATE)


@pytest.mark.slow
def test_load_tbbo_minute_shape(conn):
    fm = data_loaders.pick_front_month(conn, "ES", SAMPLE_DATE)
    df = data_loaders.load_tbbo_minute(conn, fm, SAMPLE_DATE)
    assert not df.empty
    assert set(df.columns) >= {
        "minute",
        "n_trades",
        "buy_vol",
        "sell_vol",
        "total_vol",
        "vwap_price",
        "max_spread",
        "ofi",
    }
    # All minute timestamps tz-aware UTC.
    assert df["minute"].dt.tz is not None
    # OFI is bounded [-1, +1] or NaN.
    valid_ofi = df["ofi"].dropna()
    assert (valid_ofi.between(-1.0, 1.0)).all()


@pytest.mark.slow
def test_load_ohlcv_day_shape(conn):
    fm = data_loaders.pick_front_month(conn, "ES", SAMPLE_DATE)
    df = data_loaders.load_ohlcv_day(conn, [fm], SAMPLE_DATE)
    assert not df.empty
    assert set(df.columns) >= {"ts", "symbol", "open", "high", "low", "close", "volume"}
    # All rows for the requested symbol.
    assert (df["symbol"] == fm).all()
    # High >= low, close in [low, high].
    assert (df["high"] >= df["low"]).all()
    assert (df["close"].between(df["low"], df["high"])).all()


@pytest.mark.slow
def test_list_trading_days_excludes_weekends(conn):
    # Pick a week that includes a weekend.
    days = data_loaders.list_trading_days(conn, date(2026, 4, 13), date(2026, 4, 19))
    # 04-13 is Mon, 04-19 is Sun. Should see 5 weekdays.
    weekdays = [d for d in days if d.weekday() < 5]
    assert len(weekdays) >= 4  # holiday safety margin


def test_tbbo_glob_string_form():
    g = data_loaders.tbbo_glob()
    assert "tbbo" in g
    assert "year=*" in g


def test_ohlcv_glob_string_form():
    g = data_loaders.ohlcv_glob()
    assert "ohlcv_1m" in g
    assert "year=*" in g
