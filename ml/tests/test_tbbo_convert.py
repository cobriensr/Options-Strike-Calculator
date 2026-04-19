"""Tests for tbbo_convert — the TBBO daily-dir → Parquet converter.

Like test_archive_convert.py, we stub ``databento.DBNStore.from_file`` rather
than writing real DBN binary. Each test patches from_file to return a
``_FakeStore`` whose ``to_df(map_symbols=True)`` yields a tiny DataFrame
matching the shape verified in the tbbo_convert module docstring.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import tbbo_convert

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_tbbo_df(
    rows: list[dict[str, object]] | None = None,
    as_index: bool = True,
) -> pd.DataFrame:
    """Build a tiny TBBO DataFrame matching the real SDK shape.

    Real TBBO to_df() returns a DataFrame indexed by ts_recv with ts_event as
    a regular column. Mirroring that in the fixture is the difference between
    "tests pass + converter breaks on real file" and catching shape drift
    locally.
    """
    if rows is None:
        rows = _default_rows()
    df = pd.DataFrame(rows)
    df["ts_event"] = pd.to_datetime(df["ts_event"], utc=True)
    df["ts_recv"] = pd.to_datetime(df["ts_recv"], utc=True)
    if as_index:
        df = df.set_index("ts_recv")
    return df


def _default_rows() -> list[dict[str, object]]:
    """Small mixed set: ES/NQ futures + one ES spread + one ES option."""
    tz = UTC
    return [
        # 2025 outright ES future
        {
            "ts_event": datetime(2025, 6, 3, 13, 30, tzinfo=tz),
            "ts_recv": datetime(2025, 6, 3, 13, 30, 0, 100, tzinfo=tz),
            "rtype": 1,
            "publisher_id": 1,
            "instrument_id": 101,
            "action": "T",
            "side": "A",
            "depth": 0,
            "price": 5300.25,
            "size": 5,
            "flags": 0,
            "ts_in_delta": 100,
            "sequence": 1,
            "bid_px_00": 5300.00,
            "ask_px_00": 5300.25,
            "bid_sz_00": 12,
            "ask_sz_00": 8,
            "bid_ct_00": 3,
            "ask_ct_00": 2,
            "symbol": "ESU5",
        },
        # 2025 outright NQ future
        {
            "ts_event": datetime(2025, 6, 3, 13, 30, 0, 500_000, tzinfo=tz),
            "ts_recv": datetime(2025, 6, 3, 13, 30, 0, 600_000, tzinfo=tz),
            "rtype": 1,
            "publisher_id": 1,
            "instrument_id": 202,
            "action": "T",
            "side": "B",
            "depth": 0,
            "price": 18500.75,
            "size": 2,
            "flags": 0,
            "ts_in_delta": 110,
            "sequence": 2,
            "bid_px_00": 18500.75,
            "ask_px_00": 18501.00,
            "bid_sz_00": 4,
            "ask_sz_00": 6,
            "bid_ct_00": 1,
            "ask_ct_00": 2,
            "symbol": "NQU5",
        },
        # 2026 outright ES future (different year)
        {
            "ts_event": datetime(2026, 2, 10, 14, 0, tzinfo=tz),
            "ts_recv": datetime(2026, 2, 10, 14, 0, 0, 100, tzinfo=tz),
            "rtype": 1,
            "publisher_id": 1,
            "instrument_id": 303,
            "action": "T",
            "side": "A",
            "depth": 0,
            "price": 5500.00,
            "size": 1,
            "flags": 0,
            "ts_in_delta": 50,
            "sequence": 3,
            "bid_px_00": 5499.75,
            "ask_px_00": 5500.00,
            "bid_sz_00": 10,
            "ask_sz_00": 10,
            "bid_ct_00": 2,
            "ask_ct_00": 2,
            "symbol": "ESH6",
        },
        # 2025 ES calendar SPREAD — must be filtered out (hyphen)
        {
            "ts_event": datetime(2025, 6, 3, 13, 45, tzinfo=tz),
            "ts_recv": datetime(2025, 6, 3, 13, 45, 0, 100, tzinfo=tz),
            "rtype": 1,
            "publisher_id": 1,
            "instrument_id": 999,
            "action": "T",
            "side": "N",
            "depth": 0,
            "price": -25.0,
            "size": 1,
            "flags": 0,
            "ts_in_delta": 80,
            "sequence": 4,
            "bid_px_00": -25.25,
            "ask_px_00": -24.75,
            "bid_sz_00": 2,
            "ask_sz_00": 2,
            "bid_ct_00": 1,
            "ask_ct_00": 1,
            "symbol": "ESU5-ESZ5",
        },
        # 2025 ES OPTION — must be filtered out (space-delimited)
        {
            "ts_event": datetime(2025, 6, 3, 14, 15, tzinfo=tz),
            "ts_recv": datetime(2025, 6, 3, 14, 15, 0, 100, tzinfo=tz),
            "rtype": 1,
            "publisher_id": 1,
            "instrument_id": 4040,
            "action": "T",
            "side": "B",
            "depth": 0,
            "price": 12.50,
            "size": 3,
            "flags": 0,
            "ts_in_delta": 90,
            "sequence": 5,
            "bid_px_00": 12.25,
            "ask_px_00": 12.75,
            "bid_sz_00": 5,
            "ask_sz_00": 5,
            "bid_ct_00": 1,
            "ask_ct_00": 1,
            "symbol": "ES 250620 C5800",
        },
    ]


class _FakeStore:
    """Minimal DBNStore stand-in matching the subset tbbo_convert uses."""

    def __init__(
        self,
        schema: str = "tbbo",
        df: pd.DataFrame | None = None,
        *,
        raise_on_to_df: Exception | None = None,
    ):
        self.schema = schema
        self._df = df if df is not None else _make_tbbo_df()
        self._raise_on_to_df = raise_on_to_df

    def to_df(self, **_kwargs: object) -> pd.DataFrame:
        if self._raise_on_to_df is not None:
            raise self._raise_on_to_df
        return self._df.copy()


@pytest.fixture
def tbbo_dir(tmp_path: Path) -> Path:
    """Create a directory with one placeholder TBBO file.

    The converter only opens files via the patched DBNStore.from_file, so the
    file contents don't matter — just its name (must match the glob) and
    existence (the directory must be non-empty).
    """
    d = tmp_path / "dbn_in"
    d.mkdir()
    (d / "glbx-mdp3-20250603.tbbo.dbn.zst").write_bytes(b"placeholder")
    return d


@pytest.fixture
def multi_file_tbbo_dir(tmp_path: Path) -> Path:
    """Directory with three placeholder TBBO files (three trading days)."""
    d = tmp_path / "dbn_in"
    d.mkdir()
    (d / "glbx-mdp3-20250603.tbbo.dbn.zst").write_bytes(b"placeholder")
    (d / "glbx-mdp3-20250604.tbbo.dbn.zst").write_bytes(b"placeholder")
    (d / "glbx-mdp3-20260210.tbbo.dbn.zst").write_bytes(b"placeholder")
    return d


@pytest.fixture
def sample_condition_json(tmp_path: Path) -> Path:
    """Write a condition.json with two degraded days out of five."""
    path = tmp_path / "condition.json"
    path.write_text(
        json.dumps(
            [
                {"date": "2025-06-03", "condition": "available"},
                {"date": "2025-06-04", "condition": "degraded"},
                {"date": "2025-06-05", "condition": "available"},
                {"date": "2025-06-06", "condition": "degraded"},
                {"date": "2025-06-07", "condition": "available"},
            ]
        )
    )
    return path


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_conversion_produces_year_partitions(
    tmp_path: Path,
    multi_file_tbbo_dir: Path,
) -> None:
    """2–3 synthetic day files -> correct year-partitioned output."""
    out = tmp_path / "out"
    with patch.object(
        tbbo_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        result = tbbo_convert.convert_tbbo_dir_to_parquet(multi_file_tbbo_dir, out)

    assert (out / "tbbo" / "year=2025" / "part.parquet").is_file()
    assert (out / "tbbo" / "year=2026" / "part.parquet").is_file()

    # Each file has 5 rows; 3 pass the symbol filter (ESU5, NQU5, ESH6).
    # Three files -> 9 total accepted rows; 6 in 2025, 3 in 2026.
    assert result.total_rows == 9
    assert result.files_processed == 3
    assert result.files_skipped == 0
    assert result.years == [2025, 2026]
    assert result.rows_per_year == {2025: 6, 2026: 3}
    assert result.schema == "tbbo"
    # 3 distinct instrument_ids survive filtering.
    assert result.distinct_instruments == 3


def test_parquet_content_round_trips(
    tmp_path: Path,
    tbbo_dir: Path,
) -> None:
    """On-disk schema excludes 'year' column (encoded in directory)."""
    out = tmp_path / "out"
    with patch.object(
        tbbo_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        tbbo_convert.convert_tbbo_dir_to_parquet(tbbo_dir, out)

    part_path = out / "tbbo" / "year=2025" / "part.parquet"
    on_disk_cols = pq.read_schema(part_path).names
    assert "year" not in on_disk_cols
    assert {
        "ts_event",
        "ts_recv",
        "instrument_id",
        "price",
        "size",
        "bid_px_00",
        "ask_px_00",
        "symbol",
    } <= set(on_disk_cols)

    df_2025 = pq.read_table(part_path).to_pandas()
    # 2 rows in 2025 pass the filter (ESU5, NQU5).
    assert len(df_2025) == 2
    assert set(df_2025["symbol"].tolist()) == {"ESU5", "NQU5"}


# ---------------------------------------------------------------------------
# Symbol filter
# ---------------------------------------------------------------------------


def test_symbol_filter_excludes_options_and_spreads(
    tmp_path: Path,
    tbbo_dir: Path,
) -> None:
    """File with mixed ES futures + options + spreads -> only outright futures kept."""
    out = tmp_path / "out"
    with patch.object(
        tbbo_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        result = tbbo_convert.convert_tbbo_dir_to_parquet(tbbo_dir, out)

    # Input has 5 rows: ESU5, NQU5, ESH6, ESU5-ESZ5 (spread), ES 250620 C5800 (option).
    # Three are outright futures and pass the filter.
    assert result.total_rows == 3

    # No spread or option symbols should appear on disk.
    df_2025 = pq.read_table(out / "tbbo" / "year=2025" / "part.parquet").to_pandas()
    assert not df_2025["symbol"].str.contains("-").any()
    assert not df_2025["symbol"].str.contains(" ").any()
    assert set(df_2025["symbol"].unique()) == {"ESU5", "NQU5"}

    # rows_per_symbol should only contain the three outrights.
    assert set(result.rows_per_symbol.keys()) == {"ESU5", "NQU5", "ESH6"}


# ---------------------------------------------------------------------------
# Guard rails
# ---------------------------------------------------------------------------


def test_non_tbbo_schema_raises(
    tmp_path: Path,
    tbbo_dir: Path,
) -> None:
    """Non-TBBO schema fails loud rather than silently skipping."""
    out = tmp_path / "out"
    with patch.object(
        tbbo_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(schema="trades"),
    ):
        with pytest.raises(ValueError, match="tbbo"):
            tbbo_convert.convert_tbbo_dir_to_parquet(tbbo_dir, out)


def test_empty_directory_raises(tmp_path: Path) -> None:
    """Directory with no matching files -> meaningful FileNotFoundError."""
    empty = tmp_path / "empty_dir"
    empty.mkdir()
    with pytest.raises(FileNotFoundError, match="No TBBO files"):
        tbbo_convert.convert_tbbo_dir_to_parquet(empty, tmp_path / "out")


def test_missing_directory_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="TBBO directory not found"):
        tbbo_convert.convert_tbbo_dir_to_parquet(
            tmp_path / "does_not_exist",
            tmp_path / "out",
        )


def test_missing_required_column_is_counted_as_skip(
    tmp_path: Path,
    multi_file_tbbo_dir: Path,
) -> None:
    """A file missing a required column is logged and skipped — run continues.

    RuntimeError from column validation is treated as a per-file failure (not a
    schema guard), so it's handled by the skip path, not the fail-loud path.
    """
    good_store = _FakeStore()
    bad_df = (
        _make_tbbo_df(as_index=False).drop(columns=["bid_px_00"]).set_index("ts_recv")
    )
    bad_store = _FakeStore(df=bad_df)

    # Return bad_store on the 2nd call, good on others.
    call_count = {"n": 0}

    def fake_from_file(_path: Path) -> _FakeStore:
        call_count["n"] += 1
        if call_count["n"] == 2:
            return bad_store
        return good_store

    out = tmp_path / "out"
    with patch.object(
        tbbo_convert.db.DBNStore,
        "from_file",
        side_effect=fake_from_file,
    ):
        result = tbbo_convert.convert_tbbo_dir_to_parquet(multi_file_tbbo_dir, out)

    assert result.files_processed == 2
    assert result.files_skipped == 1
    assert len(result.skipped_files) == 1


def test_per_file_failure_does_not_kill_run(
    tmp_path: Path,
    multi_file_tbbo_dir: Path,
) -> None:
    """Generic per-file exception (not schema) is caught, logged, run continues."""
    good_store = _FakeStore()

    call_count = {"n": 0}

    def fake_from_file(_path: Path) -> _FakeStore:
        call_count["n"] += 1
        if call_count["n"] == 2:
            raise OSError("simulated corrupt file")
        return good_store

    out = tmp_path / "out"
    with patch.object(
        tbbo_convert.db.DBNStore,
        "from_file",
        side_effect=fake_from_file,
    ):
        result = tbbo_convert.convert_tbbo_dir_to_parquet(multi_file_tbbo_dir, out)

    assert result.files_processed == 2
    assert result.files_skipped == 1
    # Parquet for the two surviving files should still exist.
    assert (out / "tbbo" / "year=2025" / "part.parquet").is_file()


# ---------------------------------------------------------------------------
# Symbology merge
# ---------------------------------------------------------------------------


def test_symbology_merge_preserves_existing_ohlcv_entries(
    tmp_path: Path,
    tbbo_dir: Path,
) -> None:
    """Pre-existing symbology.parquet from OHLCV run is preserved + extended."""
    out = tmp_path / "out"
    out.mkdir()

    # Seed with an OHLCV-style symbology file — includes an old contract
    # (ESU0) NOT in the TBBO fixture, plus ESU5 which IS in the fixture.
    existing = pd.DataFrame(
        [
            {
                "instrument_id": 900,
                "symbol": "ESU0",
                "first_seen": pd.Timestamp("2020-06-01", tz="UTC"),
                "last_seen": pd.Timestamp("2020-09-18", tz="UTC"),
            },
            {
                "instrument_id": 101,
                "symbol": "ESU5",
                "first_seen": pd.Timestamp("2025-03-15", tz="UTC"),
                "last_seen": pd.Timestamp("2025-05-01", tz="UTC"),
            },
        ]
    )
    pq.write_table(
        pa.Table.from_pandas(existing, preserve_index=False),
        out / "symbology.parquet",
        compression="zstd",
    )

    with patch.object(
        tbbo_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        tbbo_convert.convert_tbbo_dir_to_parquet(tbbo_dir, out)

    merged = pq.read_table(out / "symbology.parquet").to_pandas()
    merged_keys = set(zip(merged["instrument_id"], merged["symbol"], strict=False))

    # OHLCV-era ESU0 must still be present (preservation requirement).
    assert (900, "ESU0") in merged_keys
    # TBBO futures must now be present.
    assert (101, "ESU5") in merged_keys
    assert (202, "NQU5") in merged_keys
    assert (303, "ESH6") in merged_keys

    # For the overlapping ESU5 row, first_seen should be the earlier of the two
    # (2025-03-15 from OHLCV) and last_seen should be the later (2025-06-03
    # from TBBO) — widening the observed range.
    esu5 = merged[merged["symbol"] == "ESU5"].iloc[0]
    assert pd.Timestamp(esu5["first_seen"]) == pd.Timestamp("2025-03-15", tz="UTC")
    assert pd.Timestamp(esu5["last_seen"]) >= pd.Timestamp("2025-06-03", tz="UTC")


def test_symbology_written_from_scratch_when_no_existing(
    tmp_path: Path,
    tbbo_dir: Path,
) -> None:
    """No pre-existing symbology.parquet -> fresh file with only TBBO mappings."""
    out = tmp_path / "out"
    with patch.object(
        tbbo_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        tbbo_convert.convert_tbbo_dir_to_parquet(tbbo_dir, out)

    sym = pq.read_table(out / "symbology.parquet").to_pandas()
    assert set(sym.columns) == {"instrument_id", "symbol", "first_seen", "last_seen"}
    # 3 distinct (instrument_id, symbol) pairs after filtering.
    assert len(sym) == 3


# ---------------------------------------------------------------------------
# Condition.json + summary manifest
# ---------------------------------------------------------------------------


def test_condition_json_is_copied_and_namespaced(
    tmp_path: Path,
    tbbo_dir: Path,
    sample_condition_json: Path,
) -> None:
    """condition.json copied to tbbo_condition.json (not condition.json)."""
    out = tmp_path / "out"
    with patch.object(
        tbbo_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        result = tbbo_convert.convert_tbbo_dir_to_parquet(
            tbbo_dir,
            out,
            condition_path=sample_condition_json,
        )

    # Namespaced to avoid colliding with the OHLCV converter's condition.json.
    dest = out / "tbbo_condition.json"
    assert dest.is_file()
    # 2 of 5 sample days are degraded.
    assert result.degraded_days == 2


def test_summary_json_shape_matches_spec(
    tmp_path: Path,
    tbbo_dir: Path,
) -> None:
    """Summary manifest has all the keys the spec documents."""
    out = tmp_path / "out"
    with patch.object(
        tbbo_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        tbbo_convert.convert_tbbo_dir_to_parquet(tbbo_dir, out)

    summary = json.loads((out / "tbbo_convert_summary.json").read_text())

    # All spec-mandated keys.
    expected_keys = {
        "source_dir",
        "out_dir",
        "schema",
        "total_rows",
        "distinct_instruments",
        "start_date",
        "end_date",
        "years",
        "rows_per_year",
        "rows_per_symbol",
        "degraded_days",
        "files_processed",
        "files_skipped",
        "generated_at",
    }
    assert expected_keys <= set(summary.keys())

    assert summary["schema"] == "tbbo"
    assert summary["total_rows"] == 3
    assert summary["distinct_instruments"] == 3
    assert summary["years"] == [2025, 2026]
    assert summary["rows_per_year"] == {"2025": 2, "2026": 1}
    assert set(summary["rows_per_symbol"].keys()) == {"ESU5", "NQU5", "ESH6"}
    assert summary["files_processed"] == 1
    assert summary["files_skipped"] == 0
    # source/out_dir are absolute paths
    assert Path(summary["source_dir"]).is_absolute()


# ---------------------------------------------------------------------------
# --limit flag
# ---------------------------------------------------------------------------


def test_limit_truncates_rows(
    tmp_path: Path,
    multi_file_tbbo_dir: Path,
) -> None:
    """--limit caps total rows written across all files."""
    out = tmp_path / "out"
    with patch.object(
        tbbo_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        result = tbbo_convert.convert_tbbo_dir_to_parquet(
            multi_file_tbbo_dir,
            out,
            limit=2,
        )

    assert result.total_rows == 2
