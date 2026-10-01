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
        conn.executemany("INSERT INTO bars_tmp VALUES (?, ?, ?, ?, ?, ?, ?)", year_bars)
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
    conn.execute(f"COPY sym_tmp TO '{root / 'symbology.parquet'}' (FORMAT PARQUET)")
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


# ---------------------------------------------------------------------------
# day_summary_text
# ---------------------------------------------------------------------------


def test_day_summary_text_contains_core_fields(tmp_path: Path) -> None:
    from datetime import datetime, timezone

    # 4-bar day: open, +60m, +120m, EOD. Enough to exercise the three
    # delta-window lookups.
    d0 = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    d1 = datetime(2024, 6, 3, 15, 30, tzinfo=timezone.utc)  # +60m
    d2 = datetime(2024, 6, 3, 16, 30, tzinfo=timezone.utc)  # +120m
    d3 = datetime(2024, 6, 3, 21, 0, tzinfo=timezone.utc)  # EOD
    bars = [
        (d0, 101, 5300.0, 5305.0, 5299.0, 5300.0, 1_000_000),
        (d1, 101, 5300.0, 5310.0, 5299.0, 5305.5, 1_500_000),
        (d2, 101, 5305.5, 5315.0, 5300.0, 5308.0, 500_000),
        (d3, 101, 5308.0, 5315.0, 5280.0, 5285.0, 250_000),
    ]
    symbology = [(101, "ESU4", d0, d3)]
    _build_archive(tmp_path, bars, symbology)

    summary = archive_query.day_summary_text("2024-06-03", root=tmp_path)

    # Spot-check structure; exact numerics are exercised in format-specific
    # tests below. These are the fields Claude will actually read.
    assert summary.startswith("2024-06-03 ESU4 | open 5300.00")
    assert "1h delta +5.50" in summary
    assert "2h delta +8.00" in summary
    assert "vol 3.25M" in summary
    assert summary.endswith("close 5285.00 (-15.00)")


def test_day_summary_text_raises_on_missing_date(tmp_path: Path) -> None:
    from datetime import datetime, timezone

    d0 = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    bars = [(d0, 101, 5300.0, 5305.0, 5299.0, 5300.0, 1000)]
    _build_archive(tmp_path, bars, [(101, "ESU4", d0, d0)])

    with pytest.raises(ValueError, match="2024-06-04"):
        archive_query.day_summary_text("2024-06-04", root=tmp_path)


def test_day_summary_text_is_deterministic(tmp_path: Path) -> None:
    """Same input must produce byte-identical output — embedding stability."""
    from datetime import datetime, timezone

    d0 = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    bars = [(d0, 101, 5300.0, 5305.0, 5299.0, 5304.0, 1000)]
    _build_archive(tmp_path, bars, [(101, "ESU4", d0, d0)])

    a = archive_query.day_summary_text("2024-06-03", root=tmp_path)
    archive_query.reset_connection_for_tests()
    b = archive_query.day_summary_text("2024-06-03", root=tmp_path)

    assert a == b


# ---------------------------------------------------------------------------
# day_features_vector
# ---------------------------------------------------------------------------


def _sixty_minute_day(
    date_tuple: tuple[int, int, int],
    instrument_id: int,
    open_price: float,
    minute_closes: list[float],
) -> list[tuple]:
    """Build 60 one-minute bars starting at session open."""
    from datetime import datetime, timezone, timedelta

    assert len(minute_closes) == 60
    d0 = datetime(*date_tuple, 14, 30, tzinfo=timezone.utc)
    bars: list[tuple] = [
        (d0, instrument_id, open_price, open_price, open_price, open_price, 1_000),
    ]
    for m, close in enumerate(minute_closes, start=1):
        ts = d0 + timedelta(minutes=m)
        bars.append(
            (ts, instrument_id, close, close, close, close, 1_000),
        )
    return bars


def test_day_features_vector_produces_60_dim_percent_changes(
    tmp_path: Path,
) -> None:
    from datetime import datetime, timezone

    # Simple ramp: minute N close = 5300 + N (0.01887% per minute rise).
    closes = [5300.0 + i for i in range(1, 61)]
    bars = _sixty_minute_day((2024, 6, 3), 101, 5300.0, closes)
    _build_archive(
        tmp_path,
        bars,
        [
            (
                101,
                "ESU4",
                datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc),
                datetime(2024, 6, 3, 15, 30, tzinfo=timezone.utc),
            )
        ],
    )

    vec = archive_query.day_features_vector("2024-06-03", root=tmp_path)

    assert len(vec) == archive_query.DAY_FEATURES_DIM == 60
    # Minute 1: (5301 - 5300) / 5300 = 0.0001887 (≈ 1/5300)
    assert vec[0] == pytest.approx(1 / 5300, rel=1e-6)
    # Minute 60: (5360 - 5300) / 5300 = 60/5300
    assert vec[59] == pytest.approx(60 / 5300, rel=1e-6)
    # Monotonic on a pure ramp.
    assert all(vec[i + 1] > vec[i] for i in range(59))


def test_day_features_vector_raises_on_missing_date(tmp_path: Path) -> None:
    from datetime import datetime, timezone

    d0 = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    _build_archive(
        tmp_path,
        [(d0, 101, 5300.0, 5305.0, 5299.0, 5300.0, 1_000)],
        [(101, "ESU4", d0, d0)],
    )
    with pytest.raises(ValueError, match="2024-06-04"):
        archive_query.day_features_vector("2024-06-04", root=tmp_path)


def test_day_features_vector_rejects_too_few_bars(tmp_path: Path) -> None:
    """5 bars in the first hour isn't a real trading day — refuse."""
    from datetime import datetime, timezone, timedelta

    d0 = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    bars = [
        (
            d0 + timedelta(minutes=i),
            101,
            5300.0 + i,
            5300.0 + i,
            5300.0 + i,
            5300.0 + i,
            1_000,
        )
        for i in range(5)
    ]
    _build_archive(
        tmp_path,
        bars,
        [(101, "ESU4", d0, d0 + timedelta(minutes=4))],
    )
    with pytest.raises(ValueError, match="Insufficient"):
        archive_query.day_features_vector("2024-06-03", root=tmp_path)


def test_day_summary_prediction_has_no_close_field(tmp_path: Path) -> None:
    """Critical test: leakage-free summary must not embed EOD close.
    Any regression would re-introduce the data leakage that inflated
    text-backend hit-rate artifacts."""
    from datetime import datetime, timezone

    closes = [5300.0 + i for i in range(1, 61)]
    bars = _sixty_minute_day((2024, 6, 3), 101, 5300.0, closes)
    _build_archive(
        tmp_path,
        bars,
        [
            (
                101,
                "ESU4",
                datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc),
                datetime(2024, 6, 3, 15, 30, tzinfo=timezone.utc),
            )
        ],
    )

    summary = archive_query.day_summary_prediction("2024-06-03", root=tmp_path)
    # Must NOT contain any form of "close" (EOD outcome).
    assert "close" not in summary
    # But must contain the first-hour fields.
    assert "1h delta" in summary
    assert "1h high" in summary
    assert "1h low" in summary
    assert "1h vol" in summary
    assert summary.startswith("2024-06-03 ESU4 | open 5300.00")


def test_day_summary_prediction_batch_matches_per_date(tmp_path: Path) -> None:
    from datetime import datetime, timezone

    closes_a = [5300.0 + i for i in range(1, 61)]
    closes_b = [5400.0 + i * 0.5 for i in range(1, 61)]
    bars = _sixty_minute_day((2024, 6, 3), 101, 5300.0, closes_a)
    bars += _sixty_minute_day((2024, 6, 4), 101, 5400.0, closes_b)
    _build_archive(
        tmp_path,
        bars,
        [
            (
                101,
                "ESU4",
                datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc),
                datetime(2024, 6, 4, 15, 30, tzinfo=timezone.utc),
            )
        ],
    )

    batch = archive_query.day_summary_prediction_batch(
        "2024-06-03", "2024-06-04", root=tmp_path
    )
    assert len(batch) == 2
    archive_query.reset_connection_for_tests()
    single_a = archive_query.day_summary_prediction("2024-06-03", root=tmp_path)
    archive_query.reset_connection_for_tests()
    single_b = archive_query.day_summary_prediction("2024-06-04", root=tmp_path)
    by_date = {r["date"]: r for r in batch}
    # Byte-for-byte match across per-date and batched.
    assert by_date["2024-06-03"]["summary"] == single_a
    assert by_date["2024-06-04"]["summary"] == single_b


def test_day_summary_prediction_rejects_sparse_days(tmp_path: Path) -> None:
    """Same <10-bar guard as day_features_vector — sparse days (halts,
    partial data) produce no embedding rather than a noisy one."""
    from datetime import datetime, timezone, timedelta

    d0 = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    bars = [
        (
            d0 + timedelta(minutes=i),
            101,
            5300.0 + i,
            5300.0 + i,
            5300.0 + i,
            5300.0 + i,
            1_000,
        )
        for i in range(5)
    ]
    _build_archive(
        tmp_path,
        bars,
        [(101, "ESU4", d0, d0 + timedelta(minutes=4))],
    )
    with pytest.raises(ValueError, match="Insufficient"):
        archive_query.day_summary_prediction("2024-06-03", root=tmp_path)


def test_day_features_batch_matches_per_date_vectors(tmp_path: Path) -> None:
    """Batched output must byte-match what the per-date function
    produces, otherwise rows written by backfill-batch would drift
    from rows written by the per-date cron."""
    closes_d1 = [5300.0 + i for i in range(1, 61)]
    closes_d2 = [5400.0 + i * 0.5 for i in range(1, 61)]
    bars = _sixty_minute_day((2024, 6, 3), 101, 5300.0, closes_d1)
    bars += _sixty_minute_day((2024, 6, 4), 101, 5400.0, closes_d2)
    from datetime import datetime, timezone

    _build_archive(
        tmp_path,
        bars,
        [
            (
                101,
                "ESU4",
                datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc),
                datetime(2024, 6, 4, 15, 30, tzinfo=timezone.utc),
            )
        ],
    )

    batch = archive_query.day_features_batch("2024-06-03", "2024-06-04", root=tmp_path)
    assert len(batch) == 2
    archive_query.reset_connection_for_tests()
    v1_single = archive_query.day_features_vector("2024-06-03", root=tmp_path)
    archive_query.reset_connection_for_tests()
    v2_single = archive_query.day_features_vector("2024-06-04", root=tmp_path)

    by_date = {r["date"]: r for r in batch}
    assert by_date["2024-06-03"]["symbol"] == "ESU4"
    for want, got in zip(v1_single, by_date["2024-06-03"]["vector"]):
        assert got == pytest.approx(want, rel=1e-9)
    for want, got in zip(v2_single, by_date["2024-06-04"]["vector"]):
        assert got == pytest.approx(want, rel=1e-9)


def test_day_features_batch_skips_days_with_too_few_bars(tmp_path: Path) -> None:
    """Same <10-bar guard as the per-date function: sparse days aren't
    emitted, rather than silently written as zero-ish vectors."""
    from datetime import datetime, timezone, timedelta

    bars: list[tuple] = []
    # Day A: full 60 bars.
    closes = [5300.0 + i for i in range(1, 61)]
    bars += _sixty_minute_day((2024, 6, 3), 101, 5300.0, closes)
    # Day B: only 5 bars total. Should be skipped.
    d0 = datetime(2024, 6, 4, 14, 30, tzinfo=timezone.utc)
    for i in range(5):
        ts = d0 + timedelta(minutes=i)
        bars.append((ts, 101, 5400.0 + i, 5400.0 + i, 5400.0 + i, 5400.0 + i, 1_000))
    _build_archive(
        tmp_path,
        bars,
        [
            (
                101,
                "ESU4",
                datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc),
                datetime(2024, 6, 4, 14, 34, tzinfo=timezone.utc),
            )
        ],
    )

    batch = archive_query.day_features_batch("2024-06-03", "2024-06-04", root=tmp_path)
    dates = [r["date"] for r in batch]
    assert "2024-06-03" in dates
    assert "2024-06-04" not in dates


def test_day_summary_batch_matches_per_date_format(tmp_path: Path) -> None:
    """Batch summary output must be byte-identical to per-date —
    any drift would cause embedding model mismatches on backfill."""
    from datetime import datetime, timezone

    # Reuse the same fixture shape as the per-date test.
    d0 = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    d1 = datetime(2024, 6, 3, 15, 30, tzinfo=timezone.utc)  # +60m
    d2 = datetime(2024, 6, 3, 16, 30, tzinfo=timezone.utc)  # +120m
    d3 = datetime(2024, 6, 3, 21, 0, tzinfo=timezone.utc)  # EOD
    bars = [
        (d0, 101, 5300.0, 5305.0, 5299.0, 5300.0, 1_000_000),
        (d1, 101, 5300.0, 5310.0, 5299.0, 5305.5, 1_500_000),
        (d2, 101, 5305.5, 5315.0, 5300.0, 5308.0, 500_000),
        (d3, 101, 5308.0, 5315.0, 5280.0, 5285.0, 250_000),
    ]
    _build_archive(tmp_path, bars, [(101, "ESU4", d0, d3)])

    batch = archive_query.day_summary_batch("2024-06-03", "2024-06-03", root=tmp_path)
    assert len(batch) == 1
    archive_query.reset_connection_for_tests()
    single = archive_query.day_summary_text("2024-06-03", root=tmp_path)

    # Byte-for-byte match on text summary.
    assert batch[0]["summary"] == single
    assert batch[0]["symbol"] == "ESU4"

    # Structured OHLC fields alongside the text. Fixtures have
    # open=5300.0, high=5315.0, low=5280.0, close=5285.0.
    assert batch[0]["open"] == 5300.0
    assert batch[0]["high"] == 5315.0
    assert batch[0]["low"] == 5280.0
    assert batch[0]["close"] == 5285.0
    assert batch[0]["range"] == pytest.approx(35.0)
    assert batch[0]["up_excursion"] == pytest.approx(15.0)  # high - open
    assert batch[0]["down_excursion"] == pytest.approx(20.0)  # open - low


def test_day_features_vector_forward_fills_gaps(tmp_path: Path) -> None:
    """Sparse bars (halts, gaps) should forward-fill, not produce zeros."""
    from datetime import datetime, timezone, timedelta

    d0 = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    # 12 bars, irregularly spaced — passes the < 10-bar minimum.
    # Gap between minute 5 and 30 should forward-fill.
    bars: list[tuple] = [(d0, 101, 5300.0, 5300.0, 5300.0, 5300.0, 1_000)]
    schedule: list[tuple[int, float]] = [
        (1, 5301.0),
        (2, 5301.0),
        (3, 5301.0),
        (4, 5301.0),
        (5, 5305.0),  # then GAP to minute 30
        (30, 5310.0),
        (45, 5320.0),
        (50, 5325.0),
        (55, 5328.0),
        (58, 5329.0),
        (59, 5329.5),
        (60, 5330.0),
    ]
    for m, close in schedule:
        ts = d0 + timedelta(minutes=m)
        bars.append((ts, 101, close, close, close, close, 1_000))
    _build_archive(
        tmp_path,
        bars,
        [(101, "ESU4", d0, d0 + timedelta(minutes=60))],
    )

    vec = archive_query.day_features_vector("2024-06-03", root=tmp_path)
    # Minutes 6..29 are a gap — should carry minute-5's close (5305) forward.
    for i in range(5, 29):  # vector index 5..28 = minutes 6..29
        assert vec[i] == pytest.approx((5305 - 5300) / 5300, rel=1e-6)
    # Minute 60 (index 59): 5330.
    assert vec[59] == pytest.approx((5330 - 5300) / 5300, rel=1e-6)


# ---------------------------------------------------------------------------
# TZ-boundary regression — guards `SET TimeZone = 'UTC'` in _connection()
# ---------------------------------------------------------------------------


def test_es_day_summary_honors_utc_day_on_non_utc_host(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: a bar at 00:30 UTC must bucket into the UTC date,
    regardless of the host's OS timezone.

    DuckDB's ``date_trunc('day', <TIMESTAMPTZ>)`` honors the session
    ``TimeZone``, which DuckDB initializes from the host ``TZ`` env var.
    Without the ``SET TimeZone = 'UTC'`` hook in
    ``archive_query._connection``, a bar at 2025-10-16 00:30 UTC on a
    Chicago (CT, UTC-5/-6) host would bucket into the 2025-10-15 CT
    calendar day. Every single-date archive query shares this bucketing
    (the ``*_batch`` variants use ``session_date_expr``), so
    ``es_day_summary`` stands in for all of them. (This guard previously
    lived on the TBBO microstructure query, removed with Databento.)

    The test forces ``TZ=America/Chicago`` via ``monkeypatch.setenv`` +
    ``time.tzset()`` so the assertion actually exercises the bug path.
    """
    import time as _time
    from datetime import datetime, timezone

    # time.tzset() is Unix-only. Skip on platforms where it's unavailable.
    if not hasattr(_time, "tzset"):
        pytest.skip("time.tzset() unavailable on this platform")

    monkeypatch.setenv("TZ", "America/Chicago")
    _time.tzset()
    # Drop any connection opened before TZ was patched so `_connection()`
    # re-opens under the patched environment.
    archive_query.reset_connection_for_tests()

    # 00:30 UTC on 10-16 is 19:30 CT on 10-15 — the bug-path bar.
    ts_boundary = datetime(2025, 10, 16, 0, 30, tzinfo=timezone.utc)
    # 12:00 UTC sits inside 10-16 under any reasonable TZ.
    ts_midday = datetime(2025, 10, 16, 12, 0, tzinfo=timezone.utc)
    bars = [
        (ts_boundary, 101, 5300.0, 5302.0, 5299.0, 5301.0, 1_000),
        (ts_midday, 101, 5301.0, 5305.0, 5300.0, 5304.0, 2_000),
    ]
    _build_archive(tmp_path, bars, [(101, "ESZ5", ts_boundary, ts_midday)])

    # UTC date 2025-10-16 must see BOTH bars.
    result = archive_query.es_day_summary("2025-10-16", root=tmp_path)
    assert result["bar_count"] == 2
    assert result["volume"] == 3_000
    assert result["open"] == 5300.0

    # UTC date 2025-10-15 has no bars. Pre-fix, the 00:30 UTC bar would
    # leak into the 2025-10-15 CT day and this would not raise.
    with pytest.raises(ValueError, match="2025-10-15"):
        archive_query.es_day_summary("2025-10-15", root=tmp_path)


# ---------------------------------------------------------------------------
# SIDE-017 — DuckDB memory_limit + temp_directory set on every connection
# ---------------------------------------------------------------------------


def test_connection_sets_memory_limit_and_temp_directory(tmp_path: Path) -> None:
    """Every DuckDB connection must have memory_limit + temp_directory
    set so a cold-cache archive scan spills to
    disk instead of OOM-killing the Railway container."""
    archive_query.reset_connection_for_tests()
    try:
        conn = archive_query._connection()

        # DuckDB exposes settings via duckdb_settings() system table.
        settings = dict(
            conn.execute(
                "SELECT name, value FROM duckdb_settings() "
                "WHERE name IN ('memory_limit', 'temp_directory')"
            ).fetchall()
        )
        # DuckDB reports memory_limit in MiB (1024-based) — our 500 MB
        # SET becomes "476.8 MiB" (500_000_000 / 1024 / 1024). Assert
        # the value is in the ballpark of 500 MB, not the exact string.
        limit_str = settings.get("memory_limit", "")
        assert limit_str != "", "memory_limit should be set, got empty"
        import re as _re

        match = _re.search(r"([\d.]+)", limit_str)
        assert match is not None, f"no number in memory_limit {limit_str!r}"
        limit_mib = float(match.group(1))
        # Accept either MiB-denominated (~476) or raw-MB value (~500).
        assert 400 < limit_mib < 600, (
            f"memory_limit should be ~500MB (≈476.8 MiB), got {limit_mib} "
            f"from {limit_str!r}"
        )

        temp_dir = settings.get("temp_directory", "")
        assert "/tmp/duckdb" in temp_dir, (
            f"temp_directory should point to /tmp/duckdb, got {temp_dir!r}"
        )
    finally:
        archive_query.reset_connection_for_tests()


def test_connection_caps_temp_directory_size(tmp_path: Path) -> None:
    """Every DuckDB connection must cap on-disk temp spill. Without
    max_temp_directory_size, a cold archive scan can fill the container
    overlay even though memory_limit forces the spill in the first place."""
    archive_query.reset_connection_for_tests()
    try:
        conn = archive_query._connection()

        row = conn.execute(
            "SELECT value FROM duckdb_settings() WHERE name = 'max_temp_directory_size'"
        ).fetchone()
        assert row is not None, "max_temp_directory_size should be set"
        cap_str = str(row[0])
        # DuckDB reports the cap in GiB (1024-based): our 2GB SET becomes
        # "1.8 GiB" (2_000_000_000 / 1024^3). Assert it's a bounded,
        # ~2 GB cap rather than the unlimited default.
        import re as _re

        match = _re.search(r"([\d.]+)", cap_str)
        assert match is not None, f"no number in {cap_str!r}"
        cap = float(match.group(1))
        # Accept GiB-denominated (~1.8) or raw-GB value (~2).
        assert 1.0 < cap < 3.0, (
            f"max_temp_directory_size should be ~2GB (≈1.8 GiB), got {cap_str!r}"
        )
    finally:
        archive_query.reset_connection_for_tests()


# ---------------------------------------------------------------------------
# Regression tests for Phase 2b — front_month_cte adoption
# ---------------------------------------------------------------------------
#
# The shared `front_month_cte` builder standardizes the
# `filtered -> contract_volume -> front_contract -> fb` chain across
# `day_features_batch`, `day_summary_batch`, and
# `day_summary_prediction_batch`. Those three OHLCV sites previously
# had no explicit volume-tie tiebreak and relied on DuckDB row order.
# The adoption pins
# `tiebreak='contract_asc'` everywhere, so the fixtures below
# deliberately construct a tied-volume case and assert the
# lexicographically-smaller contract wins.


def test_day_features_batch_tied_volume_resolves_deterministically(
    tmp_path: Path,
) -> None:
    """Two ES contracts with byte-identical day volume should resolve
    to the lexicographically-smaller contract under the new
    `tiebreak='contract_asc'` policy. Pre-refactor the OHLCV sites had
    no tiebreak and the answer depended on DuckDB row order — this
    test locks the new deterministic behavior so a future refactor
    can't silently revert it.
    """
    from datetime import datetime, timezone

    closes = [5300.0 + i for i in range(1, 61)]
    # Two contracts on the same day, identical bars (same volume).
    bars = _sixty_minute_day((2024, 6, 3), 201, 5300.0, closes)
    bars += _sixty_minute_day((2024, 6, 3), 202, 5300.0, closes)
    _build_archive(
        tmp_path,
        bars,
        [
            (
                201,
                "ESM4",  # lexicographically smaller
                datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc),
                datetime(2024, 6, 3, 15, 30, tzinfo=timezone.utc),
            ),
            (
                202,
                "ESU4",  # tied volume but should lose tiebreak
                datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc),
                datetime(2024, 6, 3, 15, 30, tzinfo=timezone.utc),
            ),
        ],
    )

    batch = archive_query.day_features_batch("2024-06-03", "2024-06-03", root=tmp_path)
    assert len(batch) == 1
    # ESM4 < ESU4 lex-wise → ESM4 wins.
    assert batch[0]["symbol"] == "ESM4"


def test_day_summary_batch_tied_volume_resolves_deterministically(
    tmp_path: Path,
) -> None:
    """Mirror of day_features_batch tiebreak test for day_summary_batch."""
    from datetime import datetime, timezone

    d0 = datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc)
    d1 = datetime(2024, 6, 3, 21, 0, tzinfo=timezone.utc)
    # Same OHLCV for both contracts — identical day volume.
    bars = [
        (d0, 201, 5300.0, 5305.0, 5299.0, 5300.0, 1_000_000),
        (d1, 201, 5300.0, 5310.0, 5299.0, 5305.0, 1_000_000),
        (d0, 202, 5300.0, 5305.0, 5299.0, 5300.0, 1_000_000),
        (d1, 202, 5300.0, 5310.0, 5299.0, 5305.0, 1_000_000),
    ]
    _build_archive(
        tmp_path,
        bars,
        [
            (201, "ESM4", d0, d1),
            (202, "ESU4", d0, d1),
        ],
    )

    batch = archive_query.day_summary_batch("2024-06-03", "2024-06-03", root=tmp_path)
    assert len(batch) == 1
    assert batch[0]["symbol"] == "ESM4"


def test_day_summary_prediction_batch_tied_volume_resolves_deterministically(
    tmp_path: Path,
) -> None:
    """Mirror tiebreak test for day_summary_prediction_batch."""
    from datetime import datetime, timezone

    closes = [5300.0 + i for i in range(1, 61)]
    bars = _sixty_minute_day((2024, 6, 3), 201, 5300.0, closes)
    bars += _sixty_minute_day((2024, 6, 3), 202, 5300.0, closes)
    _build_archive(
        tmp_path,
        bars,
        [
            (
                201,
                "ESM4",
                datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc),
                datetime(2024, 6, 3, 15, 30, tzinfo=timezone.utc),
            ),
            (
                202,
                "ESU4",
                datetime(2024, 6, 3, 14, 30, tzinfo=timezone.utc),
                datetime(2024, 6, 3, 15, 30, tzinfo=timezone.utc),
            ),
        ],
    )

    batch = archive_query.day_summary_prediction_batch(
        "2024-06-03", "2024-06-03", root=tmp_path
    )
    # The prediction batch only emits days with >=10 first-hour bars; both
    # contracts produce the full 60. Tied-volume case should still resolve
    # to ESM4.
    assert len(batch) == 1
    assert batch[0]["symbol"] == "ESM4"
