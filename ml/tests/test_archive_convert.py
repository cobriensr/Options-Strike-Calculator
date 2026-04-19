"""Tests for archive_convert — the DBN → Parquet converter.

We don't try to construct a real DBN file in-process (the databento-dbn
binary format is not designed to be written from user code); instead we
stub out ``databento.DBNStore.from_file`` to return a fake store whose
``to_df`` method yields a small hand-built DataFrame. That's enough to
exercise every real code path: schema guard, column normalization,
year partitioning, symbology aggregation, condition.json handling, and
the summary manifest.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import pyarrow.parquet as pq
import pytest

import archive_convert

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_fake_df() -> pd.DataFrame:
    """Build a tiny OHLCV-1m DataFrame spanning two years + two instruments."""
    tz = UTC
    rows = [
        # 2020 bars
        {
            "ts_event": datetime(2020, 6, 1, 14, 30, tzinfo=tz),
            "instrument_id": 101,
            "symbol": "ESU0",
            "open": 3100.0, "high": 3105.0, "low": 3099.5,
            "close": 3104.0, "volume": 1500,
        },
        {
            "ts_event": datetime(2020, 6, 1, 14, 31, tzinfo=tz),
            "instrument_id": 101,
            "symbol": "ESU0",
            "open": 3104.0, "high": 3107.0, "low": 3102.0,
            "close": 3106.5, "volume": 2100,
        },
        {
            "ts_event": datetime(2020, 12, 1, 20, 0, tzinfo=tz),
            "instrument_id": 202,
            "symbol": "ES 20 12 18 C3500",
            "open": 12.5, "high": 13.0, "low": 12.3,
            "close": 12.8, "volume": 45,
        },
        # 2021 bar — same underlying but new contract id
        {
            "ts_event": datetime(2021, 1, 4, 14, 30, tzinfo=tz),
            "instrument_id": 303,
            "symbol": "ESH1",
            "open": 3700.0, "high": 3702.0, "low": 3699.0,
            "close": 3701.0, "volume": 4200,
        },
    ]
    df = pd.DataFrame(rows)
    # Match real Databento SDK shape: to_df() returns ts_event as the
    # DatetimeIndex, NOT a plain column. Testing against this shape is
    # the difference between "tests pass + converter breaks on real
    # file" (as happened on first run) and catching it locally.
    df["ts_event"] = pd.to_datetime(df["ts_event"], utc=True)
    df = df.set_index("ts_event")
    return df


class _FakeStore:
    """Minimal DBNStore stand-in."""

    def __init__(self, schema: str = "ohlcv-1m", df: pd.DataFrame | None = None):
        self.schema = schema
        self._df = df if df is not None else _make_fake_df()

    def to_df(self, **_kwargs: object) -> pd.DataFrame:
        return self._df.copy()


@pytest.fixture
def fake_dbn_file(tmp_path: Path) -> Path:
    """Create a placeholder file so the converter's existence check passes."""
    path = tmp_path / "fake.dbn.zst"
    path.write_bytes(b"placeholder")
    return path


@pytest.fixture
def sample_condition_json(tmp_path: Path) -> Path:
    """Write a fake condition.json alongside the fake DBN."""
    path = tmp_path / "condition.json"
    path.write_text(json.dumps([
        {"date": "2020-06-01", "condition": "available"},
        {"date": "2020-06-02", "condition": "available"},
        {"date": "2020-06-03", "condition": "degraded"},
        {"date": "2020-06-04", "condition": "degraded"},
        {"date": "2020-06-05", "condition": "available"},
    ]))
    return path


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_conversion_produces_year_partitions(
    tmp_path: Path,
    fake_dbn_file: Path,
) -> None:
    out = tmp_path / "out"
    with patch.object(
        archive_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        result = archive_convert.convert_dbn_to_parquet(fake_dbn_file, out)

    # One year=2020 partition, one year=2021 partition — both present.
    assert (out / "ohlcv_1m" / "year=2020" / "part.parquet").is_file()
    assert (out / "ohlcv_1m" / "year=2021" / "part.parquet").is_file()

    # Summary aggregates match the fake input.
    assert result.total_rows == 4
    assert result.distinct_instruments == 3
    assert result.years == [2020, 2021]
    assert result.rows_per_year == {2020: 3, 2021: 1}
    assert result.schema == "ohlcv-1m"


def test_parquet_content_round_trips(
    tmp_path: Path,
    fake_dbn_file: Path,
) -> None:
    out = tmp_path / "out"
    with patch.object(
        archive_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        archive_convert.convert_dbn_to_parquet(fake_dbn_file, out)

    part_path = out / "ohlcv_1m" / "year=2020" / "part.parquet"

    # The on-disk schema must NOT include 'year' — we strip it before
    # writing since it's encoded in the directory partition. Use
    # read_schema to check the raw file, bypassing PyArrow's friendly
    # hive-partition auto-injection on read_table().
    on_disk_cols = pq.read_schema(part_path).names
    assert "year" not in on_disk_cols

    # When read via read_table(path), PyArrow auto-injects the partition
    # column from the directory name — so downstream backtests get
    # 'year' for free. This is desired behavior.
    df_2020 = pq.read_table(part_path).to_pandas()
    assert {"ts_event", "instrument_id", "symbol", "open", "high", "low", "close", "volume"} <= set(df_2020.columns)
    assert "year" in df_2020.columns
    assert (df_2020["year"] == 2020).all()

    assert len(df_2020) == 3
    assert set(df_2020["instrument_id"].unique()) == {101, 202}


def test_symbology_parquet_is_written_with_date_range(
    tmp_path: Path,
    fake_dbn_file: Path,
) -> None:
    out = tmp_path / "out"
    with patch.object(
        archive_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        archive_convert.convert_dbn_to_parquet(fake_dbn_file, out)

    sym_path = out / "symbology.parquet"
    assert sym_path.is_file()

    sym = pq.read_table(sym_path).to_pandas()
    assert set(sym.columns) == {"instrument_id", "symbol", "first_seen", "last_seen"}
    assert len(sym) == 3  # three distinct (instrument_id, symbol) pairs
    es_u0 = sym[sym["symbol"] == "ESU0"].iloc[0]
    assert es_u0["instrument_id"] == 101
    # first_seen/last_seen span the two 2020 rows.
    assert es_u0["first_seen"] < es_u0["last_seen"]


def test_summary_json_is_written(
    tmp_path: Path,
    fake_dbn_file: Path,
) -> None:
    out = tmp_path / "out"
    with patch.object(
        archive_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        archive_convert.convert_dbn_to_parquet(fake_dbn_file, out)

    summary = json.loads((out / "convert_summary.json").read_text())
    assert summary["schema"] == "ohlcv-1m"
    assert summary["total_rows"] == 4
    assert summary["distinct_instruments"] == 3
    assert summary["years"] == [2020, 2021]
    assert summary["rows_per_year"] == {"2020": 3, "2021": 1}
    assert "generated_at" in summary
    # source/out_dir are absolute paths
    assert Path(summary["source_file"]).is_absolute()


# ---------------------------------------------------------------------------
# Condition.json handling
# ---------------------------------------------------------------------------


def test_condition_json_is_copied_and_counted(
    tmp_path: Path,
    fake_dbn_file: Path,
    sample_condition_json: Path,
) -> None:
    out = tmp_path / "out"
    with patch.object(
        archive_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        result = archive_convert.convert_dbn_to_parquet(
            fake_dbn_file,
            out,
            condition_path=sample_condition_json,
        )

    dest = out / "condition.json"
    assert dest.is_file()
    # 2 of 5 sample days marked degraded.
    assert result.degraded_days == 2

    # The file content is copied verbatim.
    assert json.loads(dest.read_text()) == json.loads(
        sample_condition_json.read_text()
    )


def test_missing_condition_json_is_graceful(
    tmp_path: Path,
    fake_dbn_file: Path,
) -> None:
    out = tmp_path / "out"
    with patch.object(
        archive_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        result = archive_convert.convert_dbn_to_parquet(
            fake_dbn_file,
            out,
            condition_path=tmp_path / "does_not_exist.json",
        )

    assert result.degraded_days == 0
    assert not (out / "condition.json").exists()


# ---------------------------------------------------------------------------
# Guard rails
# ---------------------------------------------------------------------------


def test_wrong_schema_raises(
    tmp_path: Path,
    fake_dbn_file: Path,
) -> None:
    out = tmp_path / "out"
    with patch.object(
        archive_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(schema="trades"),
    ):
        with pytest.raises(ValueError, match="ohlcv-1m"):
            archive_convert.convert_dbn_to_parquet(fake_dbn_file, out)


def test_missing_input_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        archive_convert.convert_dbn_to_parquet(
            tmp_path / "no_such_file.dbn.zst",
            tmp_path / "out",
        )


def test_missing_required_column_raises(
    tmp_path: Path,
    fake_dbn_file: Path,
) -> None:
    """If databento ever renames e.g. 'close' we fail loud on first run."""
    bad_df = _make_fake_df().drop(columns=["close"])
    with patch.object(
        archive_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(df=bad_df),
    ):
        with pytest.raises(RuntimeError, match="missing expected columns"):
            archive_convert.convert_dbn_to_parquet(fake_dbn_file, tmp_path / "out")


def test_raw_symbol_column_is_normalized_to_symbol(
    tmp_path: Path,
    fake_dbn_file: Path,
) -> None:
    """Some SDK versions use 'raw_symbol'; the converter renames it."""
    old_df = _make_fake_df().rename(columns={"symbol": "raw_symbol"})
    out = tmp_path / "out"
    with patch.object(
        archive_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(df=old_df),
    ):
        archive_convert.convert_dbn_to_parquet(fake_dbn_file, out)

    df = pq.read_table(out / "ohlcv_1m" / "year=2020" / "part.parquet").to_pandas()
    assert "symbol" in df.columns
    assert "raw_symbol" not in df.columns


# ---------------------------------------------------------------------------
# --limit flag
# ---------------------------------------------------------------------------


def test_limit_truncates_before_partitioning(
    tmp_path: Path,
    fake_dbn_file: Path,
) -> None:
    out = tmp_path / "out"
    with patch.object(
        archive_convert.db.DBNStore,
        "from_file",
        return_value=_FakeStore(),
    ):
        result = archive_convert.convert_dbn_to_parquet(
            fake_dbn_file,
            out,
            limit=2,
        )

    assert result.total_rows == 2
    # Only 2020 rows written — 2021 row was past the limit.
    assert result.years == [2020]
    assert not (out / "ohlcv_1m" / "year=2021").exists()
