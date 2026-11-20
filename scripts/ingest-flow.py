#!/usr/bin/env python3
"""Ingest a UW EOD options flow CSV: validate it and write the Bot-EOD archive Parquet.

The archive is the full, unfiltered {date}-trades.parquet in --archive-dir. The
source CSV is deleted once the archive is written and its closed-enum columns
check out, unless --keep-csv.

Nothing is uploaded. The CDT-window copy this script used to push to Vercel Blob
(flow/year=.../data.parquet) is retired: the Blob archive is frozen at 46 days
(2026-04-13 -> 2026-06-16), and its reader, ml/src/flow_archive.py, keeps working.
The Railway `nightly` job builds the flow research outputs from the Full Tape in R2.

Usage:
    ml/.venv/Scripts/python scripts/ingest-flow.py <YYYY-MM-DD>
    ml/.venv/Scripts/python scripts/ingest-flow.py 2026-04-24 --keep-csv

Spec: docs/superpowers/specs/options-flow-archive-2026-04-28.md
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import polars as pl

# --- Schema (frozen — pinned to docs/superpowers/specs/options-flow-archive-2026-04-28.md) ---

FLOW_SCHEMA: dict[str, pl.DataType] = {
    "executed_at": pl.Datetime("us", "UTC"),
    "underlying_symbol": pl.Utf8,
    "option_chain_id": pl.Utf8,
    "side": pl.Utf8,
    "strike": pl.Float64,
    "option_type": pl.Utf8,
    "expiry": pl.Date,
    "underlying_price": pl.Float64,
    "nbbo_bid": pl.Float64,
    "nbbo_ask": pl.Float64,
    "ewma_nbbo_bid": pl.Float64,
    "ewma_nbbo_ask": pl.Float64,
    "price": pl.Float64,
    "size": pl.Int32,
    "premium": pl.Float64,
    "volume": pl.Int32,
    "open_interest": pl.Int32,
    "implied_volatility": pl.Float64,
    "delta": pl.Float64,
    "theta": pl.Float64,
    "gamma": pl.Float64,
    "vega": pl.Float64,
    "rho": pl.Float64,
    "theo": pl.Float64,
    "sector": pl.Utf8,
    "exchange": pl.Utf8,
    "report_flags": pl.Utf8,
    # UW emits `f`/`t` literals here, not bools. The archive keeps them as is.
    "canceled": pl.Utf8,
    "upstream_condition_detail": pl.Utf8,
    "equity_type": pl.Utf8,
}

VALID_SIDE = {"ask", "bid", "mid", "no_side"}
VALID_OPTION_TYPE = {"put", "call"}
VALID_EQUITY_TYPE = {"ADR", "Common Stock", "ETF", "Index", "Other", "Unit"}

SANITY_FLOOR_ROWS = 1_000_000

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT_DIR = Path.home() / "Downloads" / "EOD-OptionFlow"
# Full unfiltered archive of the source CSV. Written BEFORE any filtering so
# the CSV is recoverable to its original row count even if a reader's filter
# changes. The CSV is deleted only after this archive is written and checked.
# Default for --archive-dir; the Makefile passes its PARQUET_DIR, which the
# enrich scripts then read.
DEFAULT_ARCHIVE_DIR = Path.home() / "Desktop" / "Bot-Eod-parquet"


def expected_csv_path(date: str, input_dir: Path) -> Path:
    return input_dir / f"bot-eod-report-{date}.csv"


def archive_parquet_path(date: str, archive_dir: Path) -> Path:
    return archive_dir / f"{date}-trades.parquet"


def write_full_archive(lf: pl.LazyFrame, archive_path: Path) -> None:
    """Stream the full unfiltered LazyFrame to disk as Parquet.

    Uses `sink_parquet` so the 11M-row, 3 GB CSV is never fully materialized in
    memory. No filtering, no added columns — this is the recovery copy of the
    raw CSV, zstd level 3.

    Writes via a .tmp sibling + atomic rename: the caller skips the write
    whenever archive_path exists, so a truncated file left by a crash
    mid-write would otherwise be locked in permanently.
    """
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = archive_path.with_name(archive_path.name + ".tmp")
    lf.sink_parquet(
        tmp_path,
        compression="zstd",
        compression_level=3,
        row_group_size=1_048_576,
        statistics=True,
    )
    tmp_path.rename(archive_path)


def validate_header(csv_path: Path) -> None:
    """Hard-fail if header doesn't match the 30 expected columns in order."""
    expected = list(FLOW_SCHEMA.keys())
    with csv_path.open("r") as f:
        header = f.readline().strip().split(",")
    if header != expected:
        missing = sorted(set(expected) - set(header))
        extra = sorted(set(header) - set(expected))
        raise ValueError(
            f"CSV header mismatch in {csv_path.name}.\n"
            f"  Missing: {missing or 'none'}\n"
            f"  Extra:   {extra or 'none'}\n"
            f"  Got first 5: {header[:5]} ({len(header)} cols)\n"
            f"  Want first 5: {expected[:5]} ({len(expected)} cols)"
        )


def validate_categoricals(df: pl.DataFrame) -> None:
    """Hard-fail if closed-enum columns contain unknown values."""
    for col, allowed in (
        ("side", VALID_SIDE),
        ("option_type", VALID_OPTION_TYPE),
        ("equity_type", VALID_EQUITY_TYPE),
    ):
        present = {v for v in df[col].unique().to_list() if v is not None}
        unknown = present - allowed
        if unknown:
            raise ValueError(
                f"Column '{col}' has unknown values: {sorted(unknown)}. "
                f"If UW added a category, update the enum in scripts/ingest-flow.py."
            )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("date", help="Trading date in YYYY-MM-DD format")
    p.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR)
    p.add_argument(
        "--archive-dir",
        type=Path,
        default=DEFAULT_ARCHIVE_DIR,
        help=(
            "Bot-EOD archive the full {date}-trades.parquet goes to (created "
            f"if missing). Default: {DEFAULT_ARCHIVE_DIR}"
        ),
    )
    p.add_argument("--keep-csv", action="store_true", help="Don't delete source CSV")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
        print(f"ERROR: date must be YYYY-MM-DD, got {args.date!r}", file=sys.stderr)
        return 2

    csv_path = expected_csv_path(args.date, args.input_dir)
    if not csv_path.is_file():
        print(f"ERROR: CSV not found: {csv_path}", file=sys.stderr)
        return 2

    print(f"→ Validating header: {csv_path.name}")
    validate_header(csv_path)

    print("→ Counting raw rows (streaming)")
    lf = pl.scan_csv(csv_path, schema=FLOW_SCHEMA, infer_schema_length=0)
    raw_count = lf.select(pl.len()).collect(engine="streaming").item()
    print(f"  raw rows: {raw_count:,}")

    if raw_count == 0:
        print("ERROR: empty CSV", file=sys.stderr)
        return 2
    if raw_count < SANITY_FLOOR_ROWS:
        print(f"WARN: row count below sanity floor ({SANITY_FLOOR_ROWS:,}); continuing")

    archive_path = archive_parquet_path(args.date, args.archive_dir)
    if archive_path.exists():
        print(
            f"→ Archive already exists, skipping: {archive_path} "
            f"({archive_path.stat().st_size / 1024**2:.1f} MB)"
        )
    else:
        print(f"→ Writing full archive Parquet: {archive_path}")
        write_full_archive(lf, archive_path)
        print(
            f"  archive  {archive_path.stat().st_size / 1024**2:.1f} MB "
            f"({raw_count:,} rows, unfiltered)"
        )

    # The enum check and the summary below read the archive, which holds every
    # print. The check looks at the distinct (side, option_type, equity_type)
    # combinations only, so it never loads the 11M-row frame.
    archive = pl.scan_parquet(archive_path)
    print("→ Validating closed enums")
    validate_categoricals(
        archive.select("side", "option_type", "equity_type")
        .unique()
        .collect(engine="streaming")
    )

    if not args.keep_csv:
        print(f"→ Deleting source CSV: {csv_path}")
        csv_path.unlink()

    tops = (
        archive.group_by("underlying_symbol")
        .len()
        .sort("len", descending=True)
        .head(10)
        .collect(engine="streaming")
    )
    print("\nTop 10 underlyings:")
    for sym, n in tops.iter_rows():
        print(f"  {sym:<10} {n:>10,}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
