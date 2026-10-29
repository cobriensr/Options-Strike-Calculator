"""Tests for the Full Tape zip -> R2-schema Parquet converter and its gate.

Every tape is a tiny CSV zip built in tmp_path from the 40 core columns. The source
selftests ported here (``uw_options_data_lake.py --selftest``) are the no-new-nulls
gate and the zip sniff, limited to what the converter owns: sniffing the HTTP body
is uw_client's job (test_uw_client.py), so the converter's share is refusing a file
that is not a one-CSV zip.
"""

from __future__ import annotations

import csv
import hashlib
import io
import struct
import zipfile
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path

import polars as pl
import pytest

from calendar_nyse import EASTERN
from tape_convert import (
    CORE_SCHEMA,
    TapeValidationError,
    _gate_problems,
    convert_zip,
    plausibility_warnings,
)

SESSION = date(2026, 7, 31)
INGESTED = datetime(2026, 8, 1, 7, 15, 3, 123456, tzinfo=UTC)
TS = pl.Datetime("us", "UTC")
ADDED = ["date", "ingested_at"]

# An independent transcription of scripts/ingest-fulltape.py:30-71 (FULLTAPE_SCHEMA),
# in tape order, so a typo in tape_convert's copy can't vouch for itself.
STR, F64, I32 = pl.String(), pl.Float64(), pl.Int32()
LEGACY_DTYPES: dict[str, pl.DataType] = {
    "id": STR,
    "underlying_symbol": STR,
    "executed_at": TS,
    "nbbo_bid": F64,
    "nbbo_ask": F64,
    "size": I32,
    "price": F64,
    "option_chain_id": STR,
    "alert_score": STR,
    "created_at": TS,
    "report_flags": STR,
    "tags": STR,
    "expiry": pl.Date(),
    "option_type": STR,
    "open_interest": I32,
    "strike": F64,
    "premium": F64,
    "aggregated_trade_id": STR,
    "volume": I32,
    "underlying_price": F64,
    "ewma_nbbo_ask": F64,
    "ewma_nbbo_bid": F64,
    "implied_volatility": F64,
    "delta": F64,
    "theta": F64,
    "gamma": F64,
    "vega": F64,
    "rho": F64,
    "theo": F64,
    "upstream_condition_detail": STR,
    "market_center_locate": I32,
    "canceled": STR,
    "trade_id": pl.Int64(),
    "exchange": STR,
    "ask_vol": I32,
    "bid_vol": I32,
    "no_side_vol": I32,
    "mid_vol": I32,
    "multi_vol": I32,
    "stock_multi_vol": I32,
}
INT32 = [c for c, dtype in LEGACY_DTYPES.items() if dtype == I32]
# What lands in the Parquet: the legacy dtypes, with canceled cast to Boolean.
OUTPUT_DTYPES = LEGACY_DTYPES | {"canceled": pl.Boolean()}
CORE = list(LEGACY_DTYPES)


def _row(**over: str) -> dict[str, str]:
    """One plausible trade; empty fields stay empty, like the real tape's."""
    base = dict.fromkeys(CORE, "") | {
        "id": "019fb85e-0ff4-7953-aec8-a0ad1c0c757d",
        "underlying_symbol": "MSTR",
        "executed_at": "2026-07-31 13:30:00.003764+00",
        "nbbo_bid": "21.90",
        "nbbo_ask": "22.10",
        "size": "1",
        "price": "22.00",
        "option_chain_id": "MSTR270115C00095000",
        "created_at": "2026-07-31 13:30:00.052358+00",
        "report_flags": "{}",
        "tags": "{ask_side,bullish}",
        "expiry": "2027-01-15",
        "option_type": "call",
        "open_interest": "120",
        "strike": "95",
        "premium": "2200",
        "volume": "1",
        "underlying_price": "110.5",
        "implied_volatility": "0.71",
        "delta": "0.62",
        "upstream_condition_detail": "auto",
        "market_center_locate": "7",
        "canceled": "f",
        "trade_id": "0",
        "exchange": "XPHO",
        "ask_vol": "1",
        "bid_vol": "0",
        "no_side_vol": "0",
        "mid_vol": "0",
        "multi_vol": "0",
        "stock_multi_vol": "0",
    }
    return base | over


def _csv_bytes(
    rows: list[dict[str, str]],
    columns: list[str] = CORE,
    *,
    eol: str = "\n",
    trailing_eol: bool = True,
) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator=eol)
    writer.writerow(columns)
    for r in rows:
        writer.writerow([r.get(c, "") for c in columns])
    text = buf.getvalue()
    if not trailing_eol:
        text = text[: -len(eol)]
    return text.encode()


def _zip(
    work: Path,
    payload: bytes,
    *,
    compression: int = zipfile.ZIP_DEFLATED,
    name: str = "full_tape_20260731.csv",
) -> Path:
    path = work / "2026-07-31.zip"
    with zipfile.ZipFile(path, "w", compression=compression) as zf:
        zf.writestr(name, payload)
    return path


@pytest.fixture
def work(tmp_path: Path) -> Path:
    d = tmp_path / "work"
    d.mkdir()
    return d


@pytest.fixture
def out(tmp_path: Path) -> Path:
    return tmp_path / "out" / "2026-07-31-fulltape.parquet"


def _tmp(out: Path) -> Path:
    return out.with_name(out.name + ".tmp")


def _assert_nothing_left(zip_path: Path, out: Path) -> None:
    """No Parquet, no .tmp, and no extracted CSV: the zip's folder holds just the zip."""
    assert not out.exists()
    assert not _tmp(out).exists()
    assert [p.name for p in zip_path.parent.iterdir()] == [zip_path.name]


def _convert_fails(zip_path: Path, out: Path) -> TapeValidationError:
    with pytest.raises(TapeValidationError) as info:
        convert_zip(zip_path, out, SESSION, INGESTED)
    _assert_nothing_left(zip_path, out)
    return info.value


# -- Schema copy -------------------------------------------------------------------


def test_core_schema_is_the_legacy_schema() -> None:
    assert len(CORE_SCHEMA) == 40
    # pl.Schema compares in order, and refuses a bare Datetime with no unit or zone,
    # so this is exact. The copy keeps canceled as the CSV's 't'/'f' text.
    assert pl.Schema(CORE_SCHEMA) == pl.Schema(LEGACY_DTYPES)


# -- Happy path and layout ---------------------------------------------------------


def test_happy_path_layout_and_dtypes(work: Path, out: Path) -> None:
    rows = [
        _row(),
        _row(
            canceled="t",
            executed_at="2026-07-31 19:59:58.5+00",
            created_at="2026-07-31 19:59:59+00",
            size="",
            expiry="",
        ),
    ]
    zip_path = _zip(work, _csv_bytes(rows))

    result = convert_zip(zip_path, out, SESSION, INGESTED)

    df = pl.read_parquet(out)
    assert df.columns == CORE + ADDED
    assert result.columns == CORE + ADDED
    assert dict(df.schema) == OUTPUT_DTYPES | {"date": pl.Date(), "ingested_at": TS}
    assert df.schema["canceled"] == pl.Boolean
    assert df.schema["expiry"] == pl.Date
    assert all(df.schema[c] == pl.Int32 for c in INT32)
    assert df["canceled"].to_list() == [False, True]
    assert df["date"].to_list() == [SESSION, SESSION]
    assert df["ingested_at"].to_list() == [INGESTED, INGESTED]
    # An empty field in a typed column is null; in a text column it stays "" (the
    # legacy objects' convention).
    assert df["size"].to_list() == [1, None]
    assert df["expiry"].to_list() == [date(2027, 1, 15), None]
    assert df["theta"].null_count() == 2
    assert df["alert_score"].to_list() == ["", ""]
    assert df["aggregated_trade_id"].to_list() == ["", ""]

    assert result.rows == 2
    assert result.bytes == out.stat().st_size
    assert result.sha256 == hashlib.sha256(out.read_bytes()).hexdigest()
    assert result.min_executed_at == datetime(2026, 7, 31, 13, 30, 0, 3764, tzinfo=UTC)
    assert result.max_executed_at == datetime(2026, 7, 31, 19, 59, 58, 500000, tzinfo=UTC)
    # Every zstd frame opens with this magic number, and each compressed page is one.
    # (Nothing installed here reads the Parquet codec field itself.)
    assert b"\x28\xb5\x2f\xfd" in out.read_bytes()
    # The zip is the caller's; the extracted CSV and the .tmp are gone.
    assert not _tmp(out).exists()
    assert [p.name for p in work.iterdir()] == [zip_path.name]


def test_extra_column_kept_as_utf8(work: Path, out: Path) -> None:
    # The 2026-09-21 layout inserts trading_hours mid-header and appends more.
    columns = [*CORE[:34], "trading_hours", *CORE[34:], "nbbo_bid_time"]
    rows = [
        _row(trading_hours="rth", nbbo_bid_time="2026-07-31 13:00:00.339175+00"),
        _row(trading_hours="", nbbo_bid_time=""),
    ]
    zip_path = _zip(work, _csv_bytes(rows, columns))

    result = convert_zip(zip_path, out, SESSION, INGESTED)

    df = pl.read_parquet(out)
    assert df.columns == columns + ADDED
    assert result.columns == columns + ADDED
    assert df.schema["trading_hours"] == pl.String
    assert df.schema["nbbo_bid_time"] == pl.String
    assert df["trading_hours"].to_list() == ["rth", ""]
    assert df["nbbo_bid_time"].to_list() == ["2026-07-31 13:00:00.339175+00", ""]
    assert all(df.schema[c] == want for c, want in OUTPUT_DTYPES.items())


def test_tape_column_order_is_kept(work: Path, out: Path) -> None:
    columns = CORE[::-1]
    zip_path = _zip(work, _csv_bytes([_row()], columns))

    convert_zip(zip_path, out, SESSION, INGESTED)

    assert pl.read_parquet_schema(out).names() == columns + ADDED


def test_header_only_tape_is_zero_rows(work: Path, out: Path) -> None:
    zip_path = _zip(work, _csv_bytes([]))

    result = convert_zip(zip_path, out, SESSION, INGESTED)

    assert result.rows == 0
    assert result.min_executed_at is None
    assert result.max_executed_at is None
    assert dict(pl.read_parquet_schema(out)) == OUTPUT_DTYPES | {
        "date": pl.Date(),
        "ingested_at": TS,
    }


def test_aware_ingested_at_is_stored_as_utc(work: Path, out: Path) -> None:
    eastern = datetime(2026, 8, 1, 3, 15, tzinfo=EASTERN)
    convert_zip(_zip(work, _csv_bytes([_row()])), out, SESSION, eastern)

    assert pl.read_parquet(out)["ingested_at"].to_list() == [
        datetime(2026, 8, 1, 7, 15, tzinfo=UTC)
    ]


def test_naive_ingested_at_is_refused(work: Path, out: Path) -> None:
    zip_path = _zip(work, _csv_bytes([_row()]))
    with pytest.raises(ValueError, match="timezone-aware"):
        convert_zip(zip_path, out, SESSION, datetime(2026, 8, 1, 7, 15))
    _assert_nothing_left(zip_path, out)


def test_replaces_an_existing_output(work: Path, out: Path) -> None:
    out.parent.mkdir()
    out.write_bytes(b"stale")
    result = convert_zip(_zip(work, _csv_bytes([_row()])), out, SESSION, INGESTED)

    assert result.sha256 == hashlib.sha256(out.read_bytes()).hexdigest()
    assert pl.read_parquet(out).height == 1


# -- Header failures ---------------------------------------------------------------


def test_missing_core_column_fails(work: Path, out: Path) -> None:
    columns = [c for c in CORE if c != "option_chain_id"]
    zip_path = _zip(work, _csv_bytes([_row()], columns))

    err = _convert_fails(zip_path, out)

    assert str(err) == "missing 1 core column(s): option_chain_id"


def test_empty_csv_fails_naming_every_core_column(work: Path, out: Path) -> None:
    err = _convert_fails(_zip(work, b""), out)

    assert str(err).startswith("missing 40 core column(s): id, underlying_symbol, ")


@pytest.mark.parametrize(
    ("columns", "message"),
    [
        pytest.param([*CORE, "exchange"], "duplicate column(s): exchange", id="repeated"),
        pytest.param([*CORE, "date"], "duplicate column(s): date", id="reserved-date"),
        pytest.param(
            ["ingested_at", *CORE], "duplicate column(s): ingested_at", id="reserved-ingested"
        ),
    ],
)
def test_duplicate_or_reserved_column_fails(
    work: Path, out: Path, columns: list[str], message: str
) -> None:
    # polars would silently rename a repeat to exchange_duplicated_0.
    err = _convert_fails(_zip(work, _csv_bytes([_row()], columns)), out)

    assert str(err) == message


# -- Timestamps and the no-new-nulls gate ------------------------------------------


@pytest.mark.parametrize("column", ["executed_at", "created_at"])
def test_bad_timestamp_fails_and_leaves_no_file(work: Path, out: Path, column: str) -> None:
    rows = [_row(), _row(**{column: "not-a-timestamp"}), _row(**{column: ""})]
    zip_path = _zip(work, _csv_bytes(rows))

    err = _convert_fails(zip_path, out)

    assert str(err) == f"{column} gained 1 null(s) beyond its 1 empty token(s)"
    assert "not-a-timestamp" not in str(err)


def test_empty_timestamp_tokens_stay_null_without_tripping_the_gate(work: Path, out: Path) -> None:
    # Source selftest: "a legitimately empty timestamp stays null without tripping
    # the gate". A whitespace-only token counts as empty too.
    rows = [_row(), _row(created_at=""), _row(created_at="  ")]
    result = convert_zip(_zip(work, _csv_bytes(rows)), out, SESSION, INGESTED)

    df = pl.read_parquet(out)
    assert result.rows == 3
    assert df["created_at"].null_count() == 2
    assert df["executed_at"].null_count() == 0


def test_fraction_lengths_0_to_6_parse(work: Path, out: Path) -> None:
    fractions = ["", ".1", ".12", ".123", ".1234", ".12345", ".123456"]
    micros = [0, 100000, 120000, 123000, 123400, 123450, 123456]
    rows = [_row(executed_at=f"2026-07-31 13:30:01{f}+00") for f in fractions]
    # The source selftest's own pair (2026-10-02 tape): six digits and five digits,
    # then none and one.
    rows += [
        _row(
            executed_at="2026-10-02 13:30:00.002549+00", created_at="2026-10-02 13:30:00.05248+00"
        ),
        _row(executed_at="2026-10-02 13:30:01+00", created_at="2026-10-02 13:30:01.1+00"),
    ]
    convert_zip(_zip(work, _csv_bytes(rows)), out, SESSION, INGESTED)

    df = pl.read_parquet(out, columns=["executed_at", "created_at"])
    assert df["executed_at"].to_list() == [
        *(datetime(2026, 7, 31, 13, 30, 1, us, tzinfo=UTC) for us in micros),
        datetime(2026, 10, 2, 13, 30, 0, 2549, tzinfo=UTC),
        datetime(2026, 10, 2, 13, 30, 1, tzinfo=UTC),
    ]
    assert df["created_at"].to_list()[-2:] == [
        datetime(2026, 10, 2, 13, 30, 0, 52480, tzinfo=UTC),
        datetime(2026, 10, 2, 13, 30, 1, 100000, tzinfo=UTC),
    ]


# -- Row count ---------------------------------------------------------------------


@pytest.mark.parametrize("eol", ["\n", "\r\n"], ids=["lf", "crlf"])
@pytest.mark.parametrize("trailing_eol", [True, False], ids=["trailing-eol", "no-trailing-eol"])
def test_row_count_matches_csv_lines(work: Path, out: Path, eol: str, trailing_eol: bool) -> None:
    payload = _csv_bytes([_row(), _row(), _row()], eol=eol, trailing_eol=trailing_eol)

    result = convert_zip(_zip(work, payload), out, SESSION, INGESTED)

    assert result.rows == 3
    assert pl.read_parquet(out).height == 3


def test_row_count_differing_from_csv_lines_fails(work: Path, out: Path) -> None:
    # A quoted field holding a newline is one row to polars but two lines to the
    # byte scan. The gate trusts the bytes, so this fails loudly (Ruling 1).
    rows = [_row(), _row(tags="{ask_side,\nbullish}")]

    err = _convert_fails(_zip(work, _csv_bytes(rows)), out)

    assert str(err) == "row count 2 != 3 csv lines"


def test_conversion_error_names_no_values(work: Path, out: Path) -> None:
    # polars' own message quotes the bad value, so it must not reach the error,
    # its cause or its context (Sentry walks both).
    rows = [_row(), _row(size="secretvalue")]

    err = _convert_fails(_zip(work, _csv_bytes(rows)), out)

    assert str(err) == "csv conversion failed (ComputeError)"
    assert err.__cause__ is None
    assert err.__suppress_context__


def _raise(exc: BaseException) -> Callable[..., object]:
    def fail(*_args: object, **_kwargs: object) -> object:
        raise exc

    return fail


def test_polars_panic_is_redacted_like_an_error(
    work: Path, out: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A PanicException is a BaseException, not a PolarsError, and its text can quote
    # data; uncaught, it would also pass a caller's `except Exception`.
    zip_path = _zip(work, _csv_bytes([_row()]))
    monkeypatch.setattr(
        "tape_convert.pl.scan_csv", _raise(pl.exceptions.PanicException("secretvalue"))
    )

    err = _convert_fails(zip_path, out)

    assert str(err) == "csv conversion failed (PanicException)"
    assert err.__cause__ is None
    assert err.__suppress_context__
    assert "secretvalue" not in str(err)
    assert "secretvalue" not in repr(err)


def test_runtime_error_outside_the_zip_is_not_relabeled(
    work: Path, out: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # RuntimeError means "encrypted member" only while reading the zip.
    zip_path = _zip(work, _csv_bytes([_row()]))
    monkeypatch.setattr("tape_convert.pl.scan_csv", _raise(RuntimeError("elsewhere")))

    with pytest.raises(RuntimeError) as info:
        convert_zip(zip_path, out, SESSION, INGESTED)
    assert str(info.value) == "elsewhere"
    _assert_nothing_left(zip_path, out)


# -- Corrupt zips and the converter's share of the sniff ---------------------------


def _flip_data_byte(path: Path) -> None:
    """Flip one byte in the middle of the member's compressed data."""
    raw = bytearray(path.read_bytes())
    name_len, extra_len = struct.unpack_from("<HH", raw, 26)
    with zipfile.ZipFile(path) as zf:
        size = zf.infolist()[0].compress_size
    raw[30 + name_len + extra_len + size // 2] ^= 0xFF
    path.write_bytes(bytes(raw))


def _flipped(compression: int) -> Callable[[Path], Path]:
    def make(work: Path) -> Path:
        path = _zip(work, _csv_bytes([_row(), _row(), _row()]), compression=compression)
        _flip_data_byte(path)
        return path

    return make


def _raw(payload: bytes) -> Callable[[Path], Path]:
    def make(work: Path) -> Path:
        path = work / "2026-07-31.zip"
        path.write_bytes(payload)
        return path

    return make


def _truncated(work: Path) -> Path:
    path = _zip(work, _csv_bytes([_row(), _row()]))
    path.write_bytes(path.read_bytes()[: path.stat().st_size // 2])
    return path


def _members(*names: str) -> Callable[[Path], Path]:
    def make(work: Path) -> Path:
        path = work / "2026-07-31.zip"
        with zipfile.ZipFile(path, "w") as zf:
            for name in names:
                zf.writestr(name, b"" if name.endswith("/") else _csv_bytes([_row()]))
        return path

    return make


def _patched(field: str, change: Callable[[int], int]) -> Callable[[Path], Path]:
    """A one-member zip with one 2-byte field rewritten in both the local header (at
    offset 0) and the central-directory entry, so the two agree."""
    local, central = {"flags": (6, 8), "method": (8, 10)}[field]

    def make(work: Path) -> Path:
        path = _zip(work, _csv_bytes([_row()]))
        raw = bytearray(path.read_bytes())
        entry = raw.index(b"PK\x01\x02")
        for offset in (local, entry + central):
            (value,) = struct.unpack_from("<H", raw, offset)
            struct.pack_into("<H", raw, offset, change(value))
        path.write_bytes(bytes(raw))
        return path

    return make


@pytest.mark.parametrize(
    "make",
    [
        # zipfile raises NotImplementedError for deflate64 (method 9): unsupported.
        pytest.param(_patched("method", lambda _old: 9), id="unsupported-method"),
        # ...and RuntimeError for an encrypted member (flag bit 0) with no password.
        pytest.param(_patched("flags", lambda old: old | 0x1), id="encrypted"),
        pytest.param(_flipped(zipfile.ZIP_DEFLATED), id="flipped-byte-deflated"),
        pytest.param(_flipped(zipfile.ZIP_STORED), id="flipped-byte-stored-crc"),
        pytest.param(_truncated, id="truncated"),
        # Source selftest: "a JSON error body saved as .zip is rejected, not parsed".
        pytest.param(
            _raw(b'{"code":"historic_data_access_missing","message":"x"}'), id="json-body"
        ),
        pytest.param(_raw(b""), id="empty-file"),
        pytest.param(_members("a.csv", "b.csv"), id="two-csvs"),
        pytest.param(_members(), id="no-members"),
        pytest.param(_members("full_tape/"), id="directory-only"),
    ],
)
def test_corrupt_zip_fails(work: Path, out: Path, make: Callable[[Path], Path]) -> None:
    err = _convert_fails(make(work), out)

    assert str(err) == "corrupt zip"


# -- The gate, as a pure function (source selftest "Bronze validation gate") -------

GOOD_SCHEMA = OUTPUT_DTYPES | {"date": pl.Date(), "ingested_at": TS}


def _gate(**over: object) -> list[str]:
    args: dict[str, object] = {
        "header": CORE,
        "csv_rows": 100,
        "empty_tokens": {"executed_at": 0, "created_at": 2},
        "schema": GOOD_SCHEMA,
        "rows": 100,
        "null_counts": {"executed_at": 0, "created_at": 2},
    }
    return _gate_problems(**(args | over))


def test_gate_passes_a_faithful_conversion() -> None:
    assert _gate() == []


def test_gate_passes_a_wide_layout() -> None:
    header = [*CORE, "trading_hours", "nbbo_bid_time"]
    schema = OUTPUT_DTYPES | {"trading_hours": pl.String(), "nbbo_bid_time": pl.String()}
    assert _gate(header=header, schema=schema | {"date": pl.Date(), "ingested_at": TS}) == []


@pytest.mark.parametrize(
    ("over", "problem"),
    [
        pytest.param({"rows": 99}, "row count 99 != 100 csv lines", id="row-mismatch"),
        pytest.param(
            {"null_counts": {"executed_at": 1, "created_at": 2}},
            "executed_at gained 1 null(s) beyond its 0 empty token(s)",
            id="new-null",
        ),
        pytest.param(
            {"schema": {c: GOOD_SCHEMA[c] for c in [*CORE[:-1], *ADDED]}},
            "columns differ from the tape header (got 41, expected 42)",
            id="dropped-column",
        ),
        pytest.param(
            {"schema": {c: GOOD_SCHEMA[c] for c in [*CORE[::-1], *ADDED]}},
            "columns differ from the tape header (got 42, expected 42)",
            id="reordered",
        ),
        pytest.param(
            {"schema": GOOD_SCHEMA | {"executed_at": pl.String()}},
            "executed_at is String, expected Datetime(time_unit='us', time_zone='UTC')",
            id="untyped-timestamp",
        ),
        pytest.param(
            {"schema": GOOD_SCHEMA | {"created_at": pl.Datetime("ns", "UTC")}},
            "created_at is Datetime(time_unit='ns', time_zone='UTC'), "
            "expected Datetime(time_unit='us', time_zone='UTC')",
            id="wrong-time-unit",
        ),
        pytest.param(
            {"schema": GOOD_SCHEMA | {"canceled": pl.String()}},
            "canceled is String, expected Boolean",
            id="canceled-not-cast",
        ),
        pytest.param(
            {"schema": GOOD_SCHEMA | {"size": pl.Int64()}},
            "size is Int64, expected Int32",
            id="widened-count",
        ),
        pytest.param(
            {"schema": GOOD_SCHEMA | {"ingested_at": pl.Datetime("us")}},
            "ingested_at is Datetime(time_unit='us', time_zone=None), "
            "expected Datetime(time_unit='us', time_zone='UTC')",
            id="naive-ingested-at",
        ),
    ],
)
def test_gate_fails(over: dict[str, object], problem: str) -> None:
    assert _gate(**over) == [problem]


def test_gate_fails_an_extra_column_that_is_not_utf8() -> None:
    header = [*CORE, "trading_hours"]
    schema = OUTPUT_DTYPES | {"trading_hours": pl.Int64(), "date": pl.Date(), "ingested_at": TS}
    assert _gate(header=header, schema=schema) == ["trading_hours is Int64, expected String"]


# -- Plausibility (warnings, never failures) ---------------------------------------


def _et(day: date, hour: int, minute: int = 0, second: int = 0) -> datetime:
    """An Eastern wall-clock time, as the UTC instant ConvertResult carries."""
    return datetime(day.year, day.month, day.day, hour, minute, second, tzinfo=EASTERN).astimezone(
        UTC
    )


JUNE_15 = date(2026, 6, 15)
OPEN, CLOSE = _et(JUNE_15, 9, 30), _et(JUNE_15, 18, 4, 15)
MEDIAN = 1_000_000
# Ten days whose median is exactly MEDIAN.
TRAILING = [MEDIAN + 1_000 * d for d in (-100, -50, -20, -10, 0, 0, 10, 50, 100, 200)]


@pytest.mark.parametrize(
    ("rows", "trailing", "warns"),
    [
        pytest.param(640_000, TRAILING, True, id="0.64-warns"),
        pytest.param(650_000, TRAILING, False, id="0.65-exactly-does-not"),
        pytest.param(660_000, TRAILING, False, id="0.66-does-not"),
        pytest.param(640_000, TRAILING[:9], False, id="fewer-than-10-trailing"),
        pytest.param(0, [], False, id="no-history"),
    ],
)
def test_plausibility_ratio(rows: int, trailing: list[int], warns: bool) -> None:
    assert len(TRAILING) == 10
    warnings = plausibility_warnings(rows, trailing, OPEN, CLOSE, JUNE_15)

    if warns:
        assert warnings == ["rows 640,000 below 0.65 x the trailing median 1,000,000 of 10 day(s)"]
    else:
        assert warnings == []


JUNE_START = "executed_at starts before the session window (2026-06-14T20:00-04:00)"
JUNE_END = "executed_at ends at or after the session window end (2026-06-15T20:00-04:00)"


@pytest.mark.parametrize(
    ("session", "low", "high", "expected"),
    [
        pytest.param(JUNE_15, OPEN, CLOSE, [], id="a-normal-day"),
        pytest.param(
            JUNE_15, OPEN, _et(JUNE_15, 20, 30), [JUNE_END], id="20:30-et-on-the-session-date-warns"
        ),
        pytest.param(JUNE_15, OPEN, _et(JUNE_15, 20), [JUNE_END], id="the-window-end-is-exclusive"),
        pytest.param(JUNE_15, OPEN, _et(JUNE_15, 19, 59, 59), [], id="just-inside-the-end"),
        pytest.param(JUNE_15, _et(date(2026, 6, 14), 20), CLOSE, [], id="the-start-is-inclusive"),
        pytest.param(
            JUNE_15,
            _et(date(2026, 6, 14), 19, 59, 59),
            CLOSE,
            [JUNE_START],
            id="before-the-start-warns",
        ),
        pytest.param(
            JUNE_15,
            _et(date(2026, 6, 12), 9, 30),
            _et(JUNE_15, 21),
            [JUNE_START, JUNE_END],
            id="both-ends",
        ),
        # EST: 20:00 ET is 01:00 UTC the next day.
        pytest.param(
            date(2026, 1, 2),
            datetime(2026, 1, 2, 14, 30, tzinfo=UTC),
            datetime(2026, 1, 3, 0, 30, tzinfo=UTC),
            [],
            id="est-19:30-does-not",
        ),
        pytest.param(
            date(2026, 1, 2),
            datetime(2026, 1, 2, 14, 30, tzinfo=UTC),
            datetime(2026, 1, 3, 1, 30, tzinfo=UTC),
            ["executed_at ends at or after the session window end (2026-01-02T20:00-05:00)"],
            id="est-20:30-warns",
        ),
        pytest.param(JUNE_15, None, None, [], id="no-timestamps"),
    ],
)
def test_plausibility_time_window(
    session: date, low: datetime | None, high: datetime | None, expected: list[str]
) -> None:
    warnings = plausibility_warnings(MEDIAN, TRAILING, low, high, session)

    assert warnings == expected
    # The warning names the crossed edge, never the observed value (logs and Sentry
    # must not carry UW-derived data), in any of the usual renderings.
    for observed in (t for t in (low, high) if t is not None):
        eastern = observed.astimezone(EASTERN)
        for text in (
            observed.isoformat(),
            eastern.isoformat(timespec="seconds"),
            eastern.strftime("%H:%M:%S"),
        ):
            assert all(text not in w for w in warnings), text


def test_plausibility_reports_both_kinds_together() -> None:
    warnings = plausibility_warnings(100, TRAILING, OPEN, _et(JUNE_15, 20, 30), JUNE_15)

    assert warnings == [
        "rows 100 below 0.65 x the trailing median 1,000,000 of 10 day(s)",
        JUNE_END,
    ]
