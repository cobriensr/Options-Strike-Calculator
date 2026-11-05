"""Convert one day's Full Tape zip to R2-schema Parquet, behind a validation gate.

The extract, the string-to-datetime parse and the no-new-nulls gate are adapted from
Unusual Whales' ``uw-options-data-lake`` skill,
https://unusualwhales.com/skills/uw-options-data-lake-skill.md, fetched 2026-10-28,
sha256 a99ecce6361a295d7ded72e804e9ec77e4fbec94cdace1c0b24c02551596f8bb
(script lines 90-93 and 1006-1230). No license is stated; vendored by owner decision
2026-10-28.

Changes from that code, per the 2026-10-28 review and the R2 layout:
- (b8) Dtypes are pinned, never inferred: the 40 core columns get the legacy R2
  dtypes (``CORE_SCHEMA``), every other column stays text, and empty strings stay
  ``""``. The timestamps alone go through the source's text parse and its gate.
- (b9) The row count is checked against the CSV's own line count, from a byte scan
  during extraction, not against a second polars read of the same file.
- (b1) The Parquet is written to ``<out>.tmp``, gated, hashed and only then renamed
  over ``<out>``. The ``.tmp`` and the extracted CSV never survive the call.
- (b7) A bad zip is a ``TapeValidationError``, not an uncaught ``BadZipFile``.
- Errors name columns and counts only. polars' own messages (and panics) quote cell
  values, so they are dropped (``from None``) rather than chained, and never reach
  Sentry.

The legacy writer passed scan_csv ``missing_utf8_is_empty_string=True``. polars 1.43.0
renamed that parameter to ``empty_string_is_null`` and inverted it, and polars 2
removed the old name, so the same behavior is now ``empty_string_is_null=False``.
"""

from __future__ import annotations

import csv
import hashlib
import statistics
import zipfile
import zlib
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path

import polars as pl

from calendar_nyse import EASTERN, TAPE_AVAILABLE_HOUR_ET
from constants import PLAUSIBLE_MIN_ROW_RATIO, PLAUSIBLE_MIN_TRAILING, ROW_GROUP_SIZE

# A copy of FULLTAPE_SCHEMA, scripts/ingest-fulltape.py:30-71, which wrote the 112
# legacy days in R2. Keep the two in step: this is the layout those objects carry.
CORE_SCHEMA: dict[str, pl.DataType] = {
    "id": pl.Utf8,
    "underlying_symbol": pl.Utf8,
    "executed_at": pl.Datetime("us", "UTC"),
    "nbbo_bid": pl.Float64,
    "nbbo_ask": pl.Float64,
    "size": pl.Int32,
    "price": pl.Float64,
    "option_chain_id": pl.Utf8,
    "alert_score": pl.Utf8,
    "created_at": pl.Datetime("us", "UTC"),
    "report_flags": pl.Utf8,
    "tags": pl.Utf8,
    "expiry": pl.Date,
    "option_type": pl.Utf8,
    "open_interest": pl.Int32,
    "strike": pl.Float64,
    "premium": pl.Float64,
    "aggregated_trade_id": pl.Utf8,
    "volume": pl.Int32,
    "underlying_price": pl.Float64,
    "ewma_nbbo_ask": pl.Float64,
    "ewma_nbbo_bid": pl.Float64,
    "implied_volatility": pl.Float64,
    "delta": pl.Float64,
    "theta": pl.Float64,
    "gamma": pl.Float64,
    "vega": pl.Float64,
    "rho": pl.Float64,
    "theo": pl.Float64,
    "upstream_condition_detail": pl.Utf8,
    "market_center_locate": pl.Int32,
    "canceled": pl.Utf8,  # 'f' | 't' in the CSV; stored as Boolean
    "trade_id": pl.Int64,
    "exchange": pl.Utf8,
    "ask_vol": pl.Int32,
    "bid_vol": pl.Int32,
    "no_side_vol": pl.Int32,
    "mid_vol": pl.Int32,
    "multi_vol": pl.Int32,
    "stock_multi_vol": pl.Int32,
}

TIMESTAMP_COLUMNS = ("executed_at", "created_at")
TIMESTAMP_DTYPE = pl.Datetime("us", "UTC")
# The tape writes "2026-10-02 13:30:00.05248+00": the fraction drops trailing zeros,
# so it runs 0-6 digits. polars 1.x inference nulled values whose fraction length
# differed from the first row's (the source's finding); an explicit %.f never does.
TAPE_TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S%.f%#z"
ADDED_COLUMNS = ("date", "ingested_at")

# What the CSV is read as: the core dtypes, with the timestamps left as text for
# the gated parse. Every non-core column defaults to text (infer_schema_length=0).
_READ_SCHEMA = CORE_SCHEMA | dict.fromkeys(TIMESTAMP_COLUMNS, pl.Utf8)
# What lands in the Parquet. pl.Schema turns the dtype classes into exact instances.
_OUTPUT_SCHEMA = pl.Schema(
    CORE_SCHEMA | {"canceled": pl.Boolean, "date": pl.Date, "ingested_at": TIMESTAMP_DTYPE}
)
_CHUNK = 1 << 20
# What zipfile raises for a zip it can't extract: a bad archive or CRC, a bad deflate
# stream, a short read, an unsupported compression method (NotImplementedError) or an
# encrypted member (RuntimeError; NotImplementedError is its subclass, named for the
# reader). Caught only around the zip open and extract, so a RuntimeError from
# anywhere else is never relabeled.
_CORRUPT_ZIP = (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError)


class TapeValidationError(Exception):
    """The zip, its CSV or the Parquet failed the gate. Messages name columns and
    counts only, never a cell value, so they are safe for logs and Sentry."""


@dataclass(frozen=True)
class ConvertResult:
    """A Parquet that passed the gate. ``columns`` are the Parquet's: the tape
    header in its own order, then date and ingested_at."""

    rows: int
    columns: list[str]
    sha256: str
    bytes: int
    min_executed_at: datetime | None
    max_executed_at: datetime | None


def convert_zip(
    zip_path: Path, out_path: Path, session: date, ingested_at: datetime
) -> ConvertResult:
    """Convert the tape zip to ``out_path`` and return what landed.

    The CSV is extracted next to the zip and deleted before returning; the zip is
    the caller's. Raises TapeValidationError when the gate fails, and ``out_path``
    is written only when it passes.
    """
    if ingested_at.tzinfo is None:
        raise ValueError("ingested_at must be timezone-aware")
    csv_path = zip_path.with_name(zip_path.name + ".csv")
    tmp_path = out_path.with_name(out_path.name + ".tmp")
    try:
        csv_rows = _extract_csv(zip_path, csv_path) - 1  # minus the header line
        header = _read_header(csv_path)
        _check_header(header)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            empty_tokens = _empty_tokens(csv_path)
            _sink(csv_path, tmp_path, session, ingested_at)
            schema = pl.scan_parquet(tmp_path).collect_schema()
            stats = (
                pl.scan_parquet(tmp_path)
                .select(
                    pl.len().alias("__rows__"),
                    *(pl.col(c).null_count().alias(c) for c in TIMESTAMP_COLUMNS),
                    pl.col("executed_at").min().alias("__min__"),
                    pl.col("executed_at").max().alias("__max__"),
                )
                .collect()
                .row(0, named=True)
            )
        # A polars panic is a BaseException, not a PolarsError, and its text can quote
        # data too. Left uncaught it would also slip past a caller's `except Exception`.
        except (pl.exceptions.PolarsError, pl.exceptions.PanicException) as exc:
            raise TapeValidationError(f"csv conversion failed ({type(exc).__name__})") from None
        problems = _gate_problems(
            header=header,
            csv_rows=csv_rows,
            empty_tokens=empty_tokens,
            schema=schema,
            rows=stats["__rows__"],
            null_counts={c: stats[c] for c in TIMESTAMP_COLUMNS},
        )
        if problems:
            raise TapeValidationError("; ".join(problems))
        with tmp_path.open("rb") as f:
            sha256 = hashlib.file_digest(f, "sha256").hexdigest()
        result = ConvertResult(
            rows=stats["__rows__"],
            columns=list(schema),
            sha256=sha256,
            bytes=tmp_path.stat().st_size,
            min_executed_at=stats["__min__"],
            max_executed_at=stats["__max__"],
        )
        tmp_path.replace(out_path)
    finally:
        tmp_path.unlink(missing_ok=True)
        csv_path.unlink(missing_ok=True)
    return result


def session_window(session: date) -> tuple[datetime, datetime]:
    """The tape's own daily boundary, [session - 1 day 20:00 ET, session 20:00 ET):
    the start is inclusive, the end exclusive."""
    boundary = time(TAPE_AVAILABLE_HOUR_ET)
    start = datetime.combine(session - timedelta(days=1), boundary, tzinfo=EASTERN)
    return start, datetime.combine(session, boundary, tzinfo=EASTERN)


def plausibility_warnings(
    rows: int,
    baseline_rows: list[int],
    min_executed_at: datetime | None,
    max_executed_at: datetime | None,
    session: date,
) -> list[str]:
    """Reasons a converted day looks off. Warnings only: a day that passed the gate
    still lands.

    `baseline_rows` are the row counts of nearby landed days. The window is
    `session_window`. A warning names the edge that was crossed, never the observed
    timestamp: warnings reach logs and Sentry, and UW-derived values must not.
    """
    warnings: list[str] = []
    if len(baseline_rows) >= PLAUSIBLE_MIN_TRAILING:
        median = statistics.median(baseline_rows)
        if rows < PLAUSIBLE_MIN_ROW_RATIO * median:
            warnings.append(
                f"rows {rows:,} below {PLAUSIBLE_MIN_ROW_RATIO} x the baseline median "
                f"{median:,.0f} of {len(baseline_rows)} day(s)"
            )
    start, end = session_window(session)
    if min_executed_at is not None and min_executed_at < start:
        warnings.append(
            f"executed_at starts before the session window ({start.isoformat(timespec='minutes')})"
        )
    if max_executed_at is not None and max_executed_at >= end:
        warnings.append(
            "executed_at ends at or after the session window end "
            f"({end.isoformat(timespec='minutes')})"
        )
    return warnings


def _extract_csv(zip_path: Path, csv_path: Path) -> int:
    """Stream the zip's one member to `csv_path` and return its line count.

    Lines are counted from the bytes as they are written: newlines, plus one for a
    last line that has none. Anything that stops zipfile extracting the member,
    including a CRC mismatch at its end, an unsupported compression method or
    encryption, raises TapeValidationError("corrupt zip"). The block holds only zip
    and file I/O, and file I/O raises OSError, which passes through unrelabeled.
    """
    try:
        with zipfile.ZipFile(zip_path) as zf:
            members = zf.infolist()
            if len(members) != 1 or members[0].is_dir():
                raise TapeValidationError("corrupt zip")
            lines = 0
            last = b""
            with zf.open(members[0]) as src, csv_path.open("wb") as dst:
                while chunk := src.read(_CHUNK):
                    dst.write(chunk)
                    lines += chunk.count(b"\n")
                    last = chunk[-1:]
    except _CORRUPT_ZIP as exc:
        raise TapeValidationError("corrupt zip") from exc
    if last not in (b"", b"\n"):
        lines += 1
    return lines


def _read_header(csv_path: Path) -> list[str]:
    # utf-8-sig drops a byte-order mark, as polars does.
    try:
        with csv_path.open(encoding="utf-8-sig", newline="") as f:
            return next(csv.reader(f), [])
    except (csv.Error, UnicodeDecodeError):
        raise TapeValidationError("unreadable csv header") from None


def _check_header(header: list[str]) -> None:
    missing = [c for c in CORE_SCHEMA if c not in header]
    if missing:
        raise TapeValidationError(f"missing {len(missing)} core column(s): {', '.join(missing)}")
    # polars would rename a repeat to <name>_duplicated_0, and a tape column named
    # date or ingested_at would be overwritten by ours.
    repeated = sorted(c for c, n in Counter([*header, *ADDED_COLUMNS]).items() if n > 1)
    if repeated:
        raise TapeValidationError(f"duplicate column(s): {', '.join(repeated)}")


def _scan(csv_path: Path) -> pl.LazyFrame:
    return pl.scan_csv(
        csv_path,
        infer_schema_length=0,
        empty_string_is_null=False,
        schema_overrides=_READ_SCHEMA,
    )


def _empty_tokens(csv_path: Path) -> dict[str, int]:
    """Per timestamp column, the empty or whitespace-only source values: the nulls
    the parse is allowed to produce."""
    row = (
        _scan(csv_path)
        .select(
            (pl.col(c).is_null() | (pl.col(c).str.strip_chars() == "")).sum().alias(c)
            for c in TIMESTAMP_COLUMNS
        )
        .collect(engine="streaming")
        .row(0, named=True)
    )
    return {c: int(row[c]) for c in TIMESTAMP_COLUMNS}


def _sink(csv_path: Path, tmp_path: Path, session: date, ingested_at: datetime) -> None:
    lf = _scan(csv_path).with_columns(
        *(
            # strict=False: an unparseable value becomes null, which the gate counts.
            pl.col(c).str.to_datetime(
                TAPE_TIMESTAMP_FORMAT, time_unit="us", time_zone="UTC", strict=False
            )
            for c in TIMESTAMP_COLUMNS
        ),
        (pl.col("canceled") == "t").alias("canceled"),
        pl.lit(session, dtype=pl.Date).alias("date"),
        pl.lit(ingested_at.astimezone(UTC), dtype=TIMESTAMP_DTYPE).alias("ingested_at"),
    )
    lf.sink_parquet(
        tmp_path,
        compression="zstd",
        compression_level=3,
        row_group_size=ROW_GROUP_SIZE,
        statistics=True,
    )


def _gate_problems(
    *,
    header: list[str],
    csv_rows: int,
    empty_tokens: dict[str, int],
    schema: dict[str, pl.DataType],
    rows: int,
    null_counts: dict[str, int],
) -> list[str]:
    """Every way the Parquet is not a faithful copy of the CSV; empty means it is."""
    problems: list[str] = []
    expected = [*header, *ADDED_COLUMNS]
    if list(schema) != expected:
        problems.append(
            f"columns differ from the tape header (got {len(schema)}, expected {len(expected)})"
        )
    if rows != csv_rows:
        problems.append(f"row count {rows} != {csv_rows} csv lines")
    for column in expected:
        want = _OUTPUT_SCHEMA.get(column, pl.String())
        got = schema.get(column)
        if got is not None and got != want:
            problems.append(f"{column} is {got}, expected {want}")
    for column in TIMESTAMP_COLUMNS:
        new_nulls = null_counts[column] - empty_tokens[column]
        if new_nulls > 0:
            problems.append(
                f"{column} gained {new_nulls} null(s) beyond its "
                f"{empty_tokens[column]} empty token(s)"
            )
    return problems
