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


# ---------------------------------------------------------------------------
# analog_days
# ---------------------------------------------------------------------------


def _two_bar_day(
    date_tuple: tuple[int, int, int],
    instrument_id: int,
    open_price: float,
    close_at_1h: float,
    close_eod: float,
) -> list[tuple]:
    """Build a two-bar day: one at session open, one 60 min later.

    Enough to exercise the window-based delta comparison without writing
    60 bars per test day. A third bar at 15:00 UTC gives us an EOD close
    distinct from the window close.
    """
    from datetime import datetime, timezone

    d0 = datetime(*date_tuple, 14, 30, tzinfo=timezone.utc)
    d1 = datetime(*date_tuple, 15, 30, tzinfo=timezone.utc)  # +60m
    d2 = datetime(*date_tuple, 21, 0, tzinfo=timezone.utc)  # EOD
    # open/high/low/close — keep simple by making high = max of the
    # prices we reference and low = min.
    hi = max(open_price, close_at_1h, close_eod)
    lo = min(open_price, close_at_1h, close_eod)
    return [
        (d0, instrument_id, open_price, hi, lo, open_price, 1_000),
        (d1, instrument_id, open_price, hi, lo, close_at_1h, 1_000),
        (d2, instrument_id, close_at_1h, hi, lo, close_eod, 1_000),
    ]


def test_analog_days_returns_nearest_by_window_delta(tmp_path: Path) -> None:
    """Target delta = +5. Closest analog should be the day with delta closest to +5."""
    from datetime import datetime, timezone

    # days: (date, delta in first 60min)
    # target:  2024-06-05, open=5300 close_at_1h=5305  -> delta +5
    # day A:   2024-06-04, open=4000 close_at_1h=4004  -> delta +4  (distance 1)
    # day B:   2024-06-03, open=4000 close_at_1h=4010  -> delta +10 (distance 5)
    # day C:   2024-06-02, open=4000 close_at_1h=3995  -> delta -5  (distance 10)
    # day D:   2024-06-01, open=4000 close_at_1h=4005  -> delta +5  (distance 0, best)
    bars: list[tuple] = []
    bars += _two_bar_day((2024, 6, 1), 101, 4000.0, 4005.0, 4020.0)  # D
    bars += _two_bar_day((2024, 6, 2), 101, 4000.0, 3995.0, 3990.0)  # C
    bars += _two_bar_day((2024, 6, 3), 101, 4000.0, 4010.0, 4015.0)  # B
    bars += _two_bar_day((2024, 6, 4), 101, 4000.0, 4004.0, 4025.0)  # A
    bars += _two_bar_day((2024, 6, 5), 101, 5300.0, 5305.0, 5330.0)  # target
    sym_open = datetime(2024, 6, 1, 14, 30, tzinfo=timezone.utc)
    sym_close = datetime(2024, 6, 5, 21, 0, tzinfo=timezone.utc)
    symbology = [(101, "ESU4", sym_open, sym_close)]
    _build_archive(tmp_path, bars, symbology)

    result = archive_query.analog_days(
        "2024-06-05", until_minute=60, k=3, root=tmp_path
    )

    # Target delta is +5.
    assert result["target"]["delta"] == pytest.approx(5.0)
    assert result["window_minutes"] == 60

    # 3 nearest by |delta - 5|: D(0), A(1), C(5) or B(5) — tie; DuckDB
    # orders by distance ASC, then arbitrary. Test that D and A come
    # first and that the 3rd is either B or C.
    distances = [a["distance"] for a in result["analogs"]]
    assert distances == sorted(distances)
    assert result["analogs"][0]["date"] == "2024-06-01"  # D — delta +5, dist 0
    assert result["analogs"][1]["date"] == "2024-06-04"  # A — delta +4, dist 1
    assert result["analogs"][2]["date"] in {"2024-06-02", "2024-06-03"}  # dist 5 tie


def test_analog_days_excludes_target_from_results(tmp_path: Path) -> None:
    from datetime import datetime, timezone

    bars: list[tuple] = []
    bars += _two_bar_day((2024, 6, 4), 101, 4000.0, 4005.0, 4010.0)
    bars += _two_bar_day((2024, 6, 5), 101, 5300.0, 5305.0, 5310.0)
    sym = [
        (
            101,
            "ESU4",
            datetime(2024, 6, 4, 14, 30, tzinfo=timezone.utc),
            datetime(2024, 6, 5, 21, 0, tzinfo=timezone.utc),
        )
    ]
    _build_archive(tmp_path, bars, sym)

    result = archive_query.analog_days(
        "2024-06-05", until_minute=60, k=10, root=tmp_path
    )
    assert all(a["date"] != "2024-06-05" for a in result["analogs"])


def test_analog_days_raises_on_no_data_for_target(tmp_path: Path) -> None:
    from datetime import datetime, timezone

    bars: list[tuple] = _two_bar_day((2024, 6, 4), 101, 4000.0, 4005.0, 4010.0)
    sym = [
        (
            101,
            "ESU4",
            datetime(2024, 6, 4, 14, 30, tzinfo=timezone.utc),
            datetime(2024, 6, 4, 21, 0, tzinfo=timezone.utc),
        )
    ]
    _build_archive(tmp_path, bars, sym)

    with pytest.raises(ValueError, match="2024-06-05"):
        archive_query.analog_days("2024-06-05", root=tmp_path)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"k": 0},
        {"k": 999},
        {"until_minute": 0},
        {"until_minute": 1000},
    ],
)
def test_analog_days_validates_bounds(tmp_path: Path, kwargs: dict) -> None:
    with pytest.raises(ValueError):
        archive_query.analog_days("2024-06-05", root=tmp_path, **kwargs)
