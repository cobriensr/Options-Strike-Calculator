"""Tests for archive_query — DuckDB over the seeded volume.

We exercise the real DuckDB engine against tiny Parquet fixtures we
build on the fly. That covers the layer we actually own (the SQL +
front-month picking + result shaping), whereas mocking DuckDB would
mostly validate our mocks.

Fixtures are built with DuckDB's own `COPY ... TO ... (FORMAT PARQUET)`
so the test file has no pandas/pyarrow dependency beyond what duckdb
already pulls in transitively.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Iterator

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import archive_query  # noqa: E402


# ---------------------------------------------------------------------------
# Fixture builder
# ---------------------------------------------------------------------------


def _build_archive(root: Path, bars: list[tuple], symbology: list[tuple]) -> None:
    """Write ohlcv_1m/year=YYYY/part.parquet and symbology.parquet under `root`.

    `bars`: list of (ts_event, instrument_id, open, high, low, close, volume)
    `symbology`: list of (instrument_id, symbol, first_seen, last_seen)
    """
    conn = duckdb.connect()

    # Split bars by year so the partitioned glob matches what the real
    # converter produces. A test with bars in two years writes two files.
    years = sorted({ts.year for (ts, *_rest) in bars})
    for year in years:
        year_bars = [row for row in bars if row[0].year == year]
        year_dir = root / "ohlcv_1m" / f"year={year}"
        year_dir.mkdir(parents=True, exist_ok=True)
        part = year_dir / "part.parquet"

        conn.execute(
            """
            CREATE OR REPLACE TEMP TABLE bars_tmp (
                ts_event TIMESTAMPTZ,
                instrument_id INTEGER,
                open DOUBLE,
                high DOUBLE,
                low DOUBLE,
                close DOUBLE,
                volume BIGINT
            )
            """
        )
        conn.executemany(
            "INSERT INTO bars_tmp VALUES (?, ?, ?, ?, ?, ?, ?)", year_bars
        )
        conn.execute(f"COPY bars_tmp TO '{part}' (FORMAT PARQUET)")

    # Symbology — one file for all years.
    conn.execute(
        """
        CREATE OR REPLACE TEMP TABLE sym_tmp (
            instrument_id INTEGER,
            symbol VARCHAR,
            first_seen TIMESTAMPTZ,
            last_seen TIMESTAMPTZ
        )
        """
    )
    conn.executemany("INSERT INTO sym_tmp VALUES (?, ?, ?, ?)", symbology)
    conn.execute(
        f"COPY sym_tmp TO '{root / 'symbology.parquet'}' (FORMAT PARQUET)"
    )
    conn.close()


@pytest.fixture(autouse=True)
def _reset_archive_query_state() -> Iterator[None]:
    """Drop the shared DuckDB connection between tests."""
    yield
    archive_query.reset_connection_for_tests()


# ---------------------------------------------------------------------------
# es_day_summary
# ---------------------------------------------------------------------------


def test_es_day_summary_picks_highest_volume_es_contract(tmp_path: Path) -> None:
    """With two active ES contracts, the one with more volume wins."""
    from datetime import datetime, timezone

    day = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    bars = [
        # Front month (high volume)
        (day, 101, 5300.0, 5305.0, 5299.0, 5304.0, 10_000),
        (day.replace(hour=15), 101, 5304.0, 5310.0, 5303.0, 5308.0, 12_000),
        # Back month (low volume — should NOT win front-month pick)
        (day, 202, 5350.0, 5352.0, 5349.0, 5351.0, 500),
    ]
    symbology = [
        (101, "ESU4", day, day),
        (202, "ESZ4", day, day),
    ]
    _build_archive(tmp_path, bars, symbology)

    result = archive_query.es_day_summary("2024-06-03", root=tmp_path)

    assert result["symbol"] == "ESU4"
    assert result["open"] == 5300.0
    assert result["high"] == 5310.0
    assert result["low"] == 5299.0
    assert result["close"] == 5308.0
    assert result["volume"] == 22_000
    assert result["bar_count"] == 2


def test_es_day_summary_excludes_option_symbols(tmp_path: Path) -> None:
    """Option symbols (which contain spaces) must not be considered ES."""
    from datetime import datetime, timezone

    day = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    bars = [
        (day, 101, 5300.0, 5305.0, 5299.0, 5304.0, 1_000),
        # A high-volume option that would win if not filtered.
        (day, 999, 10.0, 11.0, 9.5, 10.5, 999_999),
    ]
    symbology = [
        (101, "ESU4", day, day),
        # Real Databento option symbol format: has spaces.
        (999, "ES 24 09 20 C5400", day, day),
    ]
    _build_archive(tmp_path, bars, symbology)

    result = archive_query.es_day_summary("2024-06-03", root=tmp_path)

    # Should be the futures contract, NOT the option.
    assert result["symbol"] == "ESU4"
    assert result["volume"] == 1_000


def test_es_day_summary_excludes_non_es_symbols(tmp_path: Path) -> None:
    """NQ bars on the same day must not leak into ES summary."""
    from datetime import datetime, timezone

    day = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    bars = [
        (day, 101, 5300.0, 5305.0, 5299.0, 5304.0, 1_000),
        (day, 301, 18_000.0, 18_050.0, 17_950.0, 18_025.0, 5_000),
    ]
    symbology = [
        (101, "ESU4", day, day),
        (301, "NQU4", day, day),
    ]
    _build_archive(tmp_path, bars, symbology)

    result = archive_query.es_day_summary("2024-06-03", root=tmp_path)
    assert result["symbol"] == "ESU4"


def test_es_day_summary_raises_on_date_with_no_data(tmp_path: Path) -> None:
    from datetime import datetime, timezone

    day = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    bars = [(day, 101, 5300.0, 5305.0, 5299.0, 5304.0, 1_000)]
    symbology = [(101, "ESU4", day, day)]
    _build_archive(tmp_path, bars, symbology)

    with pytest.raises(ValueError, match="2024-06-04"):
        archive_query.es_day_summary("2024-06-04", root=tmp_path)


def test_es_day_summary_isolates_day_from_surrounding_data(
    tmp_path: Path,
) -> None:
    """Bars from 06-02 must not be pulled into 06-03's summary."""
    from datetime import datetime, timezone

    d2 = datetime(2024, 6, 2, 14, 30, tzinfo=timezone.utc)
    d3 = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    bars = [
        # Prior day — different close.
        (d2, 101, 5200.0, 5210.0, 5190.0, 5205.0, 5_000),
        # Target day.
        (d3, 101, 5300.0, 5305.0, 5299.0, 5304.0, 1_000),
    ]
    symbology = [(101, "ESU4", d2, d3)]
    _build_archive(tmp_path, bars, symbology)

    result = archive_query.es_day_summary("2024-06-03", root=tmp_path)
    assert result["open"] == 5300.0
    assert result["close"] == 5304.0
    assert result["volume"] == 1_000
